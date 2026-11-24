import { describe, test, expect } from 'bun:test'
import type { BgpPrefix } from '../../../src/lib/bgp/types'
import {
  compilePrefixQuery,
  contains,
  equals,
  formatPrefix,
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

describe('compilePrefixQuery', () => {
  // The general answer, which the prepared search must agree with exactly.
  const reference = (queryText: string, route: BgpPrefix): boolean => {
    const query = parsePrefix(queryText)!
    const parsed = parseBgpPrefix(route)
    if (!parsed) return false
    return query.hasMask ? contains(query, parsed) : contains(parsed, query)
  }

  // A small deterministic generator, so a failure reproduces.
  let seed = 42
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const octet = () => [0, 10, 127, 128, 192, 255][random(6)] + random(2)
  const address = () => `${octet()}.${octet()}.${random(3)}.${random(3)}`

  test('agrees with contains() for IPv4 queries with and without a mask', () => {
    const queries = ['10.0.0.0/8', '0.0.0.0/0', '192.168.1.0/24', '128.0.0.0/1', '10.1.2.3', '10.1.2.3/32', '255.255.255.255']
    for (let i = 0; i < 60; i++) queries.push(random(2) ? `${address()}/${random(33)}` : address())
    const routes: BgpPrefix[] = []
    for (let i = 0; i < 300; i++) routes.push({ prefix: address(), length: random(33) })
    for (const text of queries) {
      const matches = compilePrefixQuery(parsePrefix(text)!)
      for (const route of routes) {
        expect(`${text} ? ${route.prefix}/${route.length} = ${matches(route)}`).toBe(
          `${text} ? ${route.prefix}/${route.length} = ${reference(text, route)}`
        )
      }
    }
  })

  test('never matches what is not an IPv4 route', () => {
    const matches = compilePrefixQuery(parsePrefix('0.0.0.0/0')!)
    for (const prefix of ['2001:db8::', '(AFI 25)', '10.0.0', '10.0.0.0.0', '10.0.0.256', '1.2.3.4x', '', '1..2.3']) {
      expect(matches({ prefix, length: 8 })).toBe(reference('0.0.0.0/0', { prefix, length: 8 }))
    }
    expect(matches({ prefix: '10.0.0.0', length: 33 })).toBe(false)
  })

  test('takes the general path for IPv6 queries', () => {
    const matches = compilePrefixQuery(parsePrefix('2001:db8::/32')!)
    expect(matches({ prefix: '2001:db8:1::', length: 48 })).toBe(true)
    expect(matches({ prefix: '2001:db9::', length: 48 })).toBe(false)
    expect(matches({ prefix: '10.0.0.0', length: 8 })).toBe(false)
  })
})
