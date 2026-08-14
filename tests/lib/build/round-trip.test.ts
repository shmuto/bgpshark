/**
 * The builder is checked by reading its output back through the real parsers.
 *
 * Comparing bytes against a hand-written expectation would only restate the
 * encoder; feeding the file to `parsePcap` and `parseBgpFromPackets` asks the
 * question that matters — does the capture this produced decode into the
 * session it was asked to describe? It also means an encoder and a decoder can
 * never drift apart quietly, because a change to either breaks this.
 */
import { describe, expect, test } from 'bun:test'
import { buildScenario, type Scenario } from '../../../src/lib/build/scenario'
import { encodeMessage } from '../../../src/lib/build/bgp-encode'
import { PRESETS, announce, withdraw } from '../../../src/lib/build/presets'
import { parsePcap } from '../../../src/lib/pcap/parser'
import { parseBgpFromPackets } from '../../../src/lib/bgp/parser'
import { endOfRibMarker } from '../../../src/lib/bgp/update'
import { LinkLayerType } from '../../../src/lib/pcap/types'
import { Afi, Safi } from '../../../src/lib/bgp/constants'
import type {
  BgpMessage,
  BgpOpenMessage,
  BgpUpdateMessage,
  BgpNotificationMessage,
} from '../../../src/lib/bgp/types'

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Build a scenario and decode it back the way the app would. */
function roundTrip(scenario: Scenario) {
  const built = buildScenario(scenario)
  const pcap = parsePcap(toArrayBuffer(built.bytes))
  const bgp = parseBgpFromPackets(pcap.packets)

  return {
    built,
    pcap,
    bgp,
    messages: bgp.packets.flatMap((packet) => packet.messages),
  }
}

const PEER_A = { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1' }
const PEER_B = { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2' }

function session(steps: Scenario['steps'], overrides: Partial<Scenario> = {}): Scenario {
  return { a: PEER_A, b: PEER_B, steps, ...overrides }
}

function firstOfType<T extends BgpMessage['type']>(
  messages: BgpMessage[],
  type: T
): Extract<BgpMessage, { type: T }> {
  const found = messages.find((message) => message.type === type)
  if (!found) throw new Error(`No ${type} in the decoded capture`)
  return found as Extract<BgpMessage, { type: T }>
}

describe('the file a scenario produces', () => {
  test('is a pcap the parser accepts, with no warnings or errors', () => {
    const { pcap } = roundTrip(session([{ kind: 'handshake' }, { kind: 'open', from: 'a' }]))

    expect(pcap.errors).toEqual([])
    expect(pcap.warnings).toEqual([])
    expect(pcap.globalHeader.linkType).toBe(LinkLayerType.ETHERNET)
  })

  test('carries the TCP handshake as three frames with the right flags', () => {
    const { pcap } = roundTrip(session([{ kind: 'handshake' }]))

    expect(pcap.allPackets).toHaveLength(3)
    expect(pcap.allPackets.map((p) => p.tcpFlags)).toMatchObject([
      { syn: true, ack: false },
      { syn: true, ack: true },
      { syn: false, ack: true },
    ])
  })

  test('numbers the TCP conversation so both ends agree', () => {
    // The handshake's third frame acknowledges the SYN-ACK, and the first data
    // segment carries the sequence number that follows from it. Getting this
    // wrong is invisible to this app's parser but obvious in Wireshark.
    const built = buildScenario(session([{ kind: 'handshake' }, { kind: 'keepalive', from: 'a' }]))
    const frames = built.frames.map((frame) => readTcp(frame.frameBytes))

    const [syn, synAck, ack, keepalive] = frames

    expect(synAck.ack).toBe(syn.seq + 1)
    expect(ack.seq).toBe(syn.seq + 1)
    expect(ack.ack).toBe(synAck.seq + 1)
    expect(keepalive.seq).toBe(ack.seq)
    expect(keepalive.payloadLength).toBe(19)
  })

  test('advances timestamps in the order the steps were written', () => {
    const { built } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a', gap: 500 },
        { kind: 'delay', gap: 30_000 },
        { kind: 'keepalive', from: 'a' },
      ])
    )

    const times = built.frames.map((frame) => frame.timestamp.getTime())
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
    }
    expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(30_000)
  })
})

