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
 * values in the batch. The guess was only ever a means to an end: the batch
 * lands in a staging table and reaches the real one through
 * `INSERT ... SELECT`, which casts each column to what the schema declares (see
 * `insertChunk` in the loader). So numbers travel as Float64 — every value the
 * parsers emit fits one exactly, and an out-of-range one fails the cast loudly
 * instead of wrapping in a narrower typed array — and a column that is NULL in
 * every row of a batch is a Float64 of NULLs rather than a Utf8 of them, which
 * casts the same way.
 *
 * Nothing here may use Arrow's builders (`vectorFromArray`, `makeBuilder`,
 * `tableFromArrays`, …): they compile code with `new Function`, which the
 * production CSP refuses. `makeData` over buffers we filled ourselves is plain
 * object construction.
 */

type Arrow = typeof import('apache-arrow')
type ArrowData = import('apache-arrow').Data

/** Grow `array` to hold at least `needed` elements, doubling. */
function grown<T extends Uint8Array | Int32Array | Float64Array>(array: T, needed: number): T {
  if (needed <= array.length) return array
  let size = array.length * 2
  while (size < needed) size *= 2
  const next = new (array.constructor as new (length: number) => T)(size)
  next.set(array)
  return next
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
    this.bitmap = grown(this.bitmap, (row >> 3) + 1)
    this.bitmap[row >> 3] |= 1 << (row & 7)
    this.present++
  }

  /** The bitmap for `length` rows, and how many of them are NULL. */
  take(length: number): { nullBitmap: Uint8Array; nullCount: number } {
    const bytes = (length + 7) >> 3
    return { nullBitmap: grown(this.bitmap, bytes).subarray(0, bytes), nullCount: length - this.present }
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

  set(row: number, value: number | null | undefined): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    this.data = grown(this.data, row + 1)
    this.data[row] = value
    this.validity.set(row)
  }

  toData(arrow: Arrow, length: number): ArrowData {
    return arrow.makeData({
      type: new arrow.Float64(),
      length,
      ...this.validity.take(length),
      data: grown(this.data, length).subarray(0, length),
    })
  }
}

export class BoolColumn {
  private bits = new Uint8Array(INITIAL_ROWS >> 3)
  private validity = new Validity()

  set(row: number, value: boolean | null | undefined): void {
    if (typeof value !== 'boolean') return
    this.bits = grown(this.bits, (row >> 3) + 1)
    if (value) this.bits[row >> 3] |= 1 << (row & 7)
    this.validity.set(row)
  }

  toData(arrow: Arrow, length: number): ArrowData {
    const bytes = (length + 7) >> 3
    return arrow.makeData({
      type: new arrow.Bool(),
      length,
      ...this.validity.take(length),
      data: grown(this.bits, bytes).subarray(0, bytes),
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
    this.offsets = grown(this.offsets, row + 2)
    const previous = this.offsets[this.filled]
    for (let r = this.filled; r < row; r++) this.offsets[r + 1] = previous
    this.offsets[row + 1] = end
    this.filled = row + 1
  }

  take(length: number): Int32Array {
    if (this.filled < length) this.end(length - 1, this.offsets[this.filled])
    return this.offsets.subarray(0, length + 1)
  }
}

/**
 * A text column: every string back to back as UTF-8, with offsets marking
 * where each ends. Nearly all of it is ASCII — addresses, prefixes, names,
 * base64 — so bytes are written directly and only a string that needs it goes
 * through the encoder.
 */
export class TextColumn {
  private offsets = new Offsets()
  private bytes = new Uint8Array(INITIAL_ROWS * 16)
  private used = 0
  private validity = new Validity()
  private static encoder = new TextEncoder()

  set(row: number, value: string | null | undefined): void {
    if (typeof value !== 'string') return
    // UTF-8 never needs more than three bytes per UTF-16 unit.
    this.bytes = grown(this.bytes, this.used + value.length * 3)
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
 * A list-of-text column — only `parse_warnings` — as one text column of every
 * item back to back, and offsets saying which rows they belong to.
 */
export class TextListColumn {
  private offsets = new Offsets()
  private items = new TextColumn()
  private itemCount = 0
  private validity = new Validity()

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

export type Column = NumberColumn | BoolColumn | TextColumn | TextListColumn

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
    // Fresh buffers rather than cleared ones: the previous batch's buffers may
    // still be on their way to the worker inside its IPC message.
    reset() {
      batch.columns = columns()
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
