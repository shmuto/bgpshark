/**
 * Columns for the DuckDB load, written straight into the buffers an Arrow
 * record batch is made of.
 *
 * The loader used to flatten each chunk of packets into row objects — one per
 * row of every table, millions of them for a large capture — and then walk
 * those rows once per column to pull each value out again, type it, and copy
 * it into a typed array. On a 45MB capture that was six or seven seconds of the
 * main thread (`columnVector` and `utf8Data` alone were four), all of it spent
 * while the DuckDB worker sat waiting for the next batch. Writing each value
 * once, into the buffer it ends up in, removes the row objects and the
 * per-column passes over them.
 *
 * Every column has a fixed Arrow type here rather than one guessed from the
 * values in the batch. The batch lands in a staging table and reaches the real
 * one through `INSERT ... SELECT`, which casts each column to what the schema
 * declares (see `insertChunk` in the loader). So a number that may not fit 32
 * bits travels as Float64 — every value the parsers emit fits one exactly, and
 * an out-of-range one fails the cast loudly instead of wrapping — and one that
 * always fits travels as Int32, which refuses anything that does not rather
 * than wrapping it. A column that is NULL in every row of a batch casts the
 * same whatever its transport type.
 *
 * Text that repeats — addresses, type names, the prefixes of a table transfer
 * that come and go — is dictionary-encoded: each distinct value is written
 * once per batch and every row holds its index (`DictionaryKeys`). On a 94MB
 * capture of 22 million announced routes, writing every row's prefix and
 * prefix bit string out in full was more than half of the load: 7 seconds in
 * the text writer and 5 more working out bit strings for prefixes the decoder
 * hands over as the same object again and again. DuckDB reads a dictionary
 * column as the VARCHAR it stands for.
 *
 * Nothing here may use Arrow's builders (`vectorFromArray`, `makeBuilder`,
 * `tableFromArrays`, …): they compile code with `new Function`, which the
 * production CSP refuses. `makeData` over buffers we filled ourselves is plain
 * object construction.
 */

type Arrow = typeof import('apache-arrow')
type ArrowData = import('apache-arrow').Data

/**
 * `array` grown to hold at least `needed` elements, doubling. Only called once
 * a write has found the array full: the check itself is inlined at each write,
 * because a call per value — on every column of every row — was a noticeable
 * part of the load on its own.
 */
function grow<T extends Uint8Array | Int32Array | Float64Array>(array: T, needed: number): T {
  let size = Math.max(array.length * 2, 16)
  while (size < needed) size *= 2
  const next = new (array.constructor as new (length: number) => T)(size)
  next.set(array)
  return next
}

/** `array` itself if it holds `needed` elements, else a grown copy. */
function atLeast<T extends Uint8Array | Int32Array | Float64Array>(array: T, needed: number): T {
  return needed <= array.length ? array : grow(array, needed)
}

const INITIAL_ROWS = 1024

/**
 * Which rows hold a value: Arrow's validity bitmap, one bit per row. A row
 * that was never written is NULL, so a column a row forgets to fill reads as
 * NULL there — as an absent key on a row object used to — rather than taking
 * the next row's value.
 */
class Validity {
  private bitmap = new Uint8Array(INITIAL_ROWS >> 3)
  private present = 0

  set(row: number): void {
    const byte = row >> 3
    if (byte >= this.bitmap.length) this.bitmap = grow(this.bitmap, byte + 1)
    this.bitmap[byte] |= 1 << (row & 7)
    this.present++
  }

  clear(): void {
    this.bitmap.fill(0)
    this.present = 0
  }

  /** The bitmap for `length` rows, and how many of them are NULL. */
  take(length: number): { nullBitmap: Uint8Array; nullCount: number } {
    const bytes = (length + 7) >> 3
    return { nullBitmap: atLeast(this.bitmap, bytes).subarray(0, bytes), nullCount: length - this.present }
  }
}

/**
 * A number column. Non-finite values become NULL, as they always have in this
 * loader — first through `JSON.stringify`, then the literal writer, then the
 * row-based Arrow writer — so a change of transport does not start writing
 * `NaN` into an INTEGER column.
 */
