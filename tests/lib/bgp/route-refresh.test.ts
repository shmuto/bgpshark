import { describe, test, expect } from 'bun:test'
import { routeRefreshDiff } from '../../../src/lib/bgp/route-refresh'
import type { BgpMessage, BgpPacket } from '../../../src/lib/bgp/types'

/**
 * What a route refresh changed, which is the only reason anyone sends one.
 *
 * Two things here are easy to get backwards and both have a test of their own.
 * The refresh travels one way and the answer the other, so the RIB being
 * compared belongs to the message's *destination*. And a route the peer no
 * longer has is simply absent from the re-advertisement rather than withdrawn,
 * so "removed" cannot be read from withdrawals — which is exactly the "my soft
 * clear lost routes" complaint the scenario is about.
 */
function at(second: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + second * 1000)
}

function packet(srcIp: string, dstIp: string, second: number, messages: BgpMessage[]): BgpPacket {
  return {
    frameIndex: second,
    timestamp: at(second),
    srcIp,
    dstIp,
    srcPort: srcIp === '10.0.0.2' ? 179 : 51000,
    dstPort: srcIp === '10.0.0.2' ? 51000 : 179,
    messages,
    rawData: new Uint8Array(),
    parseWarnings: [],
  } as unknown as BgpPacket
}

function attribute(parsed: unknown) {
  return {
    flags: { optional: false, transitive: true, partial: false, extendedLength: false },
    typeCode: 0,
    typeName: (parsed as { type: string }).type,
    length: 0,
    rawValue: new Uint8Array(),
    parsed,
  }
}

/** An UPDATE announcing one prefix, optionally tagged. */
function announce(
  prefix: string,
  options: { communities?: string[]; asPath?: number[]; med?: number } = {}
): BgpMessage {
  const [address, length] = prefix.split('/')
  const attributes: unknown[] = [
    attribute({
      type: 'AS_PATH',
      segments: [{ type: 'AS_SEQUENCE', asNumbers: options.asPath ?? [65001] }],
    }),
    attribute({ type: 'NEXT_HOP', address: '10.0.0.1' }),
  ]
  if (options.communities) {
    attributes.push(attribute({ type: 'COMMUNITIES', communities: options.communities }))
  }
  if (options.med !== undefined) {
    attributes.push(attribute({ type: 'MULTI_EXIT_DISC', value: options.med }))
  }

  return {
    type: 'UPDATE',
    withdrawnRoutesLength: 0,
    withdrawnRoutes: [],
    totalPathAttrLength: 0,
    pathAttributes: attributes,
    nlri: [{ prefix: address, length: Number(length) }],
  } as unknown as BgpMessage
}

/** RFC 4724's End-of-RIB: an UPDATE with nothing in it. */
const endOfRib: BgpMessage = {
  type: 'UPDATE',
  withdrawnRoutesLength: 0,
  withdrawnRoutes: [],
  totalPathAttrLength: 0,
  pathAttributes: [],
  nlri: [],
} as unknown as BgpMessage

const open: BgpMessage = {
  type: 'OPEN',
  version: 4,
  myAs: 65001,
  holdTime: 90,
  bgpIdentifier: '1.1.1.1',
  capabilities: [],
} as unknown as BgpMessage

const refresh: BgpMessage = {
  type: 'ROUTE_REFRESH',
  afi: 1,
  safi: 1,
  afiName: 'IPv4',
  safiName: 'Unicast',
} as unknown as BgpMessage

const A = '10.0.0.1'
const B = '10.0.0.2'

/** The index of the one ROUTE-REFRESH in a capture. */
function refreshIndex(packets: BgpPacket[]): number {
  return packets.findIndex((p) => p.messages.some((m) => m.type === 'ROUTE_REFRESH'))
}

