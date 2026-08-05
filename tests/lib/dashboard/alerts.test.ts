import { describe, test, expect } from 'bun:test'
import { computeAlerts } from '../../../src/components/dashboard/alerts'
import type { DashboardAlert } from '../../../src/components/dashboard/types'
import type {
  BgpMessage,
  BgpPacket,
  BgpPathAttribute,
  BgpPrefix,
  BgpUpdateMessage,
  ParsedPathAttribute,
} from '../../../src/lib/bgp/types'

function at(second: number): Date {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, second))
}

function packet(src: string, dst: string, second: number, messages: BgpMessage[]): BgpPacket {
  return {
    frameIndex: second,
    timestamp: at(second),
    srcIp: src,
    dstIp: dst,
    srcPort: 179,
    dstPort: 50000,
    messages,
    rawData: new Uint8Array(),
    parseWarnings: [],
  }
}

/** A NOTIFICATION carrying the OPEN Message Error / Bad Peer AS of the report. */
function notification(
  src: string,
  dst: string,
  second: number,
  errorCode = 2,
  errorSubcode = 2
): BgpPacket {
  return packet(src, dst, second, [
    {
      type: 'NOTIFICATION',
      errorCode,
      errorSubcode,
      errorCodeName: 'OPEN Message Error',
      errorSubcodeName: errorSubcode === 2 ? 'Bad Peer AS' : 'Unsupported Version Number',
      data: new Uint8Array(),
      hint: '',
    },
  ])
}

function open(src: string, dst: string, second: number): BgpPacket {
  return packet(src, dst, second, [
    {
      type: 'OPEN',
      version: 4,
      myAs: 65001,
      holdTime: 90,
      bgpIdentifier: src,
      optParamLength: 0,
      capabilities: [],
    },
  ])
}

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

function update(src: string, second: number, fields: Partial<BgpUpdateMessage>): BgpPacket {
  const message: BgpUpdateMessage = {
    type: 'UPDATE',
    withdrawnRoutesLength: 0,
    withdrawnRoutes: [],
    totalPathAttrLength: 0,
    pathAttributes: [],
    nlri: [],
    ...fields,
  }
  return packet(src, '10.255.255.255', second, [message])
}

function announce(src: string, second: number, text: string, asns: number[] = [65001]): BgpPacket {
  return update(src, second, {
    nlri: [prefix(text)],
    pathAttributes: [
      attribute({ type: 'AS_PATH', segments: [{ type: 'AS_SEQUENCE', asNumbers: asns }] }),
      attribute({ type: 'NEXT_HOP', address: src }),
    ],
  })
}

function withdraw(src: string, second: number, text: string): BgpPacket {
  return update(src, second, { withdrawnRoutes: [prefix(text)] })
}

function byId(alerts: DashboardAlert[], prefixOfId: string): DashboardAlert[] {
  return alerts.filter((alert) => alert.id.startsWith(prefixOfId))
}