export class NumberColumn {
  private data = new Float64Array(INITIAL_ROWS)
  private validity = new Validity()

  /** Every row NULL again. Values left in `data` sit under a cleared bit, which Arrow does not read. */
  clear(): void {
    this.validity.clear()
  }

  set(row: number, value: number | null | undefined): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    if (row >= this.data.length) this.data = grow(this.data, row + 1)
    this.data[row] = value
    this.validity.set(row)
  }

  toData(arrow: Arrow, length: number): ArrowData {
    return arrow.makeData({
      type: new arrow.Float64(),
      length,
      ...this.validity.take(length),
      data: atLeast(this.data, length).subarray(0, length),
    })
  }
}

/**
 * A column of values that always fit a signed 32-bit integer: ids, indexes,
 * lengths, ports, codes. Half the bytes of `NumberColumn` to build and send.
 * A value that does not fit is a bug in the caller's choice of column, so it
 * fails the load rather than wrapping into a wrong number.
 */
export class Int32Column {
  private data = new Int32Array(INITIAL_ROWS)
  private validity = new Validity()

  clear(): void {
    this.validity.clear()
  }

  set(row: number, value: number | null | undefined): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    if ((value | 0) !== value) throw new RangeError(`${value} does not fit a 32-bit integer column`)
    if (row >= this.data.length) this.data = grow(this.data, row + 1)
    this.data[row] = value
    this.validity.set(row)
  }

  toData(arrow: Arrow, length: number): ArrowData {
    return arrow.makeData({
      type: new arrow.Int32(),
      length,
      ...this.validity.take(length),
      data: atLeast(this.data, length).subarray(0, length),
    })
  }
}

/**
 * A point in time to the millisecond, which is what a parsed packet keeps
 * (`timestamp` is a `Date`), sent as Arrow's millisecond timestamp so DuckDB
 * reads it as a TIMESTAMP with no text in between. It used to be an ISO string
 * per packet, formatted here and parsed again in the worker.
 *
 * Arrow stores it as a 64-bit integer; it is written as two 32-bit halves so
 * that no BigInt is made per row.
 */
export class TimestampColumn {
  private halves = new Int32Array(INITIAL_ROWS * 2)
  private validity = new Validity()

  clear(): void {
    this.validity.clear()
  }

  set(row: number, ms: number | null | undefined): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return
    if (2 * row + 1 >= this.halves.length) this.halves = grow(this.halves, 2 * row + 2)
    const high = Math.floor(ms / 4294967296)
    this.halves[2 * row] = ms - high * 4294967296
    this.halves[2 * row + 1] = high
    this.validity.set(row)
  }

  toData(arrow: Arrow, length: number): ArrowData {
    const halves = atLeast(this.halves, 2 * length)
    return arrow.makeData({
      type: new arrow.TimestampMillisecond(),
      length,
      ...this.validity.take(length),
      data: new BigInt64Array(halves.buffer, halves.byteOffset, length),
    })
  }
}

export class BoolColumn {
  private bits = new Uint8Array(INITIAL_ROWS >> 3)
  private validity = new Validity()

  /** Unlike the number columns, the value bits are cleared too: `set` only ever turns one on. */
  clear(): void {
    this.bits.fill(0)
    this.validity.clear()
  }

  set(row: number, value: boolean | null | undefined): void {
    if (typeof value !== 'boolean') return
    const byte = row >> 3
    if (byte >= this.bits.length) this.bits = grow(this.bits, byte + 1)
    if (value) this.bits[byte] |= 1 << (row & 7)
    this.validity.set(row)
  }

  toData(arrow: Arrow, length: number): ArrowData {
    const bytes = (length + 7) >> 3
    return arrow.makeData({
      type: new arrow.Bool(),
      length,
      ...this.validity.take(length),
      data: atLeast(this.bits, bytes).subarray(0, bytes),
    })
  }
}

/**
 * Offsets for a variable-length column: entry `row + 1` is where that row's
 * values end. Rows must be written in order; a row skipped over is empty.
 */
class Offsets {
  private offsets = new Int32Array(INITIAL_ROWS + 1)
  private filled = 0