describe('what a route refresh changed', () => {
  test('a route that came back tagged is reported as added', () => {
    // The scenario itself: A announces one prefix, B asks for a refresh, and A
    // sends back the original plus one more carrying a community.
    const packets = [
      packet(A, B, 0, [open]),
      packet(A, B, 1, [announce('10.1.0.0/24'), endOfRib]),
      packet(B, A, 2, [refresh]),
      packet(A, B, 3, [
        announce('10.1.0.0/24'),
        announce('10.1.1.0/24', { communities: ['65001:999'] }),
        endOfRib,
      ]),
    ]

    const diff = routeRefreshDiff(packets, refreshIndex(packets))!
    expect(diff).not.toBeNull()
    // The refresh went to A, so it is A's table being compared.
    expect(diff.peer).toBe(A)
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0].key).toBe('10.1.1.0/24')
    expect(diff.added[0].detail).toContain('65001:999')
    expect(diff.unchanged).toBe(1)
    expect(diff.removed).toHaveLength(0)
    expect(diff.beforeIncomplete).toBe(false)
    expect(diff.afterIncomplete).toBe(false)
  })

  test('a route that did not come back is reported, though nothing withdrew it', () => {
    // The complaint the whole feature exists for. After a refresh the peer
    // re-sends its table; a route it no longer has is absent rather than
    // withdrawn, so reading withdrawals would find nothing wrong here.
    const packets = [
      packet(A, B, 0, [open]),
      packet(A, B, 1, [announce('10.1.0.0/24'), announce('10.2.0.0/24'), endOfRib]),
      packet(B, A, 2, [refresh]),
      packet(A, B, 3, [announce('10.1.0.0/24'), endOfRib]),
    ]

    const diff = routeRefreshDiff(packets, refreshIndex(packets))!
    expect(diff.removed).toHaveLength(1)
    expect(diff.removed[0].key).toBe('10.2.0.0/24')
    expect(diff.added).toHaveLength(0)
    expect(diff.unchanged).toBe(1)
  })

  test('a route whose attributes moved is neither added nor removed', () => {
    const packets = [
      packet(A, B, 0, [open]),
      packet(A, B, 1, [announce('10.1.0.0/24', { med: 100 }), endOfRib]),
      packet(B, A, 2, [refresh]),
      packet(A, B, 3, [
        announce('10.1.0.0/24', { med: 50, communities: ['65001:1'] }),
        endOfRib,
      ]),
    ]

    const diff = routeRefreshDiff(packets, refreshIndex(packets))!
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0].detail).toContain('MED 100 → 50')
    expect(diff.changed[0].detail).toContain('community 65001:1 added')
  })

  test('the comparison is of the destination’s table, not the sender’s', () => {
    // A refresh sent by B asks *A* to re-advertise. Reading it the other way
    // round compares B's own announcements and finds nothing, on every capture.
    const packets = [
      packet(A, B, 0, [open]),
      packet(B, A, 1, [announce('192.168.0.0/24'), endOfRib]),
      packet(A, B, 2, [announce('10.1.0.0/24'), endOfRib]),
      packet(B, A, 3, [refresh]),
      packet(A, B, 4, [announce('10.1.0.0/24'), announce('10.9.0.0/24'), endOfRib]),
    ]

    const diff = routeRefreshDiff(packets, refreshIndex(packets))!
    expect(diff.peer).toBe(A)
    expect(diff.added.map((change) => change.key)).toEqual(['10.9.0.0/24'])
  })

  test('an End-of-RIB is a marker, not an empty route', () => {
    const packets = [
      packet(A, B, 0, [open]),
      packet(A, B, 1, [announce('10.1.0.0/24'), endOfRib]),
      packet(B, A, 2, [refresh]),
      packet(A, B, 3, [announce('10.1.0.0/24'), endOfRib]),
    ]

    const diff = routeRefreshDiff(packets, refreshIndex(packets))!
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.unchanged).toBe(1)
  })

  test('a capture that missed the session starting says the before side is partial', () => {
    // Without the OPEN there is no telling whether the "before" set is the
    // peer's table or just the part of it the capture caught, and a removal
    // drawn from it may be a route that was announced before recording began.
    const packets = [
      packet(A, B, 1, [announce('10.1.0.0/24')]),
      packet(B, A, 2, [refresh]),
      packet(A, B, 3, [announce('10.1.0.0/24'), endOfRib]),
    ]

    expect(routeRefreshDiff(packets, refreshIndex(packets))!.beforeIncomplete).toBe(true)
  })

  test('a re-advertisement with no End-of-RIB says the after side is partial', () => {
    // Everything not yet re-sent looks removed, which would be a confident and
    // wrong answer if the panel did not say so.
    const packets = [
      packet(A, B, 0, [open]),
      packet(A, B, 1, [announce('10.1.0.0/24'), announce('10.2.0.0/24'), endOfRib]),
      packet(B, A, 2, [refresh]),
      packet(A, B, 3, [announce('10.1.0.0/24')]),
    ]

    const diff = routeRefreshDiff(packets, refreshIndex(packets))!
    expect(diff.afterIncomplete).toBe(true)
    expect(diff.removed).toHaveLength(1)
  })

  test('each refresh compares its own interval', () => {
    // Selecting the message is how a capture with several of them picks which
    // interval to look at, so each has to answer for itself rather than for the
    // capture as a whole.
    const packets = [
      packet(A, B, 0, [open]),
      packet(A, B, 1, [announce('10.1.0.0/24'), endOfRib]),
      packet(B, A, 2, [refresh]),
      packet(A, B, 3, [announce('10.1.0.0/24'), announce('10.2.0.0/24'), endOfRib]),
      packet(B, A, 4, [refresh]),
      packet(A, B, 5, [announce('10.1.0.0/24'), endOfRib]),
    ]

    const first = routeRefreshDiff(packets, 2)!
    expect(first.added.map((change) => change.key)).toEqual(['10.2.0.0/24'])

    // The second refresh sees the route the first one added, and loses it.
    const second = routeRefreshDiff(packets, 4)!
    expect(second.added).toHaveLength(0)
    expect(second.removed.map((change) => change.key)).toEqual(['10.2.0.0/24'])
  })

  test('a packet that is not a route refresh has nothing to say', () => {
    const packets = [packet(A, B, 0, [open]), packet(A, B, 1, [announce('10.1.0.0/24')])]

    expect(routeRefreshDiff(packets, 0)).toBeNull()
    expect(routeRefreshDiff(packets, 1)).toBeNull()
    expect(routeRefreshDiff(packets, 99)).toBeNull()
  })
})
