import { describe, test, expect } from 'bun:test'
import {
  parseQuery,
  matchPacket,
  matchTransportFrame,
  normalizeFieldName,
  getSuggestions,
  FILTER_FIELDS,
} from '../../../src/lib/filter/parser'
import type {
  BgpPacket,
  BgpOpenMessage,
  BgpUpdateMessage,
  ParsedPathAttribute,
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
    const aliases = [
      'src', 'dst', 'as', 'aspath', 'nexthop', 'my_as',
      'route-target', 'ext-community', 'evpn-type',
    ]
    for (const alias of aliases) {
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

  test('negation is the complement, so a packet with no routes matches it', () => {
    // A filter and its negation together cover the whole capture: an OPEN has
    // no route in 10.0.0.0/8, so it is one of the packets `!=` selects.
    const open = createOpenPacket()
    for (const [positive, negative] of [
      ['prefix = 10.0.0.0/8', 'prefix != 10.0.0.0/8'],
      ['type = UPDATE', 'type != UPDATE'],
      ['asn = 65002', 'asn != 65002'],
      ['community contains "65000"', 'community not contains "65000"'],
    ]) {
      for (const p of [open, packet]) {
        expect(matchPacket(p, parseQuery(negative))).toBe(!matchPacket(p, parseQuery(positive)))
      }
    }
    expect(matchPacket(open, parseQuery('prefix != 10.0.0.0/8'))).toBe(true)
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

  test('rejected combinations match nothing', () => {
    const parsed = parseQuery('src_ip > 10')
    expect(matchPacket(createOpenPacket(), parsed)).toBe(false)
  })

  test('= and != keep working on the new fields', () => {
    for (const expr of ['src_port = 179', 'dst_port != 179', 'frame = 1']) {
      expect(parseQuery(expr).errors).toHaveLength(0)
    }
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

describe('value suggestions are worked out once per set of packets', () => {
  const values = (packets: BgpPacket[]) => getSuggestions('src_ip = ', 9, packets).map((s) => s.text)

  test('asking again gives the same values', () => {
    const packets = [createOpenPacket()]
    expect(values(packets)).toEqual(['10.0.0.1'])
    expect(values(packets)).toEqual(['10.0.0.1'])
  })

  test('another set of packets is not answered from the first', () => {
    // Remembered per array, not per capture: a session's packets are a new
    // array, and must offer that session's values only.
    const first = [createOpenPacket()]
    const second = [{ ...createOpenPacket(), srcIp: '192.0.2.1', dstIp: '192.0.2.2' }]
    expect(values(first)).toEqual(['10.0.0.1'])
    expect(values(second)).toEqual(['192.0.2.1'])
  })
})

/**
 * The two halves of a MAC move: leaf1 withdraws 00:0c:29:aa:bb:cc, leaf2
 * announces it, carrying the Route Target and the MAC Mobility sequence that
 * settles which advertisement wins.
 */
function createEvpnPacket(options: { announce: boolean }): BgpPacket {
  const evpn = {
    routeType: 2,
    routeTypeName: 'MAC/IP Advertisement',
    rd: options.announce ? '10.0.0.2:100' : '10.0.0.1:100',
    macAddress: '00:0c:29:aa:bb:cc',
    label: 10100,
    esi: '0 (single-homed)',
    ethernetTag: 0,
  }
  const prefix = { prefix: '[2] 00:0c:29:aa:bb:cc', length: 0, evpn }

  const mp = options.announce
    ? { type: 'MP_REACH_NLRI', afi: 25, safi: 70, nextHop: '10.0.0.2', nlri: [prefix] }
    : { type: 'MP_UNREACH_NLRI', afi: 25, safi: 70, withdrawnRoutes: [prefix] }

  const update = {
    type: 'UPDATE',
    withdrawnRoutesLength: 0,
    withdrawnRoutes: [],
    totalPathAttributeLength: 0,
    pathAttributes: [
      { typeCode: 14, typeName: 'MP_REACH_NLRI', parsed: mp },
      {
        typeCode: 16,
        typeName: 'EXTENDED_COMMUNITIES',
        parsed: {
          type: 'EXTENDED_COMMUNITIES',
          communities: [
            { kind: 'Route Target', value: '65002:100', transitive: true, typeCode: 0, subtype: 2 },
            { kind: 'MAC Mobility', value: 'seq 3', transitive: true, typeCode: 6, subtype: 0 },
          ],
        },
      },
    ],
    nlri: [],
  } as unknown as BgpUpdateMessage

  return {
    frameIndex: options.announce ? 9 : 8,
    timestamp: new Date(0),
    srcIp: options.announce ? '10.0.0.2' : '10.0.0.1',
    dstIp: '10.0.0.3',
    srcPort: 179,
    dstPort: 50000,
    messages: [update],
    rawData: new Uint8Array(),
    parseWarnings: [],
  }
}

describe('EVPN and extended community filters', () => {
  const announced = createEvpnPacket({ announce: true })
  const withdrawn = createEvpnPacket({ announce: false })

  function matches(expression: string, packet: BgpPacket): boolean {
    const query = parseQuery(expression)
    expect(query.errors).toHaveLength(0)
    return matchPacket(packet, query)
  }

  test('a MAC search finds the announcement and the withdrawal alike', () => {
    // Half a MAC move is not an answer: the withdrawal is what says it left.
    expect(matches('mac = 00:0c:29:aa:bb:cc', announced)).toBe(true)
    expect(matches('mac = 00:0c:29:aa:bb:cc', withdrawn)).toBe(true)
    expect(matches('mac = 00:0c:29:aa:bb:cd', announced)).toBe(false)
    // Captures print MACs lower case; operators type them either way.
    expect(matches('mac = 00:0C:29:AA:BB:CC', announced)).toBe(true)
  })

  test('rt matches the Route Target value alone', () => {
    expect(matches('rt = 65002:100', announced)).toBe(true)
    expect(matches('rt = 65002:200', announced)).toBe(false)
  })

  test('rt does not match a MAC Mobility value that happens to read alike', () => {
    // The kind restriction is the point: rt asks about Route Targets only.
    expect(matches('rt contains seq', announced)).toBe(false)
    expect(matches('ext_community contains "MAC Mobility"', announced)).toBe(true)
  })

  test('vni narrows a capture to one bridge domain', () => {
    expect(matches('vni = 10100', announced)).toBe(true)
    expect(matches('vni = 10200', announced)).toBe(false)
  })

  test('rd names the leaf a route came from', () => {
    expect(matches('rd = 10.0.0.2:100', announced)).toBe(true)
    expect(matches('rd = 10.0.0.2:100', withdrawn)).toBe(false)
  })

  test('evpn_type selects one route type', () => {
    expect(matches('evpn_type = 2', announced)).toBe(true)
    expect(matches('evpn_type = 3', announced)).toBe(false)
  })

  test('the EVPN fields ignore packets with no EVPN in them', () => {
    const plain = createUpdatePacket()
    expect(matches('mac = 00:0c:29:aa:bb:cc', plain)).toBe(false)
    expect(matches('vni = 10100', plain)).toBe(false)
    expect(matches('rt = 65002:100', plain)).toBe(false)
  })
})

/**
 * `med` and `local_pref`: what the filter matches, and what it must not sweep
 * in when the attribute was never sent.
 */
describe('best-path attribute fields', () => {
  function routeWith(attrs: ParsedPathAttribute[]): BgpPacket {
    const update = {
      type: 'UPDATE',
      withdrawnRoutesLength: 0,
      withdrawnRoutes: [],
      totalPathAttrLength: 0,
      pathAttributes: [
        {
          flags: { optional: false, transitive: true, partial: false, extendedLength: false },
          typeCode: 2,
          typeName: 'AS_PATH',
          length: 0,
          rawValue: new Uint8Array(),
          parsed: {
            type: 'AS_PATH' as const,
            segments: [{ type: 'AS_SEQUENCE' as const, asNumbers: [65001] }],
          },
        },
        ...attrs.map((parsed) => ({
          flags: { optional: true, transitive: false, partial: false, extendedLength: false },
          typeCode: 0,
          typeName: parsed.type,
          length: 0,
          rawValue: new Uint8Array(),
          parsed,
        })),
      ],
      nlri: [{ prefix: '172.20.0.0', length: 16 }],
    } as unknown as BgpUpdateMessage

    return {
      frameIndex: 1,
      timestamp: new Date(Date.UTC(2024, 0, 1)),
      srcIp: '192.0.2.1',
      dstIp: '10.0.0.1',
      srcPort: 179,
      dstPort: 50000,
      messages: [update],
      rawData: new Uint8Array(),
      parseWarnings: [],
    } as BgpPacket
  }

  const matches = (packet: BgpPacket, expr: string) => {
    const query = parseQuery(expr)
    expect(query.errors).toHaveLength(0)
    return matchPacket(packet, query)
  }

  const withMed = routeWith([{ type: 'MULTI_EXIT_DISC', value: 100 }])
  const withLocalPref = routeWith([{ type: 'LOCAL_PREF', value: 200 }])
  const withNeither = routeWith([])
  const withZeroMed = routeWith([{ type: 'MULTI_EXIT_DISC', value: 0 }])

  test('equality matches the value that was sent', () => {
    expect(matches(withMed, 'med = 100')).toBe(true)
    expect(matches(withMed, 'med = 101')).toBe(false)
    expect(matches(withLocalPref, 'local_pref = 200')).toBe(true)
  })

  test('ranges work, which is how a MED question is usually asked', () => {
    expect(matches(withMed, 'med > 50')).toBe(true)
    expect(matches(withMed, 'med > 100')).toBe(false)
    expect(matches(withMed, 'med >= 100')).toBe(true)
    expect(matches(withMed, 'med < 200')).toBe(true)
    expect(matches(withLocalPref, 'local_pref >= 200')).toBe(true)
  })

  test('an UPDATE carrying no MED matches no MED comparison at all', () => {
    // The trap: treating absent as zero would make `med < 100` sweep in every
    // eBGP route in the capture, which is most of them.
    expect(matches(withNeither, 'med = 0')).toBe(false)
    expect(matches(withNeither, 'med < 100')).toBe(false)
    expect(matches(withNeither, 'med > 100')).toBe(false)
    expect(matches(withNeither, 'local_pref > 0')).toBe(false)
  })

  test('a MED of zero is a value and matches as one', () => {
    expect(matches(withZeroMed, 'med = 0')).toBe(true)
    expect(matches(withZeroMed, 'med < 100')).toBe(true)
  })
})

describe('filters applied to frames that carry no BGP', () => {
  // A SYN from the peer to the speaker, the kind of frame All Packets shows.
  const syn = { frameIndex: 7, srcIp: '10.0.13.1', dstIp: '10.0.13.3', srcPort: 39557, dstPort: 179 }
  const icmp = { frameIndex: 8, srcIp: '10.0.13.1', dstIp: '10.0.13.3' }
  const match = (frame: typeof syn | typeof icmp, query: string) =>
    matchTransportFrame(frame, parseQuery(query))

  test('address, port and frame conditions apply to it', () => {
    expect(match(syn, 'src_ip = 10.0.13.1')).toBe(true)
    expect(match(syn, 'dst_ip = 10.0.13.1')).toBe(false)
    expect(match(syn, 'dst_port = 179')).toBe(true)
    expect(match(syn, 'frame >= 7 and frame < 8')).toBe(true)
    expect(match(syn, 'src_ip = 10.0.13.0/24')).toBe(true)
  })

  test('a BGP-only condition never matches it', () => {
    expect(match(syn, 'type = UPDATE')).toBe(false)
    expect(match(syn, 'prefix = 10.0.0.0/8')).toBe(false)
    expect(match(syn, 'src_ip = 10.0.13.1 and type = KEEPALIVE')).toBe(false)
  })

  test('a frame with no ports equals no port', () => {
    expect(match(icmp, 'src_port = 179 or dst_port = 179')).toBe(false)
    expect(match(icmp, 'src_ip = 10.0.13.1')).toBe(true)
  })
})

describe('what people type out of habit', () => {
  const from = (src: string, dst: string): BgpPacket => ({ ...createOpenPacket(), srcIp: src, dstIp: dst })
  const outbound = from('10.0.13.1', '10.0.13.3')
  const inbound = from('10.0.13.3', '10.0.13.1')
  const elsewhere = from('10.0.14.1', '10.0.14.4')
  const matches = (query: string, packet: BgpPacket) => {
    const parsed = parseQuery(query)
    expect(parsed.errors).toHaveLength(0)
    return matchPacket(packet, parsed)
  }

  test('== is =', () => {
    expect(parseQuery('type == OPEN')).toEqual(parseQuery('type = OPEN'))
    expect(matches('src_ip == 10.0.13.1', outbound)).toBe(true)
  })

  test('ip and peer match either direction', () => {
    for (const field of ['ip', 'peer']) {
      expect(matches(`${field} = 10.0.13.1`, outbound)).toBe(true)
      expect(matches(`${field} = 10.0.13.1`, inbound)).toBe(true)
      expect(matches(`${field} = 10.0.13.1`, elsewhere)).toBe(false)
    }
  })

  test('ip != excludes the address on either side', () => {
    expect(matches('ip != 10.0.13.1', outbound)).toBe(false)
    expect(matches('ip != 10.0.13.1', inbound)).toBe(false)
    expect(matches('ip != 10.0.13.1', elsewhere)).toBe(true)
  })

  test('ip takes no ordering', () => {
    expect(parseQuery('ip > 10.0.0.1').errors.length).toBeGreaterThan(0)
  })

  test('a bare value is read as the comparison it most likely is', () => {
    expect(parseQuery('10.0.13.1')).toEqual(parseQuery('ip = 10.0.13.1'))
    expect(parseQuery('fe80::1')).toEqual(parseQuery('ip = fe80::1'))
    expect(parseQuery('10.0.0.0/8')).toEqual(parseQuery('prefix = 10.0.0.0/8'))
    expect(parseQuery('AS65001')).toEqual(parseQuery('asn = 65001'))
    expect(parseQuery('update')).toEqual(parseQuery('type = UPDATE'))
    expect(parseQuery('00:0c:29:aa:bb:cc')).toEqual(parseQuery('mac = 00:0c:29:aa:bb:cc'))
    expect(parseQuery('10.0.13.1 and type = OPEN')).toEqual(parseQuery('ip = 10.0.13.1 and type = OPEN'))
  })

  test('a bare word that is none of those is still an error', () => {
    expect(parseQuery('bogus').errors.length).toBeGreaterThan(0)
  })

  test('ip and peer are offered as fields', () => {
    const fields = getSuggestions('', 0, []).map((s) => s.text)
    expect(fields).toContain('ip')
    expect(fields).toContain('peer')
    expect(getSuggestions('ip = ', 5, [outbound]).map((s) => s.text)).toContain('10.0.13.3')
  })
})

describe('prefix follows a route through its withdrawal', () => {
  const update = (nlri: string[], withdrawn: string[]): BgpPacket => {
    const toPrefix = (t: string) => ({ prefix: t.split('/')[0], length: Number(t.split('/')[1]) })
    const msg = {
      type: 'UPDATE',
      withdrawnRoutesLength: 0,
      withdrawnRoutes: withdrawn.map(toPrefix),
      totalPathAttributeLength: 0,
      pathAttributes: [],
      nlri: nlri.map(toPrefix),
    } as unknown as BgpUpdateMessage
    return { ...createOpenPacket(), messages: [msg] }
  }
  const announce = update(['1.1.1.1/32'], [])
  const withdraw = update([], ['1.1.1.1/32'])
  const matches = (q: string, p: BgpPacket) => matchPacket(p, parseQuery(q))

  test('prefix matches the announcement and the withdrawal', () => {
    expect(matches('prefix = 1.1.1.1/32', announce)).toBe(true)
    expect(matches('prefix = 1.1.1.1/32', withdraw)).toBe(true)
  })

  test('nlri and withdrawn keep to their own side', () => {
    expect(matches('nlri = 1.1.1.1/32', announce)).toBe(true)
    expect(matches('nlri = 1.1.1.1/32', withdraw)).toBe(false)
    expect(matches('withdrawn = 1.1.1.1/32', withdraw)).toBe(true)
    expect(matches('withdrawn = 1.1.1.1/32', announce)).toBe(false)
  })
})

describe('parse errors', () => {
  test('characters the language has no use for are reported as typed', () => {
    // They used to be skipped, and the error then talked about the query
    // ending after `and` rather than about the `!!!`.
    const { errors } = parseQuery('type = UPDATE and !!!')
    expect(errors).toHaveLength(1)
    expect(errors[0].detail).toEqual({ code: 'expected-field', got: '!!!' })
    expect(errors[0].message).toBe('Expected a field name, got "!!!"')
  })

  test('`!=` still reads as an operator next to an invalid run', () => {
    expect(parseQuery('type != KEEPALIVE').errors).toHaveLength(0)
    expect(parseQuery('type = UPDATE and ! type = OPEN').errors[0].detail).toEqual({
      code: 'expected-field',
      got: '!',
    })
  })

  test('a query that stops early says so instead of naming a token', () => {
    const { errors } = parseQuery('type = UPDATE and')
    expect(errors[0].detail).toEqual({ code: 'expected-field', got: null })
    expect(errors[0].message).toBe('The filter ends where a field name was expected')
  })

  test('every error carries its detail, so the interface can translate it', () => {
    for (const query of ['type', 'type =', 'asn > abc', 'type < 3', 'type = UPDATE )']) {
      const { errors } = parseQuery(query)
      expect(errors.length).toBeGreaterThan(0)
      for (const error of errors) expect(error.detail.code).toBeTruthy()
    }
  })
})
