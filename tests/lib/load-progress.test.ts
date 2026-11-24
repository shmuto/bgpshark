import { describe, expect, test } from 'bun:test'
import { loadProgress, type LoadStage } from '../../src/lib/load-progress'

const FOREGROUND: LoadStage[] = ['reading', 'parsing', 'decoding']

describe('loadProgress', () => {
  test('never runs backwards from one stage to the next', () => {
    // Every stage's start in the order a load visits them. The bar stepping
    // back as a stage begins is the failure a gauge cannot afford: it reads as
    // the load starting over.
    const sequence = FOREGROUND.map((stage) => loadProgress(stage).fraction)
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i]).toBeGreaterThanOrEqual(sequence[i - 1])
    }
    expect(sequence[0]).toBe(0)
    expect(sequence[sequence.length - 1]).toBeLessThanOrEqual(1)
  })

  test('moves through the database stage in proportion to packets inserted', () => {
    const start = loadProgress('database', 0, 1000).fraction
    const half = loadProgress('database', 500, 1000).fraction
    const end = loadProgress('database', 1000, 1000).fraction
    expect(half - start).toBeCloseTo(end - half)
    expect(end).toBeGreaterThan(start)
  })

  test('decoding is most of the load gauge, because it is most of that wait', () => {
    const span = 1 - loadProgress('decoding').fraction
    expect(span).toBeGreaterThan(0.75)
  })

  test('the database stage has a gauge of its own, from empty to full', () => {
    expect(loadProgress('database', 0, 10).fraction).toBe(0)
    expect(loadProgress('database', 10, 10).fraction).toBe(1)
  })

  test('stays inside its stage when the count overshoots or is empty', () => {
    expect(loadProgress('database', 2000, 1000).fraction).toBe(loadProgress('database', 1, 1).fraction)
    expect(loadProgress('database', 0, 0).fraction).toBe(loadProgress('database').fraction)
  })

  test('says what it is doing, with the packet count once there is one', () => {
    expect(loadProgress('parsing').label).toBe('Parsing packets')
    expect(loadProgress('database').label).toBe('Loading into DuckDB — preparing tables')
    expect(loadProgress('database', 42000, 160000).label).toBe(
      'Loading into DuckDB — 42,000 of 160,000 packets'
    )
  })
})