describe('OPEN', () => {
  test('round-trips its AS, hold time, router ID and capabilities', () => {
    const { messages } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
      ], {
        a: {
          ...PEER_A,
          holdTime: 180,
          capabilities: [
            { type: 'MULTIPROTOCOL', afi: Afi.IPV4, safi: Safi.UNICAST },
            { type: 'ROUTE_REFRESH' },
            { type: 'FOUR_OCTET_AS', asNumber: PEER_A.as },
            { type: 'GRACEFUL_RESTART', restartTime: 120, addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST }] },
          ],
        },
      })
    )

    const open = firstOfType(messages, 'OPEN') as BgpOpenMessage
    expect(open.version).toBe(4)
    expect(open.myAs).toBe(65001)
    expect(open.holdTime).toBe(180)
    expect(open.bgpIdentifier).toBe('1.1.1.1')

    expect(open.capabilities.map((c) => c.parsed?.type)).toEqual([
      'MULTIPROTOCOL',
      'ROUTE_REFRESH',
      'FOUR_OCTET_AS',
      'GRACEFUL_RESTART',
    ])

    const gracefulRestart = open.capabilities[3].parsed
    expect(gracefulRestart).toMatchObject({ type: 'GRACEFUL_RESTART', restartTime: 120 })
  })

  test('sends a 4-byte AS as AS_TRANS plus the capability, as RFC 6793 requires', () => {
    const { messages } = roundTrip(
      session([{ kind: 'handshake' }, { kind: 'open', from: 'a' }], {
        a: { ...PEER_A, as: 4_200_000_001 },
      })
    )

    const open = firstOfType(messages, 'OPEN') as BgpOpenMessage
    expect(open.myAs).toBe(23456)
    expect(open.fourByteAs).toBe(4_200_000_001)
  })
})

