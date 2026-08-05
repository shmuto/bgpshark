import { describe, expect, test } from 'bun:test'
import { formatDelta, formatTimeOfDayUtc } from '../../src/lib/format-time'

describe('formatTimeOfDayUtc', () => {
  test('is millisecond UTC time of day', () => {
    expect(formatTimeOfDayUtc(new Date('2025-12-27T10:36:42.019Z'))).toBe('10:36:42.019')
  })

  test('does not follow the machine timezone', () => {
    // Captures are read next to router logs, which are kept in UTC.
    expect(formatTimeOfDayUtc(new Date(Date.UTC(2025, 0, 1, 0, 0, 0, 5)))).toBe('00:00:00.005')
  })
})

describe('formatDelta', () => {
  test('keeps milliseconds for gaps inside a second', () => {
    // A session reset exchanges its whole burst inside one second.
    expect(formatDelta(12)).toBe('+0.012s')
    expect(formatDelta(999)).toBe('+0.999s')
  })

  test('drops to tenths for seconds', () => {
    expect(formatDelta(2000)).toBe('+2.0s')
    expect(formatDelta(59_400)).toBe('+59.4s')
  })

  test('reads as minutes and seconds for longer gaps', () => {
    expect(formatDelta(100_000)).toBe('+1m40s')
    expect(formatDelta(65_000)).toBe('+1m05s')
  })

  test('reads as hours for very long gaps', () => {
    expect(formatDelta(3_900_000)).toBe('+1h05m')
  })

  test('a gap backwards is signed', () => {
    expect(formatDelta(-2000)).toBe('-2.0s')
  })

  test('no gap at all', () => {
    expect(formatDelta(0)).toBe('+0.000s')
  })
})
