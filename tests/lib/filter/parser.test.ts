import { describe, test, expect } from 'bun:test'
import {
  parseQuery,
  matchPacket,
  normalizeFieldName,
  getSuggestions,
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
      src_port: '179',
      dst_port: '50000',
      frame: '3',
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

/**
 * UPDATE announcing 10.0.12.0/24 and withdrawing 10.9.0.0/16, from 192.168.1.5.
 */
function createRoutePacket(): BgpPacket {
  const update = {
    type: 'UPDATE',
    withdrawnRoutesLength: 0,
    withdrawnRoutes: [{ prefix: '10.9.0.0', length: 16 }],
    totalPathAttributeLength: 0,
    pathAttributes: [],
    nlri: [{ prefix: '10.0.12.0', length: 24 }],
  } as unknown as BgpUpdateMessage

  return {
    frameIndex: 3,
    timestamp: new Date(0),
    srcIp: '192.168.1.5',
    dstIp: '10.0.0.2',
    srcPort: 179,
    dstPort: 50000,
    messages: [update],
    rawData: new Uint8Array(),
    parseWarnings: [],
  }
}

describe('prefix matching', () => {
  const packet = createRoutePacket()
  const matches = (expr: string) => {
    const query = parseQuery(expr)
    expect(query.errors).toHaveLength(0)
    return matchPacket(packet, query)
  }

  test('a CIDR selects the routes inside it', () => {
    // 10.0.12.0/24 is inside 10.0.0.0/8, and is not a literal 10.0.0.0/8.
    expect(matches('prefix = 10.0.0.0/8')).toBe(true)
    expect(matches('prefix = 10.0.12.0/24')).toBe(true)
    expect(matches('prefix = 172.16.0.0/12')).toBe(false)
  })

  test('a supernet of the query does not match', () => {
    expect(matches('prefix = 10.0.12.0/25')).toBe(false)
  })

  test('a bare address selects the routes covering it', () => {
    expect(matches('prefix = 10.0.12.7')).toBe(true)
    expect(matches('prefix = 10.0.13.7')).toBe(false)
  })

  test('withdrawn is searched the same way', () => {
    expect(matches('withdrawn = 10.9.0.0/16')).toBe(true)
    expect(matches('withdrawn = 10.9.1.2')).toBe(true)
    expect(matches('withdrawn = 10.0.12.0/24')).toBe(false)
    // prefix covers announced and withdrawn together
    expect(matches('prefix = 10.9.0.0/16')).toBe(true)
  })

  test('negation is the inverse', () => {
    expect(matches('prefix != 10.0.0.0/8')).toBe(false)
    expect(matches('prefix != 172.16.0.0/12')).toBe(true)
  })

  test('text that is not an address stays a substring search', () => {
    expect(matches('prefix contains "10.0.12"')).toBe(true)
    expect(matches('prefix contains "10.0.99"')).toBe(false)
  })
})

describe('IP address fields honour CIDR', () => {
  const packet = createRoutePacket() // srcIp 192.168.1.5
  const matches = (expr: string) => {
    const query = parseQuery(expr)
    expect(query.errors).toHaveLength(0)
    return matchPacket(packet, query)
  }

  test('an address inside the block matches', () => {
    expect(matches('src_ip = 192.168.0.0/16')).toBe(true)
    expect(matches('src_ip = 192.168.1.0/24')).toBe(true)
    expect(matches('src_ip = 10.0.0.0/8')).toBe(false)
  })

  test('the mask is honoured to the bit, not rounded to whole octets', () => {
    // 192.168.1.5 is inside 192.168.0.0/23 but not inside 192.168.2.0/23.
    expect(matches('src_ip = 192.168.0.0/23')).toBe(true)
    expect(matches('src_ip = 192.168.2.0/23')).toBe(false)
    // /12 covers 192.160.0.0 - 192.175.255.255, /4 covers 192.0.0.0 - 207.x.
    expect(matches('src_ip = 192.160.0.0/12')).toBe(true)
    expect(matches('src_ip = 192.128.0.0/12')).toBe(false)
  })

  test('a plain address is still an exact match', () => {
    expect(matches('src_ip = 192.168.1.5')).toBe(true)
    expect(matches('src_ip = 192.168.1.6')).toBe(false)
  })

  test('negation is the inverse', () => {
    expect(matches('src_ip != 192.168.0.0/16')).toBe(false)
    expect(matches('src_ip != 10.0.0.0/8')).toBe(true)
  })
})

/**
 * KEEPALIVE on a given frame and TCP port pair. A BGP connection collision puts
 * two sessions between the same IP pair in one capture, distinguishable only by
 * their ports.
 */
function createSessionPacket(frameIndex: number, srcPort: number, dstPort: number): BgpPacket {
  return {
    frameIndex,
    timestamp: new Date(0),
    srcIp: '10.0.0.1',
    dstIp: '10.0.0.2',
    srcPort,
    dstPort,
    messages: [{ type: 'KEEPALIVE' } as unknown as BgpPacket['messages'][number]],
    rawData: new Uint8Array(),
    parseWarnings: [],
  }
}

describe('port and frame fields', () => {
  // Session A dials out from an ephemeral port, session B is the inbound half
  const sessionA = createSessionPacket(10, 54321, 179)
  const sessionB = createSessionPacket(20, 179, 54322)

  const matches = (packet: BgpPacket, expr: string) => {
    const query = parseQuery(expr)
    expect(query.errors).toHaveLength(0)
    return matchPacket(packet, query)
  }

  test('src_port and dst_port separate two sessions between the same IP pair', () => {
    expect(matches(sessionA, 'src_port = 54321')).toBe(true)
    expect(matches(sessionB, 'src_port = 54321')).toBe(false)
    expect(matches(sessionA, 'dst_port = 179')).toBe(true)
    expect(matches(sessionB, 'dst_port = 179')).toBe(false)
    expect(matches(sessionA, 'src_port != 54321')).toBe(false)
  })

  test('src_port or dst_port picks either direction of one session', () => {
    for (const packet of [sessionA, sessionB]) {
      expect(matches(packet, 'src_port = 179 or dst_port = 179')).toBe(true)
    }
    expect(matches(sessionA, 'src_port = 179 or dst_port = 54322')).toBe(false)
  })

  test('frame matches the packet number shown in the list', () => {
    expect(matches(sessionA, 'frame = 10')).toBe(true)
    expect(matches(sessionB, 'frame = 10')).toBe(false)
  })

  test('a quoted number matches the same as a bare one', () => {
    expect(matches(sessionA, 'frame = "10"')).toBe(true)
    expect(matches(sessionA, 'frame > "5"')).toBe(true)
  })

  test('ordered comparisons narrow to a frame range', () => {
    expect(matches(sessionA, 'frame >= 10 and frame < 20')).toBe(true)
    expect(matches(sessionB, 'frame >= 10 and frame < 20')).toBe(false)
    expect(matches(sessionA, 'frame > 10')).toBe(false)
    expect(matches(sessionA, 'frame <= 10')).toBe(true)
    expect(matches(sessionB, 'frame > 10')).toBe(true)
  })

  test('ordered comparisons work on ports and on the existing numeric fields', () => {
    expect(matches(sessionA, 'src_port > 1024')).toBe(true)
    expect(matches(sessionB, 'src_port > 1024')).toBe(false)
    expect(matches(createOpenPacket(), 'src_as >= 65001')).toBe(true)
    expect(matches(createOpenPacket(), 'src_as > 65001')).toBe(false)
    // Any AS in the path answering the comparison selects the packet
    expect(matches(createUpdatePacket(), 'asn > 65001')).toBe(true)
    expect(matches(createUpdatePacket(), 'asn > 65002')).toBe(false)
  })
})

describe('ordered operators are numeric-only', () => {
  test('a text field rejects them with a parse error', () => {
    for (const expr of ['src_ip > 10', 'type < OPEN', 'prefix >= 10.0.0.0/8', 'community <= 5']) {
      const parsed = parseQuery(expr)
      expect(parsed.errors.length).toBeGreaterThan(0)
      expect(parsed.errors[0].message).toContain('only valid for numeric fields')
    }
  })

  test('a non-numeric value on a numeric field is rejected', () => {
    const parsed = parseQuery('frame > abc')
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(parsed.errors[0].message).toContain('Expected a number')
  })

  test('rejected combinations match nothing on both paths', () => {
    const parsed = parseQuery('src_ip > 10')
    expect(matchPacket(createOpenPacket(), parsed)).toBe(false)
    expect(expressionToSql(parsed.expression)).toBe('1=0')
  })

  test('= and != keep working on the new fields', () => {
    for (const expr of ['src_port = 179', 'dst_port != 179', 'frame = 1']) {
      expect(parseQuery(expr).errors).toHaveLength(0)
    }
  })
})

describe('port and frame SQL', () => {
  const sql = (expr: string) => {
    const parsed = parseQuery(expr)
    expect(parsed.errors).toHaveLength(0)
    return expressionToSql(parsed.expression)
  }

  test('equality compiles to the packets table columns', () => {
    expect(sql('src_port = 179')).toBe('p.src_port = 179')
    expect(sql('dst_port = 50000')).toBe('p.dst_port = 50000')
    expect(sql('frame = 12')).toBe('p.frame_index = 12')
    expect(sql('src_port != 179')).toBe('p.src_port != 179')
  })

  test('ordered comparisons compile to the same comparison in SQL', () => {
    expect(sql('frame > 100')).toBe('p.frame_index > 100')
    expect(sql('frame >= 100')).toBe('p.frame_index >= 100')
    expect(sql('frame < 100')).toBe('p.frame_index < 100')
    expect(sql('frame <= 100')).toBe('p.frame_index <= 100')
    expect(sql('src_port > 1024')).toBe('p.src_port > 1024')
    expect(sql('dst_port <= 1024')).toBe('p.dst_port <= 1024')
  })

  test('a frame range compiles to a bounded AND', () => {
    expect(sql('frame >= 100 and frame < 200')).toBe('(p.frame_index >= 100 AND p.frame_index < 200)')
  })

  test('both sessions of a collision compile to an OR over the ports', () => {
    expect(sql('src_port = 179 or dst_port = 179')).toBe('(p.src_port = 179 OR p.dst_port = 179)')
  })

  test('quoted numbers compile the same as bare ones', () => {
    expect(sql('frame > "100"')).toBe(sql('frame > 100'))
    expect(sql('src_port = "179"')).toBe(sql('src_port = 179'))
  })

  test('ordered comparisons on the existing numeric fields stay EXISTS lookups', () => {
    expect(sql('src_as > 65000')).toContain('m.my_as > 65000')
    expect(sql('asn <= 65000')).toContain('ap.asn <= 65000')
  })

  test('a non-numeric port value stays escaped text, never bare SQL', () => {
    const injected = expressionToSql(parseQuery(`src_port = "179' OR 1=1--"`).expression)
    const outside = stripSqlLiterals(injected)
    expect(outside).not.toBeNull()
    expect(outside).not.toContain('OR 1=1')
    expect(outside).toContain('CAST(p.src_port AS VARCHAR)')
  })
})

describe('autocomplete knows the new fields', () => {
  test('src_port, dst_port and frame appear in field suggestions', () => {
    const fields = getSuggestions('', 0, []).map((s) => s.text)
    for (const field of ['src_port', 'dst_port', 'frame']) {
      expect(fields).toContain(field)
    }
  })

  test('a numeric field suggests the ordered operators', () => {
    for (const field of ['frame', 'src_port', 'dst_port']) {
      const ops = getSuggestions(`${field} `, field.length + 1, []).map((s) => s.text)
      expect(ops).toEqual(expect.arrayContaining(['=', '!=', '<', '<=', '>', '>=']))
    }
  })

  test('a text field does not', () => {
    const ops = getSuggestions('src_ip ', 7, []).map((s) => s.text)
    expect(ops).toEqual(['=', '!=', 'contains'])
  })

  test('numbers have no value suggestions to offer', () => {
    expect(getSuggestions('frame > ', 8, [])).toHaveLength(0)
  })
})

describe('SQL and in-memory paths ask the same question', () => {
  test('a CIDR prefix search compiles to a containment test, not string equality', () => {
    const sql = expressionToSql(parseQuery('prefix = 10.0.0.0/8').expression)
    // 10.0.0.0/8 -> bits 00001010
    expect(sql).toContain("prefix_bits LIKE '4:00001010%'")
    expect(sql).not.toContain("prefix_length = ")
  })

  test('a bare address compiles to a covering-route test', () => {
    const sql = expressionToSql(parseQuery('prefix = 10.0.12.7').expression)
    expect(sql).toContain("LIKE t.prefix_bits || '%'")
  })

  test('an IP field CIDR compiles to a bit-key test', () => {
    const sql = expressionToSql(parseQuery('src_ip = 192.168.0.0/23').expression)
    // 192.168.0.0/23 -> 11000000 10101000 0000000, exactly 23 bits
    expect(sql).toContain("src_ip_bits LIKE '4:11000000101010000000000%'")
  })

  test('IPv6 compiles too', () => {
    const sql = expressionToSql(parseQuery('prefix = "2001:db8::/32"').expression)
    expect(sql).toContain("prefix_bits LIKE '6:")
  })

  test('a value that is not an address stays escaped text', () => {
    const sql = expressionToSql(parseQuery(`prefix = "10' OR 1=1--"`).expression)
    expect(stripSqlLiterals(sql)).not.toContain('OR 1=1')
  })
})
