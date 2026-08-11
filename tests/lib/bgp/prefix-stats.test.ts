import { describe, test, expect } from 'bun:test'
import { aggregatePrefixStats, type PrefixStats } from '../../../src/lib/bgp/prefix-stats'
import type {
  BgpPacket,
  BgpPathAttribute,
  BgpPrefix,
  BgpUpdateMessage,
  ParsedPathAttribute,
} from '../../../src/lib/bgp/types'

/** `10.0.12.0/24` written the short way the tests read in. */
function prefix(text: string): BgpPrefix {
  const [address, length] = text.split('/')
  return { prefix: address, length: Number(length) }
}

function attribute(parsed: ParsedPathAttribute): BgpPathAttribute {
  return {
    flags: { optional: false, transitive: true, partial: false, extendedLength: false },
    typeCode: 0,
    typeName: parsed.type,
    length: 0,
    rawValue: new Uint8Array(),
    parsed,
  }
}

/**
 * One UPDATE from `source`, at a second of the capture chosen by the caller so
 * ordering is explicit rather than a side effect of the array literal.
 */
function update(
  source: string,
  second: number,
  fields: Partial<BgpUpdateMessage>
): BgpPacket {
  const message: BgpUpdateMessage = {
    type: 'UPDATE',
    withdrawnRoutesLength: 0,
    withdrawnRoutes: [],
    totalPathAttrLength: 0,
    pathAttributes: [],
    nlri: [],
    ...fields,
  }
  return {
    frameIndex: second,
    timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, second)),
    srcIp: source,
    dstIp: '10.255.255.255',
    srcPort: 179,
    dstPort: 50000,
    messages: [message],
    rawData: new Uint8Array(),
    parseWarnings: [],
  }
}

function announce(source: string, second: number, text: string, asns: number[] = [65001]): BgpPacket {
  return update(source, second, {
    nlri: [prefix(text)],
    pathAttributes: [
      attribute({ type: 'AS_PATH', segments: [{ type: 'AS_SEQUENCE', asNumbers: asns }] }),
      attribute({ type: 'NEXT_HOP', address: source }),
    ],
  })
}

function withdraw(source: string, second: number, text: string): BgpPacket {
  return update(source, second, { withdrawnRoutes: [prefix(text)] })
}

/** The one row the capture should have produced, or a loud failure. */
function only(stats: PrefixStats[]): PrefixStats {
  expect(stats).toHaveLength(1)
  return stats[0]
}

