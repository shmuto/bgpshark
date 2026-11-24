import { describe, test, expect } from 'bun:test'
import * as arrow from 'apache-arrow'
import {
  BoolColumn,
  NumberColumn,
  TextColumn,
  TextListColumn,
  batchToIpc,
  tableBatch,
} from '../../../src/lib/db/arrow-columns'

/**
 * The loader writes each value straight into the buffers of an Arrow batch,
 * so what DuckDB receives is only as right as these buffers. Each test writes
 * a batch, serialises it the way the loader does, reads it back with Arrow's
 * own reader, and compares row by row.
 */
function roundTrip(batch: ReturnType<typeof makeBatch>) {
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
})