describe('UPDATE', () => {
  test('round-trips NLRI, withdrawals and path attributes', () => {
    const { messages } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
        { kind: 'open', from: 'b' },
        {
          kind: 'send',
          from: 'a',
          messages: [
            announce(['10.1.0.0/24', '192.168.4.0/22', '172.16.0.0/12'], {
              nextHop: '10.0.0.1',
              asPath: [65001, 65100],
              med: 50,
              communities: ['65001:100', 'NO_EXPORT'],
            }),
            withdraw(['10.9.9.0/24']),
          ],
        },
      ])
    )

    const updates = messages.filter((m): m is BgpUpdateMessage => m.type === 'UPDATE')
    expect(updates).toHaveLength(2)

    const [advertisement, withdrawal] = updates

    expect(advertisement.nlri.map((p) => `${p.prefix}/${p.length}`)).toEqual([
      '10.1.0.0/24',
      '192.168.4.0/22',
      '172.16.0.0/12',
    ])

    const attributes = Object.fromEntries(
      advertisement.pathAttributes.map((attr) => [attr.typeName, attr.parsed])
    )
    expect(attributes.ORIGIN).toEqual({ type: 'ORIGIN', value: 'IGP' })
    expect(attributes.AS_PATH).toEqual({
      type: 'AS_PATH',
      segments: [{ type: 'AS_SEQUENCE', asNumbers: [65001, 65100] }],
    })
    expect(attributes.NEXT_HOP).toEqual({ type: 'NEXT_HOP', address: '10.0.0.1' })
    expect(attributes.MULTI_EXIT_DISC).toEqual({ type: 'MULTI_EXIT_DISC', value: 50 })
    expect(attributes.COMMUNITIES).toEqual({
      type: 'COMMUNITIES',
      communities: ['65001:100', 'NO_EXPORT'],
    })

    expect(withdrawal.withdrawnRoutes.map((p) => `${p.prefix}/${p.length}`)).toEqual(['10.9.9.0/24'])
  })

  test('round-trips an empty AS_PATH, as an iBGP-originated route carries', () => {
    const { messages, bgp } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
        { kind: 'open', from: 'b' },
        {
          kind: 'send',
          from: 'a',
          messages: [
            {
              type: 'UPDATE',
              pathAttributes: [
                { type: 'ORIGIN', value: 'IGP' },
                { type: 'AS_PATH', segments: [] },
                { type: 'NEXT_HOP', address: '10.0.0.1' },
                { type: 'LOCAL_PREF', value: 100 },
              ],
              nlri: ['10.1.0.0/24'],
            },
          ],
        },
      ])
    )

    const update = firstOfType(messages, 'UPDATE') as BgpUpdateMessage
    const asPath = update.pathAttributes.find((a) => a.typeName === 'AS_PATH')
    expect(asPath?.length).toBe(0)
    expect(asPath?.parsed).toEqual({ type: 'AS_PATH', segments: [] })
    expect(update.pathAttributes.find((a) => a.typeName === 'LOCAL_PREF')?.parsed).toEqual({
      type: 'LOCAL_PREF',
      value: 100,
    })
    expect(bgp.warnings).toEqual([])
  })

  test('writes AS_PATH at the width the OPENs negotiated', () => {
    // Neither peer advertises the 4-byte AS capability, so AS_PATH is 2-byte —
    // and the parser, seeing the same OPENs, reads it back that way.
    const twoByte = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
        { kind: 'open', from: 'b' },
        {
          kind: 'send',
          from: 'a',
          messages: [announce(['10.1.0.0/24'], { nextHop: '10.0.0.1', asPath: [65001, 65100] })],
        },
      ], {
        a: { ...PEER_A, capabilities: [{ type: 'ROUTE_REFRESH' }] },
        b: { ...PEER_B, capabilities: [{ type: 'ROUTE_REFRESH' }] },
      })
    )

    const update = firstOfType(twoByte.messages, 'UPDATE') as BgpUpdateMessage
    const asPath = update.pathAttributes.find((a) => a.typeName === 'AS_PATH')
    expect(asPath?.length).toBe(2 + 2 * 2) // segment header plus two 2-byte AS numbers
    expect(asPath?.parsed).toEqual({
      type: 'AS_PATH',
      segments: [{ type: 'AS_SEQUENCE', asNumbers: [65001, 65100] }],
    })
    expect(twoByte.bgp.warnings).toEqual([])
  })

  test('round-trips a 4-byte AS_PATH when both ends advertised the capability', () => {
    const { messages, bgp } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
        { kind: 'open', from: 'b' },
        {
          kind: 'send',
          from: 'a',
          messages: [
            announce(['172.16.0.0/16'], { nextHop: '10.0.0.1', asPath: [4_200_000_001, 4_200_000_009] }),
          ],
        },
      ], {
        a: { ...PEER_A, as: 4_200_000_001 },
        b: { ...PEER_B, as: 4_200_000_002 },
      })
    )

    const update = firstOfType(messages, 'UPDATE') as BgpUpdateMessage
    expect(update.pathAttributes.find((a) => a.typeName === 'AS_PATH')?.parsed).toEqual({
      type: 'AS_PATH',
      segments: [{ type: 'AS_SEQUENCE', asNumbers: [4_200_000_001, 4_200_000_009] }],
    })
    expect(bgp.warnings).toEqual([])
  })

  test('round-trips IPv6 routes over an IPv6 session', () => {
    const { messages, pcap } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
        { kind: 'open', from: 'b' },
        {
          kind: 'send',
          from: 'a',
          messages: [
            {
              type: 'UPDATE',
              pathAttributes: [
                { type: 'ORIGIN', value: 'IGP' },
                { type: 'AS_PATH', segments: [{ asNumbers: [64501] }] },
                {
                  type: 'MP_REACH_NLRI',
                  afi: Afi.IPV6,
                  safi: Safi.UNICAST,
                  nextHop: '2001:db8::1',
                  nlri: ['2001:db8:1::/48'],
                },
              ],
            },
          ],
        },
      ], {
        a: { ip: '2001:db8::1', as: 64501, routerId: '10.0.0.1' },
        b: { ip: '2001:db8::2', as: 64502, routerId: '10.0.0.2' },
      })
    )

    expect(pcap.errors).toEqual([])
    expect(pcap.allPackets[0].srcIp).toBe('2001:db8::1')

    const update = firstOfType(messages, 'UPDATE') as BgpUpdateMessage
    const mpReach = update.pathAttributes.find((a) => a.typeName === 'MP_REACH_NLRI')?.parsed
    // The BGP reader writes addresses out uncompressed, so the next hop comes
    // back as `2001:db8:0:0:0:0:0:1` rather than the form it was written from.
    expect(mpReach).toMatchObject({
      type: 'MP_REACH_NLRI',
      afiName: 'IPv6',
      safiName: 'Unicast',
      nextHop: '2001:db8:0:0:0:0:0:1',
    })
    expect(mpReach?.type === 'MP_REACH_NLRI' && mpReach.nlri).toEqual([
      { prefix: '2001:db8:1:0:0:0:0:0', length: 48 },
    ])
  })

  test('writes an End-of-RIB the analyzer recognises', () => {
    const { messages } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
        { kind: 'open', from: 'b' },
        { kind: 'send', from: 'a', messages: [{ type: 'UPDATE' }] },
      ])
    )

    const update = firstOfType(messages, 'UPDATE') as BgpUpdateMessage
    expect(endOfRibMarker(update)).toBe('IPv4 Unicast')
  })

  test('puts Path Identifiers on NLRI when both ends negotiated ADD-PATH', () => {
    const addPath = {
      type: 'ADD_PATH' as const,
      addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST, sendReceive: 'both' as const }],
    }

    const { messages, bgp } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
        { kind: 'open', from: 'b' },
        {
          kind: 'send',
          from: 'a',
          messages: [
            {
              type: 'UPDATE',
              pathAttributes: [
                { type: 'ORIGIN', value: 'IGP' },
                { type: 'AS_PATH', segments: [{ asNumbers: [65001] }] },
                { type: 'NEXT_HOP', address: '10.0.0.1' },
              ],
              nlri: [
                { prefix: '10.1.0.0/24', pathId: 1 },
                { prefix: '10.1.0.0/24', pathId: 2 },
              ],
            },
          ],
        },
      ], {
        a: { ...PEER_A, capabilities: [{ type: 'FOUR_OCTET_AS', asNumber: 65001 }, addPath] },
        b: { ...PEER_B, capabilities: [{ type: 'FOUR_OCTET_AS', asNumber: 65002 }, addPath] },
      })
    )

    // Both copies of the prefix survive *and* keep the identifier that tells
    // them apart, which they only can if the writer put Path Identifiers on and
    // the reader both expected them and kept them.
    const update = firstOfType(messages, 'UPDATE') as BgpUpdateMessage
    expect(update.nlri).toEqual([
      { prefix: '10.1.0.0', length: 24, pathId: 1 },
      { prefix: '10.1.0.0', length: 24, pathId: 2 },
    ])
    expect(bgp.warnings).toEqual([])
  })
})

