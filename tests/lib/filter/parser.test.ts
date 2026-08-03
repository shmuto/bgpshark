import { describe, test, expect } from 'bun:test'
import {
  parseQuery,
  matchPacket,
  normalizeFieldName,
  FILTER_FIELDS,
} from '../../../src/lib/filter/parser'
import { expressionToSql } from '../../../src/lib/db/filter-to-sql'
import type {
  BgpPacket,
  BgpOpenMessage,
  BgpUpdateMessage,
} from '../../../src/lib/bgp/types'

/**
 * Minimal OPEN packet: AS 65001, Router ID 10.0.0.1
 */
function createOpenPacket(): BgpPacket {
  const open: BgpOpenMessage = {
    type: 'OPEN',
    version: 4,
    myAs: 65001,
    holdTime: 90,
    bgpIdentifier: '10.0.0.1',
    optParamLength: 0,
    capabilities: [],
  }
  return {
    frameIndex: 1,
    timestamp: new Date(0),
    srcIp: '10.0.0.1',
    dstIp: '10.0.0.2',
    srcPort: 179,
    dstPort: 50000,
    messages: [open],
    rawData: new Uint8Array(),
    parseWarnings: [],
  }
}

/**
 * Minimal UPDATE packet carrying AS_PATH 65001 65002
 */
function createUpdatePacket(): BgpPacket {
  const update: BgpUpdateMessage = {
    type: 'UPDATE',
    withdrawnRoutesLength: 0,
    withdrawnRoutes: [],
    totalPathAttributeLength: 0,
    pathAttributes: [
      {
        flags: { optional: false, transitive: true, partial: false, extended: false },
        typeCode: 2,
        typeName: 'AS_PATH',
        length: 0,
        value: new Uint8Array(),
        parsed: {
          type: 'AS_PATH',
          segments: [{ type: 'AS_SEQUENCE', typeName: 'AS_SEQUENCE', asNumbers: [65001, 65002] }],
        },
      },
    ],
    nlri: [],
  } as unknown as BgpUpdateMessage

  return {
    frameIndex: 2,
    timestamp: new Date(0),
    srcIp: '10.0.0.1',
    dstIp: '10.0.0.2',
    srcPort: 179,
    dstPort: 50000,
    messages: [update],
    rawData: new Uint8Array(),
    parseWarnings: [],
  }
}

describe('filter field definitions', () => {
  test('every alias resolves to a defined field', () => {
    for (const alias of ['src', 'dst', 'as', 'aspath', 'nexthop', 'nlri', 'my_as']) {
      const canonical = normalizeFieldName(alias)
      expect(FILTER_FIELDS).toHaveProperty(canonical)
    }
  })

  test('asn is a first-class field, not only an alias', () => {
    expect(FILTER_FIELDS).toHaveProperty('asn')
    expect(normalizeFieldName('asn')).toBe('asn')
  })
})

describe('in-memory evaluation', () => {
  test('asn matches an AS inside AS_PATH', () => {
    const query = parseQuery('asn = 65002')
    expect(query.errors).toHaveLength(0)
    expect(matchPacket(createUpdatePacket(), query)).toBe(true)
    expect(matchPacket(createOpenPacket(), query)).toBe(false)
  })

  test('aspath alias behaves like asn', () => {
    const query = parseQuery('aspath = 65002')
    expect(query.errors).toHaveLength(0)
    expect(matchPacket(createUpdatePacket(), query)).toBe(true)
  })

  test('a quoted AS number matches the same as a bare one', () => {
    const quoted = parseQuery('asn = "65002"')
    expect(quoted.errors).toHaveLength(0)
    expect(matchPacket(createUpdatePacket(), quoted)).toBe(true)

    const negated = parseQuery('asn != "65002"')
    expect(matchPacket(createUpdatePacket(), negated)).toBe(false)
  })

  test('src_as matches the AS from an OPEN message', () => {
    for (const expr of ['src_as = 65001', 'as = 65001', 'my_as = 65001']) {
      const query = parseQuery(expr)
      expect(query.errors).toHaveLength(0)
      expect(matchPacket(createOpenPacket(), query)).toBe(true)
    }
  })
})