  /** Mark rows up to and including `row` as ending at `end`. */
  end(row: number, end: number): void {
    if (row + 2 > this.offsets.length) this.offsets = grow(this.offsets, row + 2)
    const offsets = this.offsets
    const previous = offsets[this.filled]
    for (let r = this.filled; r < row; r++) offsets[r + 1] = previous
    offsets[row + 1] = end
    this.filled = row + 1
  }

  take(length: number): Int32Array {
    if (this.filled < length) this.end(length - 1, this.offsets[this.filled])
    return this.offsets.subarray(0, length + 1)
  }

  /** No rows. The first offset is never written, so it is still 0. */
  clear(): void {
    this.filled = 0
  }
}

/**
 * A text column: every string back to back as UTF-8, with offsets marking
 * where each ends. Nearly all of it is ASCII — addresses, prefixes, names —
 * so bytes are written directly and only a string that needs it goes through
 * the encoder.
 */
export class TextColumn {
  private offsets = new Offsets()
  private bytes = new Uint8Array(INITIAL_ROWS * 16)
  private used = 0
  private validity = new Validity()
  private static encoder = new TextEncoder()

  clear(): void {
    this.offsets.clear()
    this.used = 0
    this.validity.clear()
  }

  set(row: number, value: string | null | undefined): void {
    if (typeof value !== 'string') return
    // UTF-8 never needs more than three bytes per UTF-16 unit.
    const needed = this.used + value.length * 3
    if (needed > this.bytes.length) this.bytes = grow(this.bytes, needed)
    const { bytes, used } = this
    let ascii = true
    for (let j = 0; j < value.length; j++) {
      const code = value.charCodeAt(j)
      if (code > 0x7f) {
        ascii = false
        break
      }
      bytes[used + j] = code
    }
    this.used += ascii ? value.length : TextColumn.encoder.encodeInto(value, bytes.subarray(used)).written
    this.offsets.end(row, this.used)
    this.validity.set(row)
  }

  toData(arrow: Arrow, length: number): import('apache-arrow').Data<import('apache-arrow').Utf8> {
    return arrow.makeData({
      type: new arrow.Utf8(),
      length,
      ...this.validity.take(length),
      valueOffsets: this.offsets.take(length),
      data: this.bytes.subarray(0, this.used),
    })
  }
}

/**
 * Which dictionary entry each row of a batch holds, for one or more
 * `DictionaryColumn`s that share it.
 *
 * Keyed by whatever the text is a function of: the string itself for a plain
 * repeated value, or an object — a decoded prefix — when several columns are
 * read off the same one. The decoder hands over one prefix object for every
 * repeat of a route (`shared-decode.ts`), so its text and bit string are
 * worked out once per batch rather than once per row, and both columns share
 * one lookup.
 */
export class DictionaryKeys<K> {
  private indices = new Int32Array(INITIAL_ROWS)
  private validity = new Validity()
  private entries = new Map<K, number>()

  /**
   * Point `row` at `key`'s entry. Returns the entry's index when the key is
   * new to this batch — the caller then adds its value to each column, in
   * this order — and -1 when it is already there.
   */
  set(row: number, key: K): number {
    let entry = this.entries.get(key)
    let added = -1
    if (entry === undefined) {
      entry = this.entries.size
      this.entries.set(key, entry)
      added = entry
    }
    if (row >= this.indices.length) this.indices = grow(this.indices, row + 1)
    this.indices[row] = entry
    this.validity.set(row)
    return added
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.validity.clear()
  }

  take(length: number): { nullBitmap: Uint8Array; nullCount: number; data: Int32Array } {
    return { ...this.validity.take(length), data: atLeast(this.indices, length).subarray(0, length) }
  }
}

/** Unique within a batch's schema, as Arrow requires of dictionary ids. */
let nextDictionaryId = 0

/**
 * A dictionary-encoded text column: its distinct values, and per row an index
 * into them (`keys`, which other columns may share). A value may be NULL, in
 * which case every row pointing at it is.
 */
export class DictionaryColumn<K = string> {
  readonly keys: DictionaryKeys<K>
  private values = new TextColumn()
  private readonly id = nextDictionaryId++