describe('NOTIFICATION grouping', () => {
  test('a peer retrying the same rejected OPEN is one row', () => {
    // The bug this replaces: three identical rows burying every other finding.
    const alerts = computeAlerts([
      notification('10.10.0.2', '10.10.0.1', 0),
      notification('10.10.0.2', '10.10.0.1', 30),
      notification('10.10.0.2', '10.10.0.1', 60),
    ])

    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toBe('NOTIFICATION: OPEN Message Error / Bad Peer AS')
    expect(alerts[0].detail).toBe('10.10.0.2 → 10.10.0.1')
    expect(alerts[0].count).toBe(3)
    expect(alerts[0].timeSpan).toEqual({ start: at(0), end: at(60) })
  })

  test('a single NOTIFICATION carries no count and no range', () => {
    const alerts = computeAlerts([notification('10.10.0.2', '10.10.0.1', 0)])

    expect(alerts[0].count).toBe(1)
    expect(alerts[0].timeSpan).toBeUndefined()
  })

  test('the row links to the first occurrence, keeping filter and packetIndex', () => {
    const alerts = computeAlerts([
      open('10.10.0.1', '10.10.0.2', 0),
      notification('10.10.0.2', '10.10.0.1', 1),
      notification('10.10.0.2', '10.10.0.1', 2),
    ])

    expect(alerts[0].packetIndex).toBe(1)
    expect(alerts[0].timestamp).toEqual(at(1))
    expect(alerts[0].filter).toBe(
      '(src=10.10.0.2 and dst=10.10.0.1) or (src=10.10.0.1 and dst=10.10.0.2)'
    )
  })

  test('the first occurrence wins even when the capture is out of time order', () => {
    const alerts = computeAlerts([
      notification('10.10.0.2', '10.10.0.1', 60),
      notification('10.10.0.2', '10.10.0.1', 5),
    ])

    expect(alerts[0].timestamp).toEqual(at(5))
    expect(alerts[0].packetIndex).toBe(1)
    expect(alerts[0].timeSpan).toEqual({ start: at(5), end: at(60) })
  })

  test('a different subcode is a different fault and keeps its own row', () => {
    const alerts = computeAlerts([
      notification('10.10.0.2', '10.10.0.1', 0, 2, 2),
      notification('10.10.0.2', '10.10.0.1', 1, 2, 1),
    ])

    expect(alerts).toHaveLength(2)
    expect(alerts.every((alert) => alert.count === 1)).toBe(true)
  })

  test('the other direction is a different sender and keeps its own row', () => {
    const alerts = computeAlerts([
      notification('10.10.0.2', '10.10.0.1', 0),
      notification('10.10.0.1', '10.10.0.2', 1),
    ])

    expect(alerts).toHaveLength(2)
  })
})

describe('alert ordering', () => {
  test('critical first, then the busiest row, then the most recent', () => {
    const alerts = computeAlerts([
      // Two peers each flapping a route, one worse than the other.
      announce('192.0.2.1', 0, '10.0.1.0/24'),
      withdraw('192.0.2.1', 1, '10.0.1.0/24'),
      announce('192.0.2.1', 2, '10.0.2.0/24'),
      withdraw('192.0.2.1', 3, '10.0.2.0/24'),
      announce('192.0.2.1', 4, '10.0.2.0/24'),
      withdraw('192.0.2.1', 5, '10.0.2.0/24'),
      // A repeated NOTIFICATION, which must still outrank every warning.
      notification('10.10.0.2', '10.10.0.1', 6),
      notification('10.10.0.2', '10.10.0.1', 7),
    ])

    expect(alerts[0].severity).toBe('critical')
    expect(alerts[1].id).toBe('route-flap-10.0.2.0/24')
    expect(alerts[2].id).toBe('route-flap-10.0.1.0/24')
  })

  test('the session flap row survives the count-aware sort', () => {
    const alerts = computeAlerts([
      open('10.10.0.1', '10.10.0.2', 0),
      open('10.10.0.2', '10.10.0.1', 1),
      open('10.10.0.1', '10.10.0.2', 2),
      open('10.10.0.2', '10.10.0.1', 3),
    ])

    const flap = byId(alerts, 'flap-')[0]
    expect(flap.detail).toBe('10.10.0.1 ↔ 10.10.0.2 — 4 OPEN messages (~2 establishments)')
    expect(flap.count).toBeUndefined()
  })
})

