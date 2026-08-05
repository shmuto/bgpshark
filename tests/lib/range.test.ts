import { describe, expect, test } from 'bun:test'
import { minMax } from '../../src/lib/range'

describe('minMax', () => {
  test('finds both ends of a list', () => {
    expect(minMax([3, 1, 4, 1, 5, 9, 2, 6])).toEqual({ min: 1, max: 9 })
  })

  test('a single value is both ends', () => {
    expect(minMax([42])).toEqual({ min: 42, max: 42 })
  })

  test('nothing has no ends', () => {
    expect(minMax([])).toBeNull()
  })

  test('handles negatives and zero', () => {
    expect(minMax([0, -5, 5, -10])).toEqual({ min: -10, max: 5 })
  })

  test('survives more values than a spread call could take', () => {
    // The point of this module. `Math.min(...values)` passes one argument per
    // element and blows the stack somewhere past a hundred thousand of them —
    // in V8 far below this count — which is reachable from a capture within
    // the app's size limit. If this test starts failing with a RangeError,
    // someone has put the spread back.
    const values = new Array(800_000).fill(7)
    values[500_000] = -1
    values[700_000] = 99

    expect(minMax(values)).toEqual({ min: -1, max: 99 })
  })
})
