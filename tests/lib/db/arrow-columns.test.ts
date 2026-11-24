import { describe, test, expect } from 'bun:test'
import * as arrow from 'apache-arrow'
import {
  BoolColumn,
  DictionaryColumn,
  DictionaryKeys,
  Int32Column,
  NumberColumn,
  StringDictionaryColumn,
  TimestampColumn,
  TextColumn,
  TextListColumn,
  batchToIpc,
  tableBatch,
  type Column,
  type TableBatch,
} from '../../../src/lib/db/arrow-columns'

/**
 * The loader writes each value straight into the buffers of an Arrow batch,
 * so what DuckDB receives is only as right as these buffers. Each test writes
 * a batch, serialises it the way the loader does, reads it back with Arrow's
 * own reader, and compares row by row.
 */
function roundTrip(batch: TableBatch<Record<string, Column>>) {
  return arrow.tableFromIPC(batchToIpc(arrow, batch)).toArray().map((row) => row.toJSON())
}

function makeBatch() {
  return tableBatch('t', () => ({
    n: new NumberColumn(),
    b: new BoolColumn(),
    s: new TextColumn(),
    l: new TextListColumn(),
  }))
}

describe('arrow columns', () => {
  test('values come back as written, with NULL for whatever a row left out', () => {
    const batch = makeBatch()
    const c = batch.columns
    let row = batch.rows++
    c.n.set(row, 42)
    c.b.set(row, true)
    c.s.set(row, '10.0.0.0/8')
    c.l.set(row, ['one', 'two'])
    row = batch.rows++
    // Nothing written: every column is NULL here.
    row = batch.rows++
    c.n.set(row, 0)
    c.b.set(row, false)
    c.s.set(row, '')
    c.l.set(row, [])

    const rows = roundTrip(batch)
    expect(rows.map((r) => ({ ...r, l: r.l ? [...r.l] : r.l }))).toEqual([
      { n: 42, b: true, s: '10.0.0.0/8', l: ['one', 'two'] },
      { n: null, b: null, s: null, l: null },
      { n: 0, b: false, s: '', l: [] },
    ])
  })

  test('non-finite numbers are NULL, as the loader has always written them', () => {
    const batch = makeBatch()
    for (const value of [NaN, Infinity, -Infinity, 7]) batch.columns.n.set(batch.rows++, value)
    expect(roundTrip(batch).map((r) => r.n)).toEqual([null, null, null, 7])
  })

  test('text that is not ASCII is encoded as UTF-8', () => {
    const batch = makeBatch()
    for (const value of ['plain', 'キープアライブ', 'naïve', 'a😀b']) batch.columns.s.set(batch.rows++, value)
    expect(roundTrip(batch).map((r) => r.s)).toEqual(['plain', 'キープアライブ', 'naïve', 'a😀b'])
  })

  test('columns grow past their first allocation', () => {
    const batch = makeBatch()
    const count = 5000
    for (let i = 0; i < count; i++) {
      const row = batch.rows++
      batch.columns.n.set(row, i)
      batch.columns.b.set(row, i % 3 === 0)
      if (i % 7 !== 0) batch.columns.s.set(row, `prefix-${i}`)
      batch.columns.l.set(row, i % 5 === 0 ? [`w${i}`] : [])
    }
    const rows = roundTrip(batch)
    expect(rows.length).toBe(count)
    for (const i of [0, 1, 6, 7, 1023, 1024, 4095, 4999]) {
      expect(rows[i].n).toBe(i)
      expect(rows[i].b).toBe(i % 3 === 0)
      expect(rows[i].s).toBe(i % 7 !== 0 ? `prefix-${i}` : null)
      expect([...rows[i].l]).toEqual(i % 5 === 0 ? [`w${i}`] : [])
    }
  })

  test('a reset batch starts empty and leaves the sent buffers alone', () => {
    const batch = makeBatch()
    batch.columns.s.set(batch.rows++, 'first')
    const sent = batchToIpc(arrow, batch)
    batch.reset()
    expect(batch.rows).toBe(0)
    batch.columns.s.set(batch.rows++, 'second')
    expect(arrow.tableFromIPC(sent).toArray().map((r) => r.toJSON().s)).toEqual(['first'])
    expect(roundTrip(batch).map((r) => r.s)).toEqual(['second'])
  })

  test('Int32 columns refuse a value that would wrap', () => {
    const column = new Int32Column()
    column.set(0, 2_147_483_647)
    column.set(1, -5)
    column.set(2, null)
    expect(() => column.set(3, 4_294_967_295)).toThrow(RangeError)
    expect(() => column.set(3, 1.5)).toThrow(RangeError)
    const batch = tableBatch('t', () => ({ i: column }))
    batch.rows = 3
    expect(roundTrip(batch).map((r) => r.i)).toEqual([2_147_483_647, -5, null])
  })

  test('timestamps keep the millisecond, past 2038 and before 1970 alike', () => {
    const times = [Date.UTC(2026, 0, 1, 0, 0, 0, 123), Date.UTC(2100, 5, 1), Date.UTC(1969, 11, 31, 23, 59, 59, 999), 0]
    const batch = tableBatch('t', () => ({ ts: new TimestampColumn() }))
    for (const ms of times) batch.columns.ts.set(batch.rows++, ms)
    batch.columns.ts.set(batch.rows++, Number.NaN)
    const read = arrow.tableFromIPC(batchToIpc(arrow, batch)).getChild('ts')!.toArray()
    expect(Array.from(read, (v) => (v === null ? null : Number(v)))).toEqual([...times, 0])
    expect(roundTrip(batch).map((r) => r.ts)[4]).toBeNull()
  })

  test('dictionary columns read back as the text each row was given', () => {
    const batch = tableBatch('t', () => ({ s: new StringDictionaryColumn() }))
    const values = ['10.0.0.1', '10.0.0.2', '10.0.0.1', null, 'é', '10.0.0.2']
    for (const value of values) batch.columns.s.set(batch.rows++, value)
    expect(roundTrip(batch).map((r) => r.s)).toEqual(values)
  })

  test('columns sharing keys work their values out once per key, and keep a NULL value NULL', () => {
    type Route = { prefix: string; bits: string | null }
    const a: Route = { prefix: '10.0.0.0', bits: '4:00001010' }
    const evpn: Route = { prefix: '[2] 00:0c:29:aa:bb:cc', bits: null }
    let computed = 0
    const batch = tableBatch('t', () => {
      const keys = new DictionaryKeys<Route>()
      return { prefix: new DictionaryColumn(keys), bits: new DictionaryColumn(keys) }
    })
    for (const route of [a, evpn, a, a, evpn]) {
      const c = batch.columns
      const entry = c.prefix.keys.set(batch.rows++, route)
      if (entry >= 0) {
        computed++
        c.prefix.add(entry, route.prefix)
        c.bits.add(entry, route.bits)
      }
    }
    expect(computed).toBe(2)
    expect(roundTrip(batch)).toEqual([
      { prefix: a.prefix, bits: a.bits },
      { prefix: evpn.prefix, bits: null },
      { prefix: a.prefix, bits: a.bits },
      { prefix: a.prefix, bits: a.bits },
      { prefix: evpn.prefix, bits: null },
    ])
  })

  test('several dictionary columns in one batch keep their own values', () => {
    const batch = tableBatch('t', () => ({ x: new StringDictionaryColumn(), y: new StringDictionaryColumn() }))
    batch.columns.x.set(batch.rows, 'a')
    batch.columns.y.set(batch.rows++, 'b')
    batch.columns.x.set(batch.rows, 'c')
    batch.columns.y.set(batch.rows++, 'b')
    expect(roundTrip(batch)).toEqual([
      { x: 'a', y: 'b' },
      { x: 'c', y: 'b' },
    ])
  })
})