/**
 * Remove every single-quoted literal from a SQL string, treating '' as an escaped
 * quote. Returns null if a literal is left unterminated, which is what a successful
 * injection looks like.
 */
function stripSqlLiterals(sql: string): string | null {
  let out = ''
  let i = 0
  while (i < sql.length) {
    if (sql[i] !== "'") {
      out += sql[i]
      i++
      continue
    }
    // Entered a literal: scan to its close, skipping '' escapes
    i++
    let closed = false
    while (i < sql.length) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") {
          i += 2
          continue
        }
        i++
        closed = true
        break
      }
      i++
    }
    if (!closed) return null
  }
  return out
}

describe('SQL compilation', () => {
  test('src_as and its aliases compile to a my_as lookup', () => {
    for (const expr of ['src_as = 65001', 'as = 65001', 'my_as = 65001']) {
      const sql = expressionToSql(parseQuery(expr).expression)
      expect(sql).toContain('m.my_as')
      expect(sql).not.toBe('1=0')
    }
  })

  test('asn and aspath compile to an as_path lookup', () => {
    for (const expr of ['asn = 65001', 'aspath = 65001']) {
      const sql = expressionToSql(parseQuery(expr).expression)
      expect(sql).toContain('as_path')
      expect(sql).not.toBe('1=0')
    }
  })

  test('quoted numeric values compile the same as bare ones', () => {
    expect(expressionToSql(parseQuery('asn = "65001"').expression)).toBe(
      expressionToSql(parseQuery('asn = 65001').expression)
    )
    expect(expressionToSql(parseQuery('src_as = "65001"').expression)).toBe(
      expressionToSql(parseQuery('src_as = 65001').expression)
    )
  })

  test('single quotes cannot break out of a string literal', () => {
    // Filters are reachable from the ?filter= URL parameter, so a crafted link must
    // not be able to inject SQL into the user's DuckDB instance.
    const payloads = [
      `src_ip = "10' OR 1=1--/8"`,
      `dst_ip = "10' OR 1=1--/8"`,
      `prefix contains "10' OR 1=1--/8"`,
      `withdrawn contains "10' OR 1=1--/8"`,
      `prefix = "10' OR 1=1--/8"`,
      `router_id = "x' OR 1=1--"`,
      `community = "x' OR 1=1--"`,
      `capability = "x' OR 1=1--"`,
      `next_hop = "x' OR 1=1--"`,
      `origin = "x' OR 1=1--"`,
      `type = "x' OR 1=1--"`,
      `src_as = "x' OR 1=1--"`,
    ]

    for (const payload of payloads) {
      const sql = expressionToSql(parseQuery(payload).expression)
      const outside = stripSqlLiterals(sql)
      // The injected fragment must stay inside a string literal, never become SQL
      expect(outside).not.toContain('OR 1=1')
      expect(outside).not.toContain('--')
      // And every literal must be closed
      expect(outside).not.toBeNull()
    }
  })

  test('every filter field compiles to something other than a no-match', () => {
    const sample: Record<string, string> = {
      type: 'OPEN',
      src_ip: '10.0.0.1',
      dst_ip: '10.0.0.2',
      router_id: '10.0.0.1',
      src_as: '65001',
      asn: '65001',
      origin: 'IGP',
      next_hop: '10.0.0.1',
      prefix: '10.0.0.0/8',
      withdrawn: '10.0.0.0/8',
      community: '65000:100',
      capability: 'Route Refresh',
    }

    for (const field of Object.keys(FILTER_FIELDS)) {
      const value = sample[field]
      expect(value).toBeDefined()
      const parsed = parseQuery(`${field} = "${value}"`)
      expect(parsed.errors).toHaveLength(0)
      expect(expressionToSql(parsed.expression)).not.toBe('1=0')
    }
  })
})