describe('route-level alerts', () => {
  test('a prefix withdrawn and re-announced is reported even though sessions are healthy', () => {
    const alerts = computeAlerts([
      announce('10.10.0.2', 0, '192.168.2.0/24'),
      withdraw('10.10.0.2', 1, '192.168.2.0/24'),
      announce('10.10.0.2', 3, '192.168.2.0/24', [65002, 65002, 65002]),
    ])

    const flap = byId(alerts, 'route-flap-')[0]
    expect(flap.severity).toBe('warning')
    expect(flap.title).toBe('Route flapping: 192.168.2.0/24')
    expect(flap.filter).toBe('prefix = 192.168.2.0/24')
    expect(flap.packetIndex).toBe(1) // the withdraw, where the route went away
    expect(flap.count).toBe(1)
    expect(flap.timeSpan).toBeUndefined()
  })

  test('a prepended re-announcement is reported as an AS_PATH change', () => {
    const alerts = computeAlerts([
      announce('10.10.0.2', 0, '192.168.2.0/24', [65002]),
      withdraw('10.10.0.2', 1, '192.168.2.0/24'),
      announce('10.10.0.2', 3, '192.168.2.0/24', [65002, 65002, 65002]),
    ])

    const changed = byId(alerts, 'route-aspath-')[0]
    expect(changed.severity).toBe('warning')
    expect(changed.title).toBe('AS_PATH changed: 192.168.2.0/24')
    // Prepending reads as a count here and on the routes screen alike, so the
    // number of prepends is the thing on screen rather than something to count.
    expect(changed.detail).toBe('65002 → 65002×3')
    expect(changed.filter).toBe('prefix = 192.168.2.0/24')
    expect(changed.packetIndex).toBe(2) // the announcement that differs
    expect(changed.count).toBe(2)
  })

  test('a stable route announced by many peers with one path raises nothing', () => {
    const alerts = computeAlerts([
      announce('192.0.2.1', 0, '10.0.12.0/24'),
      announce('192.0.2.2', 1, '10.0.12.0/24'),
      announce('192.0.2.3', 2, '10.0.12.0/24'),
    ])

    expect(alerts).toEqual([])
  })

  test('a repeatedly flapping prefix reports its span and its worst-first count', () => {
    const alerts = computeAlerts([
      announce('192.0.2.1', 0, '10.0.12.0/24'),
      withdraw('192.0.2.1', 1, '10.0.12.0/24'),
      announce('192.0.2.1', 2, '10.0.12.0/24'),
      withdraw('192.0.2.1', 9, '10.0.12.0/24'),
    ])

    const flap = byId(alerts, 'route-flap-')[0]
    expect(flap.count).toBe(2)
    expect(flap.detail).toBe('2 announcements, 2 withdrawals')
    expect(flap.timeSpan).toEqual({ start: at(1), end: at(9) })
  })

  test('only the worst five flapping prefixes get a row, the rest are summarised', () => {
    const packets: BgpPacket[] = []
    // Seven prefixes, flapping progressively less, so the cut is unambiguous.
    for (let i = 0; i < 7; i++) {
      for (let cycle = 0; cycle <= 7 - i; cycle++) {
        packets.push(announce('192.0.2.1', packets.length, `10.0.${i}.0/24`))
        packets.push(withdraw('192.0.2.1', packets.length, `10.0.${i}.0/24`))
      }
    }

    const alerts = computeAlerts(packets)
    const rows = byId(alerts, 'route-flap-').filter((alert) => alert.id !== 'route-flap-more')
    expect(rows).toHaveLength(5)
    expect(rows.map((alert) => alert.title)).toEqual([
      'Route flapping: 10.0.0.0/24',
      'Route flapping: 10.0.1.0/24',
      'Route flapping: 10.0.2.0/24',
      'Route flapping: 10.0.3.0/24',
      'Route flapping: 10.0.4.0/24',
    ])

    const summary = alerts.find((alert) => alert.id === 'route-flap-more')
    expect(summary?.title).toBe('2 more prefixes flapped')
  })

  test('a withdrawn route never seen announced flaps but has no path change', () => {
    // The capture started mid-session: the route was up before it began.
    const alerts = computeAlerts([withdraw('192.0.2.1', 0, '10.0.12.0/24')])

    expect(byId(alerts, 'route-flap-')).toHaveLength(1)
    expect(byId(alerts, 'route-aspath-')).toHaveLength(0)
  })
})
