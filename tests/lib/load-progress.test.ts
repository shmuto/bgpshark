import { describe, expect, test } from 'bun:test'
import { databaseProgress, loadProgress, type LoadStage } from '../../src/lib/load-progress'

const STAGES: LoadStage[] = ['reading', 'parsing', 'decoding']

describe('loadProgress', () => {
  test('never runs backwards from one stage to the next', () => {
    // The bar stepping back as a stage begins is the failure a gauge cannot
    // afford: it reads as the load starting over.
    const sequence = STAGES.map((stage) => loadProgress(stage).fraction)
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i]).toBeGreaterThan(sequence[i - 1])
    }
    expect(sequence[0]).toBe(0)
    expect(sequence[sequence.length - 1]).toBeLessThan(1)
  })

  test('says what it is doing', () => {
    expect(loadProgress('parsing').label).toBe('Parsing packets')
    expect(loadProgress('decoding').label).toBe('Decoding BGP messages')
  })
})

describe('databaseProgress', () => {
  test('moves in proportion to rows inserted', () => {
    const start = databaseProgress(0, 1000).fraction
    const half = databaseProgress(500, 1000).fraction
    const end = databaseProgress(1000, 1000).fraction
    expect(start).toBe(0)
    expect(half).toBeCloseTo(0.5)
    expect(end).toBe(1)
  })

  test('stays inside the bar when the count overshoots', () => {
    expect(databaseProgress(2000, 1000).fraction).toBe(1)
  })

  test('says it is preparing until there are rows to count, then counts them', () => {
    expect(databaseProgress(0, 0).label).toBe('Loading into DuckDB — preparing rows')
    expect(databaseProgress(420000, 1600000).label).toBe(
      'Loading into DuckDB — 420,000 of 1,600,000 rows'
    )
  })
})