describe('NOTIFICATION and teardown', () => {
  test('round-trips the error code, subcode and its explanation', () => {
    const { messages } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
        { kind: 'send', from: 'b', messages: [{ type: 'NOTIFICATION', errorCode: 2, errorSubcode: 2 }] },
        { kind: 'close', from: 'b' },
      ])
    )

    const notification = firstOfType(messages, 'NOTIFICATION') as BgpNotificationMessage
    expect(notification.errorCode).toBe(2)
    expect(notification.errorSubcode).toBe(2)
    expect(notification.errorCodeName).toBe('OPEN Message Error')
    expect(notification.errorSubcodeName).toBe('Bad Peer AS')
  })

  test('closes the connection with a FIN exchange', () => {
    const { pcap } = roundTrip(session([{ kind: 'handshake' }, { kind: 'close', from: 'a' }]))

    expect(pcap.allPackets.slice(3).map((p) => p.tcpFlags)).toMatchObject([
      { fin: true, ack: true },
      { fin: false, ack: true },
      { fin: true, ack: true },
      { fin: false, ack: true },
    ])
  })

  test('a reset leaves TCP frames and no BGP at all', () => {
    const { pcap, bgp } = roundTrip(
      session([{ kind: 'handshake' }, { kind: 'reset', from: 'b' }])
    )

    expect(bgp.packets).toEqual([])
    expect(pcap.allPackets).toHaveLength(4)
    expect(pcap.allPackets[3].tcpFlags).toMatchObject({ rst: true })
  })
})

