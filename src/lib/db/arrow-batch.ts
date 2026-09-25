/**
 * Rows as Arrow IPC, the form DuckDB WASM reads without a parser.
 *
 * Runs in the load worker alongside `rows.ts`. The buffers are laid out by
 * hand rather than through Arrow's builders — see `columnVector` for why that
 * is a hard rule and not a preference.
 */
import * as arrow from 'apache-arrow'

/**
 * How many rows go into one Arrow batch.
 *
 * Small enough that one batch never holds DuckDB's worker for long, so a
 * cancelled load stops promptly; large enough that the per-batch round trips
 * — create staging table, insert, drop — are not most of the time. Also a
 * memory bound: a batch is copied twice, into Arrow vectors and then into the
 * IPC buffer, which matters for the `packets` table, where every row carries
 * its frame as base64.
 */
export const ROWS_PER_BATCH = 10_000

/**
 * One column of a batch as an Arrow vector, typed from the values it holds.
 *
 * The type is deliberately loose, and deliberately not the table's declared
 * type: the rows land in a staging table first and reach the real one through
 * `INSERT ... SELECT`, so DuckDB casts each column to what the schema says,
 * exactly as it cast the literals of the `VALUES` statements this replaced.
 * That is why numbers travel as Float64 rather than Int32 — every value the
 * parsers emit fits one exactly, and an out-of-range one (a 4-byte ASN in an
 * INTEGER column) fails the cast loudly instead of wrapping silently in a
 * typed array. A column that is NULL in every row carries no evidence either
 * way, and goes as Utf8, which casts from NULL to anything.
 *
 * The buffers are laid out by hand rather than through `vectorFromArray`, for
 * two reasons. Arrow's builders compile their null checks with `new Function`,
 * which the production CSP (`script-src 'self' 'wasm-unsafe-eval'`) refuses —
 * and, as with the extension fetch described in `loader.ts`, the dev server
 * has no CSP to say so. And they are slow: several times what DuckDB then
 * spends reading the result. Nothing in this file may call a builder
 * (`vectorFromArray`, `tableFromArrays`, `tableFromJSON`, `makeBuilder`).
 *
 * Non-finite numbers become NULL because that is what the loader has always
 * done with them — first through `JSON.stringify`, then through the literal
 * writer — and a change of transport should not quietly start writing `NaN`
 * into an INTEGER column.
 */
function columnVector(rows: Record<string, unknown>[], column: string): import('apache-arrow').Vector {
  const length = rows.length
  const values = rows.map((row) => row[column] ?? null)
  const sample = values.find((value) => value !== null)
  const { nullBitmap, nullCount } = validity(values, (value) => value !== null)

  if (typeof sample === 'number') {
    const data = new Float64Array(length)
    const finite = validity(values, (value) => typeof value === 'number' && Number.isFinite(value))
    for (let i = 0; i < length; i++) if (typeof values[i] === 'number') data[i] = values[i] as number
    return arrow.makeVector(arrow.makeData({ type: new arrow.Float64(), length, ...finite, data }))
  }

  if (typeof sample === 'boolean') {
    const data = new Uint8Array((length + 7) >> 3)
    for (let i = 0; i < length; i++) if (values[i] === true) data[i >> 3] |= 1 << (i & 7)
    return arrow.makeVector(arrow.makeData({ type: new arrow.Bool(), length, nullBitmap, nullCount, data }))
  }

  // The only list column is `parse_warnings`, which is text: the child is one
  // Utf8 column of every warning back to back, and the offsets say which rows
  // they belong to.
  if (Array.isArray(sample)) {
    const valueOffsets = new Int32Array(length + 1)
    const items: string[] = []
    for (let i = 0; i < length; i++) {
      const list = values[i] as string[] | null
      if (list) items.push(...list)
      valueOffsets[i + 1] = items.length
    }
    const child = new arrow.Field('item', new arrow.Utf8(), true)
    return arrow.makeVector(
      arrow.makeData({
        type: new arrow.List(child),
        length,
        nullBitmap,
        nullCount,
        valueOffsets,
        child: utf8Data(items),
      })
    )
  }

  return arrow.makeVector(utf8Data(values))
}

/** Which of `values` are present, as the bitmap Arrow keeps beside a column. */
function validity(
  values: unknown[],
  isPresent: (value: unknown) => boolean
): { nullBitmap: Uint8Array; nullCount: number } {
  const nullBitmap = new Uint8Array((values.length + 7) >> 3)
  let nullCount = 0
  for (let i = 0; i < values.length; i++) {
    if (isPresent(values[i])) nullBitmap[i >> 3] |= 1 << (i & 7)
    else nullCount++
  }
  return { nullBitmap, nullCount }
}

/**
 * A Utf8 column: every string back to back, with offsets marking where each
 * ends. Nearly all of it is ASCII — addresses, prefixes, names, base64 — so
 * bytes are written directly and only a string that needs it goes through the
 * encoder.
 */
function utf8Data(values: unknown[]): import('apache-arrow').Data<import('apache-arrow').Utf8> {
  const length = values.length
  const { nullBitmap, nullCount } = validity(values, (value) => value !== null)
  const valueOffsets = new Int32Array(length + 1)
  let bytes = new Uint8Array(Math.max(1024, length * 16))
  let used = 0
  const encoder = new TextEncoder()
  for (let i = 0; i < length; i++) {
    if (values[i] !== null) {
      const text = String(values[i])
      // UTF-8 never needs more than three bytes per UTF-16 unit.
      if (used + text.length * 3 > bytes.length) {
        const grown = new Uint8Array(Math.max(bytes.length * 2, used + text.length * 3))
        grown.set(bytes.subarray(0, used))
        bytes = grown
      }
      let ascii = true
      for (let j = 0; j < text.length; j++) {
        const code = text.charCodeAt(j)
        if (code > 0x7f) {
          ascii = false
          break
        }
        bytes[used + j] = code
      }
      used += ascii ? text.length : encoder.encodeInto(text, bytes.subarray(used)).written
    }
    valueOffsets[i + 1] = used
  }
  return arrow.makeData({
    type: new arrow.Utf8(),
    length,
    nullBitmap,
    nullCount,
    valueOffsets,
    data: bytes.subarray(0, used),
  })
}

/**
 * One table's rows as IPC streams of at most `ROWS_PER_BATCH` rows each.
 *
 * Lazily, one batch per step, so the worker holds one encoded batch at a time
 * rather than a whole table's worth — the `packets` table alone is the capture
 * again, as base64.
 */
export function* encodeTable(
  table: object[]
): Generator<{ columns: string[]; ipc: Uint8Array; rows: number }> {
  if (table.length === 0) return
  const rows = table as Record<string, unknown>[]
  const columns = Object.keys(rows[0])
  for (let start = 0; start < rows.length; start += ROWS_PER_BATCH) {
    const batch = rows.slice(start, start + ROWS_PER_BATCH)
    const vectors: Record<string, arrow.Vector> = {}
    for (const column of columns) vectors[column] = columnVector(batch, column)
    yield { columns, ipc: arrow.tableToIPC(new arrow.Table(vectors), 'stream'), rows: batch.length }
  }
}