describe('flap counting', () => {
  test('an announce is not a flap, however many peers send it', () => {
    // The bug this replaces: five peers announcing a stable route once each
    // read as five flaps and sorted to the top of the table.
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      announce('192.0.2.2', 2, '10.0.12.0/24'),
      announce('192.0.2.3', 3, '10.0.12.0/24'),
      announce('192.0.2.4', 4, '10.0.12.0/24'),
      announce('192.0.2.5', 5, '10.0.12.0/24'),
    ])

    const stat = only(stats)
    expect(stat.flap).toBe(0)
    expect(stat.announced).toBe(5)
  })

  test('repeated announces from one peer are not flaps either', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      announce('192.0.2.1', 2, '10.0.12.0/24'),
      announce('192.0.2.1', 3, '10.0.12.0/24'),
    ])

    expect(only(stats).flap).toBe(0)
  })

  test('a route going down is one flap', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      withdraw('192.0.2.1', 2, '10.0.12.0/24'),
    ])

    expect(only(stats).flap).toBe(1)
  })

  test('coming back and going down again is a second flap', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      withdraw('192.0.2.1', 2, '10.0.12.0/24'),
      announce('192.0.2.1', 3, '10.0.12.0/24'),
      withdraw('192.0.2.1', 4, '10.0.12.0/24'),
    ])

    const stat = only(stats)
    expect(stat.flap).toBe(2)
    expect(stat.announced).toBe(2)
    expect(stat.withdrawn).toBe(2)
  })

  test('two peers flapping the same route sum', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      announce('192.0.2.2', 2, '10.0.12.0/24'),
      withdraw('192.0.2.1', 3, '10.0.12.0/24'),
      announce('192.0.2.1', 4, '10.0.12.0/24'),
      withdraw('192.0.2.1', 5, '10.0.12.0/24'),
      withdraw('192.0.2.2', 6, '10.0.12.0/24'),
    ])

    expect(only(stats).flap).toBe(3)
  })

  test('one peer withdrawing does not clear another peer that is still up', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      announce('192.0.2.2', 2, '10.0.12.0/24'),
      withdraw('192.0.2.1', 3, '10.0.12.0/24'),
      withdraw('192.0.2.1', 4, '10.0.12.0/24'),
    ])

    // The second withdraw from .1 is a repeat, and .2 never withdrew at all.
    expect(only(stats).flap).toBe(1)
  })

  test('a withdraw with no announce before it still counts', () => {
    // The capture started mid-session: the route was up before recording
    // began, and it going away is exactly what the column is there to show.
    const stats = aggregatePrefixStats([withdraw('192.0.2.1', 1, '10.0.12.0/24')])

    const stat = only(stats)
    expect(stat.flap).toBe(1)
    expect(stat.announced).toBe(0)
    expect(stat.withdrawn).toBe(1)
  })

  test('the same route from different peers is one row, different masks are not', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      withdraw('192.0.2.1', 2, '10.0.12.0/23'),
    ])

    expect(stats.map(s => s.key).sort()).toEqual(['10.0.12.0/23', '10.0.12.0/24'])
    expect(stats.find(s => s.key === '10.0.12.0/24')!.flap).toBe(0)
    expect(stats.find(s => s.key === '10.0.12.0/23')!.flap).toBe(1)
  })

  test('MP_REACH and MP_UNREACH are counted the same way', () => {
    const stats = aggregatePrefixStats([
      update('192.0.2.1', 1, {
        pathAttributes: [
          attribute({
            type: 'MP_REACH_NLRI',
            afi: 2,
            afiName: 'IPv6',
            safi: 1,
            safiName: 'unicast',
            nextHop: '2001:db8:0:0:0:0:0:1',
            nlri: [prefix('2001:db8:1:0:0:0:0:0/48')],
          }),
        ],
      }),
      update('192.0.2.1', 2, {
        pathAttributes: [
          attribute({
            type: 'MP_UNREACH_NLRI',
            afi: 2,
            afiName: 'IPv6',
            safi: 1,
            safiName: 'unicast',
            withdrawnRoutes: [prefix('2001:db8:1:0:0:0:0:0/48')],
          }),
        ],
      }),
    ])

    const stat = only(stats)
    expect(stat.flap).toBe(1)
    expect(stat.announced).toBe(1)
    expect(stat.withdrawn).toBe(1)
  })
})

describe('the rest of the row', () => {
  test('keeps every AS seen announcing the route', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24', [65001, 65002]),
      announce('192.0.2.2', 2, '10.0.12.0/24', [65003]),
    ])

    expect([...only(stats).asns].sort()).toEqual(['65001', '65002', '65003'])
  })

  test('records history in time order, linked back to its packet', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      withdraw('192.0.2.1', 2, '10.0.12.0/24'),
    ])

    const stat = only(stats)
    expect(stat.history.map(e => e.action)).toEqual(['announce', 'withdraw'])
    expect(stat.history.map(e => e.packetIndex)).toEqual([0, 1])
    expect(stat.history[0].asPath).toBe('65001')
    expect(stat.history[0].nextHop).toBe('192.0.2.1')
  })

  test('last seen is the most recent event, whichever kind it was', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      withdraw('192.0.2.1', 30, '10.0.12.0/24'),
    ])

    const stat = only(stats)
    expect(stat.lastSeen.getUTCSeconds()).toBe(30)
    expect(stat.lastSeenMs).toBe(stat.lastSeen.getTime())
  })

  test('counts every event for the sort tiebreak', () => {
    const stats = aggregatePrefixStats([
      announce('192.0.2.1', 1, '10.0.12.0/24'),
      announce('192.0.2.2', 2, '10.0.12.0/24'),
      withdraw('192.0.2.1', 3, '10.0.12.0/24'),
    ])

    expect(only(stats).eventCount).toBe(3)
  })

  test('ignores messages that are not UPDATEs', () => {
    const keepalive: BgpPacket = {
      ...announce('192.0.2.1', 1, '10.0.12.0/24'),
      messages: [{ type: 'KEEPALIVE' }],
    }

    expect(aggregatePrefixStats([keepalive])).toEqual([])
  })
})

/**
 * One EVPN MAC/IP route, as announced from `rd`. The MAC and VNI are what a
 * fabric operator follows; the RD says which leaf is claiming it right now.
 */
