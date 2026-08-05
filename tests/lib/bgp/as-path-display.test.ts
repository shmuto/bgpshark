import { describe, expect, test } from 'bun:test'
import { collapsePrepends, formatAsPath } from '../../../src/lib/bgp/as-path-display'

describe('collapsePrepends', () => {
  test('leaves a path with no repeats alone', () => {
    expect(collapsePrepends(['65001', '65002', '65003'])).toEqual([
      { asn: '65001', repeat: 1 },
      { asn: '65002', repeat: 1 },
      { asn: '65003', repeat: 1 },
    ])
  })

  test('collapses a run into one hop with its count', () => {
    expect(collapsePrepends(['65002', '65100', '65100', '65100'])).toEqual([
      { asn: '65002', repeat: 1 },
      { asn: '65100', repeat: 3 },
    ])
  })

  test('only collapses runs that are actually consecutive', () => {
    // 65001 appearing again after another AS is a loop or a re-entry, not
    // prepending, and flattening the two together would hide that.
    expect(collapsePrepends(['65001', '65002', '65001'])).toEqual([
      { asn: '65001', repeat: 1 },
      { asn: '65002', repeat: 1 },
      { asn: '65001', repeat: 1 },
    ])
  })

  test('handles an empty path', () => {
    expect(collapsePrepends([])).toEqual([])
  })
})

describe('formatAsPath', () => {
  test('writes a run with its count', () => {
    expect(formatAsPath('65002 65100 65100 65100')).toBe('65002 65100×3')
  })

  test('leaves an ordinary path as it was', () => {
    expect(formatAsPath('65001 65002')).toBe('65001 65002')
  })

  test('copes with extra whitespace', () => {
    expect(formatAsPath('  65001   65001  ')).toBe('65001×2')
  })

  test('an empty path reads as absent', () => {
    expect(formatAsPath('')).toBe('-')
  })
})
