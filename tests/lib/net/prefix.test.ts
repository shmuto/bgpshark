import { describe, test, expect } from 'bun:test'
import {
  contains,
  equals,
  formatPrefix,
  overlaps,
  parseBgpPrefix,
  parsePrefix,
} from '../../../src/lib/net/prefix'

/** Shorthand: parse or fail loudly, so the assertions stay readable. */
function p(text: string) {
  const parsed = parsePrefix(text)
  if (!parsed) throw new Error(`expected ${text} to parse`)
  return parsed
}

describe('formatPrefix', () => {
  test('always carries the mask length', () => {
    expect(formatPrefix({ prefix: '10.0.12.0', length: 24 })).toBe('10.0.12.0/24')
    expect(formatPrefix({ prefix: '10.0.12.0', length: 23 })).toBe('10.0.12.0/23')
  })
})

describe('parsePrefix', () => {
  test('reads IPv4 with and without a mask', () => {
    expect(p('10.0.0.0/8').length).toBe(8)
    expect(p('10.0.0.0/8').hasMask).toBe(true)
    expect(p('10.0.13.1').length).toBe(32)
    expect(p('10.0.13.1').hasMask).toBe(false)
  })

  test('clears host bits so the network address is what compares', () => {
    expect(equals(p('10.0.0.5/8'), p('10.0.0.0/8'))).toBe(true)
  })

  test('reads IPv6 in both compressed and expanded form', () => {
    // The parser emits the expanded form; users type the compressed one.
    expect(equals(p('2001:db8::/32'), p('2001:db8:0:0:0:0:0:0/32'))).toBe(true)
  })

  test('rejects what is not an address', () => {
    expect(parsePrefix('AS65001')).toBeNull()
    expect(parsePrefix('10.0.0')).toBeNull()
    expect(parsePrefix('10.0.0.256')).toBeNull()
    expect(parsePrefix('10.0.0.0/33')).toBeNull()
    expect(parsePrefix('10.0.0.0/8/8')).toBeNull()
    expect(parsePrefix('1::2::3')).toBeNull()
  })
})

describe('equals', () => {
  test('the mask length is part of the identity', () => {
    expect(equals(p('10.0.12.0/24'), p('10.0.12.0/23'))).toBe(false)
  })

  test('address families never match each other', () => {
    expect(equals(p('0.0.0.0/0'), p('::/0'))).toBe(false)
  })
})

describe('contains', () => {
  test('a covering prefix contains the more specific one', () => {
    expect(contains(p('10.0.0.0/8'), p('10.0.12.0/24'))).toBe(true)
    expect(contains(p('10.0.12.0/24'), p('10.0.0.0/8'))).toBe(false)
  })

  test('a prefix contains itself', () => {
    expect(contains(p('10.0.12.0/24'), p('10.0.12.0/24'))).toBe(true)
  })

  test('neighbouring prefixes do not contain each other', () => {
    expect(contains(p('10.0.12.0/24'), p('10.0.13.0/24'))).toBe(false)
  })

  test('finds which announcement covers an address', () => {
    expect(contains(p('10.0.12.0/24'), p('10.0.12.7'))).toBe(true)
    expect(contains(p('10.0.13.0/24'), p('10.0.12.7'))).toBe(false)
  })

  test('works on IPv6', () => {
    expect(contains(p('2001:db8::/32'), p('2001:db8:1::/48'))).toBe(true)
    expect(contains(p('2001:db8::/32'), p('2001:db9::/48'))).toBe(false)
  })

  test('does not mix address families', () => {
    expect(contains(p('::/0'), p('10.0.0.0/8'))).toBe(false)
  })
})

describe('overlaps', () => {
  test('holds whichever prefix is the more specific one', () => {
    expect(overlaps(p('10.30.0.0/24'), p('10.30.0.0/16'))).toBe(true)
    expect(overlaps(p('10.30.0.0/16'), p('10.30.0.0/24'))).toBe(true)
  })

  test('disjoint blocks of the same size never overlap', () => {
    expect(overlaps(p('10.30.0.0/16'), p('10.31.0.0/16'))).toBe(false)
  })

  test('a bare address and its /32 ask the same question', () => {
    expect(overlaps(p('10.0.12.7'), p('10.0.12.0/24'))).toBe(true)
    expect(overlaps(p('10.0.12.7/32'), p('10.0.12.0/24'))).toBe(true)
  })

  test('does not mix address families', () => {
    expect(overlaps(p('::/0'), p('10.0.0.0/8'))).toBe(false)
  })
})

describe('parseBgpPrefix', () => {
  test('takes the length from the parsed route, not from the address', () => {
    const parsed = parseBgpPrefix({ prefix: '10.0.12.0', length: 24 })
    expect(parsed).not.toBeNull()
    expect(equals(parsed!, p('10.0.12.0/24'))).toBe(true)
    expect(equals(parsed!, p('10.0.12.0/23'))).toBe(false)
  })

  test('returns null for families the parser cannot render as an address', () => {
    expect(parseBgpPrefix({ prefix: '(AFI 25)', length: 24 })).toBeNull()
  })
})