function evpnMac(rd: string, mac = '00:0c:29:aa:bb:cc', vni = 10100): BgpPrefix {
  return {
    prefix: `[2] ${mac} RD ${rd} VNI ${vni}`,
    length: 0,
    evpn: {
      routeType: 2,
      routeTypeName: 'MAC/IP Advertisement',
      rd,
      macAddress: mac,
      label: vni,
    },
  }
}

function evpnAnnounce(source: string, second: number, route: BgpPrefix): BgpPacket {
  return update(source, second, {
    pathAttributes: [
      attribute({
        type: 'MP_REACH_NLRI',
        afi: 25,
        afiName: 'L2VPN',
        safi: 70,
        safiName: 'EVPN',
        nextHop: source,
        nlri: [route],
      }),
    ],
  })
}

function evpnWithdraw(source: string, second: number, route: BgpPrefix): BgpPacket {
  return update(source, second, {
    pathAttributes: [
      attribute({
        type: 'MP_UNREACH_NLRI',
        afi: 25,
        afiName: 'L2VPN',
        safi: 70,
        safiName: 'EVPN',
        withdrawnRoutes: [route],
      }),
    ],
  })
}

describe('EVPN routes on the route history', () => {
  test('a MAC that moves between leaves is one route, not two', () => {
    // The Route Distinguisher changes on a move and the MAC does not. Keying by
    // the RD would file the withdrawal and the re-announcement as unrelated
    // routes, which is the one event this screen exists to show as a sequence.
    const stat = only(
      aggregatePrefixStats([
        evpnAnnounce('10.0.0.2', 1, evpnMac('10.0.0.2:100')),
        evpnWithdraw('10.0.0.2', 60, evpnMac('10.0.0.2:100')),
        evpnAnnounce('10.0.0.1', 62, evpnMac('10.0.0.1:100')),
      ])
    )

    expect(stat.key).toBe('[2] 00:0c:29:aa:bb:cc VNI 10100')
    expect(stat.announced).toBe(2)
    expect(stat.withdrawn).toBe(1)
    expect(stat.history).toHaveLength(3)
  })

  test('the RD is kept on each event, so the move is still readable', () => {
    const stat = only(
      aggregatePrefixStats([
        evpnAnnounce('10.0.0.2', 1, evpnMac('10.0.0.2:100')),
        evpnAnnounce('10.0.0.1', 62, evpnMac('10.0.0.1:100')),
      ])
    )

    expect(stat.history.map((event) => event.rd)).toEqual(['10.0.0.2:100', '10.0.0.1:100'])
  })

  test('the same MAC in a different VNI is a different route', () => {
    // Dropping the RD is only safe because the VNI stays in the key.
    const stats = aggregatePrefixStats([
      evpnAnnounce('10.0.0.2', 1, evpnMac('10.0.0.2:100', '00:0c:29:aa:bb:cc', 10100)),
      evpnAnnounce('10.0.0.2', 2, evpnMac('10.0.0.2:200', '00:0c:29:aa:bb:cc', 10200)),
    ])

    expect(stats).toHaveLength(2)
  })

  test('a route type whose bridge domain is only in the RD keeps it', () => {
    // Inclusive Multicast carries no VNI, so two bridge domains on one leaf are
    // told apart by the RD alone — dropping it would merge them.
    const imet = (rd: string): BgpPrefix => ({
      prefix: `[3] IMET 10.0.0.2 RD ${rd}`,
      length: 0,
      evpn: {
        routeType: 3,
        routeTypeName: 'Inclusive Multicast Ethernet Tag',
        rd,
        originatingRouterIp: '10.0.0.2',
        ethernetTag: 0,
      },
    })

    const stats = aggregatePrefixStats([
      evpnAnnounce('10.0.0.2', 1, imet('10.0.0.2:100')),
      evpnAnnounce('10.0.0.2', 1, imet('10.0.0.2:200')),
    ])

    expect(stats).toHaveLength(2)
  })

  test('a move shows as a flap, because the route did go away', () => {
    const stat = only(
      aggregatePrefixStats([
        evpnAnnounce('10.0.0.2', 1, evpnMac('10.0.0.2:100')),
        evpnWithdraw('10.0.0.2', 60, evpnMac('10.0.0.2:100')),
        evpnAnnounce('10.0.0.1', 62, evpnMac('10.0.0.1:100')),
      ])
    )

    expect(stat.flap).toBe(1)
  })
})