  constructor(keys: DictionaryKeys<K> = new DictionaryKeys<K>()) {
    this.keys = keys
  }

  /** Clears the shared keys too, which may be cleared more than once: that is harmless. */
  clear(): void {
    this.keys.clear()
    this.values.clear()
  }

  /** The value of dictionary entry `entry`, as returned by `keys.set`. */
  add(entry: number, value: string | null | undefined): void {
    this.values.set(entry, value)
  }

  toData(arrow: Arrow, length: number): ArrowData {
    const dictionary = arrow.makeVector(this.values.toData(arrow, this.keys.size))
    return arrow.makeData({
      type: new arrow.Dictionary(new arrow.Utf8(), new arrow.Int32(), this.id, false),
      length,
      ...this.keys.take(length),
      dictionary,
    })
  }
}

/**
 * A dictionary column keyed by its own text, for values that repeat from row
 * to row: an address, a message type, an attribute name.
 */
export class StringDictionaryColumn extends DictionaryColumn<string> {
  set(row: number, value: string | null | undefined): void {
    if (typeof value !== 'string') return
    const entry = this.keys.set(row, value)
    if (entry >= 0) this.add(entry, value)
  }
}

/**
 * A list-of-text column — only `parse_warnings` — as one text column of every
 * item back to back, and offsets saying which rows they belong to.
 */
export class TextListColumn {
  private offsets = new Offsets()
  private items = new TextColumn()
  private itemCount = 0
  private validity = new Validity()

  clear(): void {
    this.offsets.clear()
    this.items.clear()
    this.itemCount = 0
    this.validity.clear()
  }

  set(row: number, values: readonly string[] | null | undefined): void {
    if (!Array.isArray(values)) return
    for (const value of values) this.items.set(this.itemCount++, value)
    this.offsets.end(row, this.itemCount)
    this.validity.set(row)
  }

  toData(arrow: Arrow, length: number): ArrowData {
    const child = new arrow.Field('item', new arrow.Utf8(), true)
    return arrow.makeData({
      type: new arrow.List(child),
      length,
      ...this.validity.take(length),
      valueOffsets: this.offsets.take(length),
      child: this.items.toData(arrow, this.itemCount),
    })
  }
}

export type Column =
  | NumberColumn
  | Int32Column
  | TimestampColumn
  | BoolColumn
  | TextColumn
  | DictionaryColumn<unknown>
  | TextListColumn

/**
 * One table's columns for the batch being built. `columns` is in the order the
 * staging table is created in, but the rows reach the real table by name, so
 * the order carries no meaning beyond that.
 */
export interface TableBatch<C extends Record<string, Column>> {
  name: string
  columns: C
  /** Rows in the batch so far; also the index the next row is written at. */
  rows: number
}

export function tableBatch<C extends Record<string, Column>>(name: string, columns: () => C): TableBatch<C> & { reset(): void } {
  const batch = {
    name,
    columns: columns(),
    rows: 0,
    /**
     * Empty the batch for the next chunk, keeping its buffers.
     *
     * Each chunk used to get fresh buffers, on the reasoning that the last
     * chunk's might still be on their way to the worker. They are not:
     * `batchToIpc` writes them into one new buffer (Arrow's IPC writer joins
     * the schema, metadata and bodies with a copy — `joinUint8Arrays` in
     * `apache-arrow/util/buffer`), and that copy is what is sent. Fresh
     * buffers meant every chunk regrew each of its columns by doubling, from
     * 1,024 rows up to as many as the chunk held, leaving every smaller copy
     * behind as garbage.
     */
    reset() {
      for (const column of Object.values(batch.columns)) column.clear()
      batch.rows = 0
    },
  }
  return batch
}

/** The batch as an Arrow IPC stream, ready for `insertArrowFromIPCStream`. */
export function batchToIpc(arrow: Arrow, batch: TableBatch<Record<string, Column>>): Uint8Array {
  const vectors: Record<string, import('apache-arrow').Vector> = {}
  for (const [name, column] of Object.entries(batch.columns)) {
    vectors[name] = arrow.makeVector(column.toData(arrow, batch.rows))
  }
  return arrow.tableToIPC(new arrow.Table(vectors), 'stream')
}
