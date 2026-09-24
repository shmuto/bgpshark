import { describe, expect, test } from 'bun:test'
import { loadProgress, type LoadStage } from '../../src/lib/load-progress'

const STAGES: LoadStage[] = ['reading', 'parsing', 'decoding', 'database', 'saving']

describe('loadProgress', () => {
  test('never runs backwards from one stage to the next', () => {
    // Every stage's start, then the database's end, in the order a load visits
    // them. The bar stepping back as a stage begins is the failure a gauge
    // cannot afford: it reads as the load starting over.
    const sequence = [
      ...STAGES.slice(0, 3).map((stage) => loadProgress(stage).fraction),
      loadProgress('database', 0, 100).fraction,
      loadProgress('database', 100, 100).fraction,
      loadProgress('saving').fraction,
    ]
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i]).toBeGreaterThanOrEqual(sequence[i - 1])
    }
    expect(sequence[0]).toBe(0)
    expect(sequence[sequence.length - 1]).toBeLessThanOrEqual(1)
  })

  test('moves through the database stage in proportion to rows inserted', () => {
    const start = loadProgress('database', 0, 1000).fraction
    const half = loadProgress('database', 500, 1000).fraction
    const end = loadProgress('database', 1000, 1000).fraction
    expect(half - start).toBeCloseTo(end - half)
    expect(end).toBeGreaterThan(start)
  })

  test('the database stage is most of the bar, because it is most of the wait', () => {
    const span = loadProgress('database', 1, 1).fraction - loadProgress('database').fraction
    expect(span).toBeGreaterThan(0.75)
  })

  test('stays inside its stage when the count overshoots or is empty', () => {
    expect(loadProgress('database', 2000, 1000).fraction).toBe(loadProgress('database', 1, 1).fraction)
    expect(loadProgress('database', 0, 0).fraction).toBe(loadProgress('database').fraction)
  })

  test('says what it is doing, with the row count once there is one', () => {
    expect(loadProgress('parsing').label).toBe('Parsing packets')
    expect(loadProgress('database').label).toBe('Loading into DuckDB — preparing rows')
    expect(loadProgress('database', 420000, 1600000).label).toBe(
      'Loading into DuckDB — 420,000 of 1,600,000 rows'
    )
  })
})