describe('TCP segmentation', () => {
  test('reassembles a message that a small MTU split across segments', () => {
    const prefixes = Array.from({ length: 300 }, (_, i) => `10.${(i >> 8) & 0xff}.${i & 0xff}.0/24`)

    const { built, messages, bgp } = roundTrip(
      session([
        { kind: 'handshake' },
        { kind: 'open', from: 'a' },
        { kind: 'open', from: 'b' },
        {
          kind: 'send',
          from: 'a',
          messages: [announce(prefixes, { nextHop: '10.0.0.1', asPath: [65001] })],
        },
      ], { mtu: 576 })
    )

    // The advertisement is larger than one segment at this MTU, so it must have
    // gone out as several — and come back as one message.
    const dataFrames = built.frames.filter((frame) => frame.frameBytes.length > 576 - 40)
    expect(dataFrames.length).toBeGreaterThan(1)

    const update = firstOfType(messages, 'UPDATE') as BgpUpdateMessage
    expect(update.nlri).toHaveLength(300)
    expect(update.nlri[299]).toEqual({ prefix: '10.1.43.0', length: 24 })
    expect(bgp.warnings).toEqual([])
  })

  test('refuses to build a message past the 4096-byte BGP maximum', () => {
    const tooMany = Array.from({ length: 1200 }, (_, i) => `10.${(i >> 8) & 0xff}.${i & 0xff}.0/24`)

    expect(() =>
      encodeMessage(announce(tooMany, { nextHop: '10.0.0.1', asPath: [65001] }))
    ).toThrow(/4096/)
  })
})

describe('link layers', () => {
  test('builds a Linux SLL capture', () => {
    const { pcap } = roundTrip(
      session([{ kind: 'handshake' }, { kind: 'open', from: 'a' }], {
        linkType: LinkLayerType.SLL,
      })
    )

    expect(pcap.globalHeader.linkType).toBe(LinkLayerType.SLL)
    expect(pcap.errors).toEqual([])
    expect(pcap.allPackets[0].srcIp).toBe('10.0.0.1')
  })

  test('builds a QinQ-tagged capture the parser sees through', () => {
    const { messages, pcap } = roundTrip(
      session([{ kind: 'handshake' }, { kind: 'open', from: 'a' }], {
        vlanIds: [100, 200],
      })
    )

    expect(pcap.errors).toEqual([])
    expect(firstOfType(messages, 'OPEN').type).toBe('OPEN')
  })
})

describe('presets', () => {
  test.each(PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s builds a capture that parses cleanly',
    (_id, preset) => {
      const { pcap, bgp } = roundTrip(preset.build())

      expect(pcap.errors).toEqual([])
      expect(pcap.warnings).toEqual([])
      expect(bgp.warnings).toEqual([])
      expect(pcap.allPackets.length).toBeGreaterThan(0)
    }
  )

  test('the TCP-rejected preset produces no BGP, which is the point of it', () => {
    const { bgp, pcap } = roundTrip(PRESETS.find((p) => p.id === 'connection-refused')!.build())

    expect(bgp.packets).toEqual([])
    expect(pcap.allPackets.filter((p) => p.tcpFlags?.rst)).toHaveLength(3)
  })

  test('the flap preset announces and withdraws the same prefix repeatedly', () => {
    const { messages } = roundTrip(PRESETS.find((p) => p.id === 'flap')!.build())

    const updates = messages.filter((m): m is BgpUpdateMessage => m.type === 'UPDATE')
    const announced = updates.filter((u) =>
      u.nlri.some((p) => `${p.prefix}/${p.length}` === '10.9.9.0/24')
    )
    const withdrawn = updates.filter((u) =>
      u.withdrawnRoutes.some((p) => `${p.prefix}/${p.length}` === '10.9.9.0/24')
    )

    expect(announced).toHaveLength(5)
    expect(withdrawn).toHaveLength(5)
  })

  test('building the same preset twice produces identical bytes', () => {
    // Fixed initial sequence numbers and a fixed start time, so a capture can
    // be regenerated and diffed rather than only looked at.
    const first = buildScenario(PRESETS[0].build()).bytes
    const second = buildScenario(PRESETS[0].build()).bytes

    expect(Array.from(first)).toEqual(Array.from(second))
  })
})

/** Pull the TCP fields back out of a built Ethernet/IPv4 frame. */
function readTcp(frame: Uint8Array): {
  seq: number
  ack: number
  payloadLength: number
} {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const ipOffset = 14
  const ipHeaderLength = (frame[ipOffset] & 0x0f) * 4
  const totalLength = view.getUint16(ipOffset + 2)
  const tcpOffset = ipOffset + ipHeaderLength
  const dataOffset = ((view.getUint16(tcpOffset + 12) >> 12) & 0x0f) * 4

  return {
    seq: view.getUint32(tcpOffset + 4),
    ack: view.getUint32(tcpOffset + 8),
    payloadLength: totalLength - ipHeaderLength - dataOffset,
  }
}
