import { describe, test, expect } from 'bun:test'
import { parseBgpFromPackets } from '../../../src/lib/bgp/parser'
import type { RawPacket } from '../../../src/lib/pcap/types'
import type {
  BgpOpenMessage,
  BgpNotificationMessage,
  BgpKeepaliveMessage,
  BgpUpdateMessage,
} from '../../../src/lib/bgp/types'

/**
 * Create a BGP message with marker
 */
function createBgpMessage(type: number, body: number[]): Uint8Array {
  const marker = new Array(16).fill(0xff)
  const length = 19 + body.length
  const header = [
    ...marker,
    (length >> 8) & 0xff,
    length & 0xff,
    type,
  ]
  return new Uint8Array([...header, ...body])
}

/**
 * Create a raw packet for testing
 */
function createRawPacket(tcpPayload: Uint8Array, frameIndex = 1): RawPacket {
  return {
    frameIndex,
    timestamp: new Date('2024-01-01T00:00:00Z'),
    capturedLength: tcpPayload.length,
    originalLength: tcpPayload.length,
    srcIp: '192.168.1.1',
    dstIp: '192.168.1.2',
    srcPort: 12345,
    dstPort: 179,
    tcpPayload,
    tcpFlags: {
      fin: false,
      syn: false,
      rst: false,
      psh: true,
      ack: true,
      urg: false,
    },
  }
}

describe('parseBgpFromPackets', () => {
  describe('OPEN message', () => {
    test('parses basic OPEN message', () => {
      // BGP OPEN: Version 4, AS 65001 (0xFDE9), Hold Time 90 (0x5A),
      // BGP ID 10.0.0.1, Opt Param Length 0
      const openBody = [
        0x04, // Version
        0xfd, 0xe9, // My AS (65001)
        0x00, 0x5a, // Hold Time (90)
        0x0a, 0x00, 0x00, 0x01, // BGP Identifier (10.0.0.1)
        0x00, // Optional Parameter Length
      ]
      const payload = createBgpMessage(1, openBody)
      const rawPacket = createRawPacket(payload)

      const result = parseBgpFromPackets([rawPacket])

      expect(result.packets).toHaveLength(1)
      const message = result.packets[0].messages[0] as BgpOpenMessage
      expect(message.type).toBe('OPEN')
      expect(message.version).toBe(4)
      expect(message.myAs).toBe(65001)
      expect(message.holdTime).toBe(90)
      expect(message.bgpIdentifier).toBe('10.0.0.1')
      expect(message.optParamLength).toBe(0)
    })

    test('parses OPEN with 4-byte AS capability', () => {
      // Optional params: Type 2 (Capabilities), Length 6
      // Capability: Code 65 (4-byte AS), Length 4, AS 4200000001
      const optParams = [
        0x02, 0x06, // Param Type 2, Length 6
        0x41, 0x04, // Cap Code 65, Length 4
        0xfa, 0x56, 0xea, 0x01, // AS 4200000001
      ]
      const openBody = [
        0x04, // Version
        0x5b, 0xa0, // My AS (23456 - AS_TRANS)
        0x00, 0xb4, // Hold Time (180)
        0xc0, 0xa8, 0x01, 0x01, // BGP ID (192.168.1.1)
        optParams.length, // Opt Param Length
        ...optParams,
      ]
      const payload = createBgpMessage(1, openBody)
      const rawPacket = createRawPacket(payload)

      const result = parseBgpFromPackets([rawPacket])

      expect(result.packets).toHaveLength(1)
      const message = result.packets[0].messages[0] as BgpOpenMessage
      expect(message.type).toBe('OPEN')
      expect(message.myAs).toBe(23456)
      expect(message.fourByteAs).toBe(4200000001)
      expect(message.capabilities).toHaveLength(1)
      expect(message.capabilities[0].code).toBe(65)
      expect(message.capabilities[0].name).toBe('4-byte AS Number')
    })

    test('parses OPEN with Multiprotocol capability', () => {
      // IPv4 Unicast: AFI 1, SAFI 1
      const optParams = [
        0x02, 0x06, // Param Type 2, Length 6
        0x01, 0x04, // Cap Code 1, Length 4
        0x00, 0x01, // AFI 1 (IPv4)
        0x00, // Reserved
        0x01, // SAFI 1 (Unicast)
      ]
      const openBody = [
        0x04, 0xfd, 0xe9, 0x00, 0x5a, 0x0a, 0x00, 0x00, 0x01,
        optParams.length,
        ...optParams,
      ]
      const payload = createBgpMessage(1, openBody)
      const rawPacket = createRawPacket(payload)

      const result = parseBgpFromPackets([rawPacket])

      const message = result.packets[0].messages[0] as BgpOpenMessage
      expect(message.capabilities).toHaveLength(1)
      expect(message.capabilities[0].code).toBe(1)
      expect(message.capabilities[0].parsed?.type).toBe('MULTIPROTOCOL')

      const mp = message.capabilities[0].parsed
      if (mp?.type === 'MULTIPROTOCOL') {
        expect(mp.afi).toBe(1)
        expect(mp.afiName).toBe('IPv4')
        expect(mp.safi).toBe(1)
        expect(mp.safiName).toBe('Unicast')
      }
    })

    test('parses OPEN with multiple capabilities', () => {
      // Multiple capabilities: Multiprotocol IPv4, Multiprotocol IPv6, Route Refresh, 4-byte AS
      const optParams = [
        0x02, 0x14, // Param Type 2, Length 20
        0x01, 0x04, 0x00, 0x01, 0x00, 0x01, // MP IPv4 Unicast
        0x01, 0x04, 0x00, 0x02, 0x00, 0x01, // MP IPv6 Unicast
        0x02, 0x00, // Route Refresh
        0x41, 0x04, 0x00, 0x01, 0x00, 0x01, // 4-byte AS 65537
      ]
      const openBody = [
        0x04, 0xfd, 0xe9, 0x00, 0x5a, 0x0a, 0x00, 0x00, 0x01,
        optParams.length,
        ...optParams,
      ]
      const payload = createBgpMessage(1, openBody)
      const rawPacket = createRawPacket(payload)

      const result = parseBgpFromPackets([rawPacket])

      const message = result.packets[0].messages[0] as BgpOpenMessage
      expect(message.capabilities).toHaveLength(4)
      expect(message.capabilities.map((c) => c.code)).toEqual([1, 1, 2, 65])
    })
  })

  describe('NOTIFICATION message', () => {
    test('parses basic NOTIFICATION', () => {
      // Error Code 6 (Cease), Subcode 2 (Administrative Shutdown)
      const notifBody = [0x06, 0x02]
      const payload = createBgpMessage(3, notifBody)
      const rawPacket = createRawPacket(payload)

      const result = parseBgpFromPackets([rawPacket])

      expect(result.packets).toHaveLength(1)
      const message = result.packets[0].messages[0] as BgpNotificationMessage
      expect(message.type).toBe('NOTIFICATION')
      expect(message.errorCode).toBe(6)
      expect(message.errorSubcode).toBe(2)
      expect(message.errorCodeName).toBe('Cease')
      expect(message.errorSubcodeName).toBe('Administrative Shutdown')
      expect(message.hint).toContain('administratively')
    })

    test('parses NOTIFICATION with data', () => {
      // Error Code 2 (OPEN Error), Subcode 2 (Bad Peer AS)
      // Data: the offending AS (65002 = 0xFDEA)
      const notifBody = [0x02, 0x02, 0xfd, 0xea]
      const payload = createBgpMessage(3, notifBody)
      const rawPacket = createRawPacket(payload)

      const result = parseBgpFromPackets([rawPacket])

      const message = result.packets[0].messages[0] as BgpNotificationMessage
      expect(message.errorCode).toBe(2)
      expect(message.errorSubcode).toBe(2)
      expect(message.data).toEqual(new Uint8Array([0xfd, 0xea]))
    })

    test('parses Hold Timer Expired', () => {
      const notifBody = [0x04, 0x00]
      const payload = createBgpMessage(3, notifBody)
      const rawPacket = createRawPacket(payload)

      const result = parseBgpFromPackets([rawPacket])

      const message = result.packets[0].messages[0] as BgpNotificationMessage
      expect(message.errorCodeName).toBe('Hold Timer Expired')
      expect(message.hint).toContain('KEEPALIVE')
    })
  })

  describe('KEEPALIVE message', () => {
    test('parses KEEPALIVE (no body)', () => {
      const payload = createBgpMessage(4, [])
      const rawPacket = createRawPacket(payload)

      const result = parseBgpFromPackets([rawPacket])

      expect(result.packets).toHaveLength(1)
      const message = result.packets[0].messages[0] as BgpKeepaliveMessage
      expect(message.type).toBe('KEEPALIVE')
    })
  })

  describe('UPDATE message', () => {
    test('parses basic UPDATE', () => {
      // Withdrawn Routes Length: 0
      // Total Path Attr Length: 0
      const updateBody = [0x00, 0x00, 0x00, 0x00]
      const payload = createBgpMessage(2, updateBody)
      const rawPacket = createRawPacket(payload)

      const result = parseBgpFromPackets([rawPacket])

      expect(result.packets).toHaveLength(1)
      const message = result.packets[0].messages[0] as BgpUpdateMessage
      expect(message.type).toBe('UPDATE')
      expect(message.withdrawnRoutesLength).toBe(0)
      expect(message.totalPathAttrLength).toBe(0)
    })

    test('what the UPDATE parser complains about reaches the packet', () => {
      // It used to go into a module-level array that nothing read, so every
      // warning the UPDATE parser produced — the prefix length checks, the
      // ADD-PATH ambiguity — was collected and thrown away. The parser was the
      // only thing that knew, and it was talking to no one.
      //
      // The NLRI here is one prefix claiming length 40, which no IPv4 route
      // has.
      const updateBody = [
        0x00, 0x00, // Withdrawn Routes Length
        0x00, 0x04, // Total Path Attr Length
        0x40, 0x01, 0x01, 0x00, // ORIGIN
        40, 10, 1, 1, 0, 0, // NLRI: a prefix length past the family maximum
      ]
      const result = parseBgpFromPackets([
        createRawPacket(createBgpMessage(4, []), 1),
        createRawPacket(createBgpMessage(2, updateBody), 2),
      ])

      expect(result.warnings.join(' ')).toContain('exceeds the maximum 32')
      // Attributed to its packet, like every other warning here, so a capture
      // with thousands of UPDATEs says which one.
      expect(result.warnings.join(' ')).toContain('Packet 2:')
      // And on the packet itself, which is where the UI reads them from.
      expect(result.packets[1].parseWarnings.join(' ')).toContain('exceeds the maximum 32')
      expect(result.packets[0].parseWarnings).toEqual([])
    })
  })

  describe('marker validation', () => {
    test('rejects invalid marker', () => {
      const badPayload = new Uint8Array([
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Bad marker
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x13, // Length
        0x04, // Type
      ])
      const rawPacket = createRawPacket(badPayload)

      const result = parseBgpFromPackets([rawPacket])

      expect(result.packets).toHaveLength(0)
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.warnings[0]).toContain('Invalid BGP marker')
    })
  })

  describe('multiple messages', () => {
    test('parses multiple BGP messages in one TCP segment', () => {
      const keepalive1 = createBgpMessage(4, [])
      const keepalive2 = createBgpMessage(4, [])

      const combined = new Uint8Array([...keepalive1, ...keepalive2])
      const rawPacket = createRawPacket(combined)

      const result = parseBgpFromPackets([rawPacket])

      // Multiple BGP messages in one TCP segment should be in one packet with multiple messages
      expect(result.packets).toHaveLength(1)
      expect(result.packets[0].messages).toHaveLength(2)
      expect(result.packets[0].messages[0].type).toBe('KEEPALIVE')
      expect(result.packets[0].messages[1].type).toBe('KEEPALIVE')
    })
  })

  describe('TCP segment reassembly', () => {
    test('parses a BGP message split across exactly two segments', () => {
      const keepalive = createBgpMessage(4, [])
      const openBody = [
        0x04, 0xfd, 0xe9, 0x00, 0x5a, 0x0a, 0x00, 0x00, 0x01, 0x00,
      ]
      const open = createBgpMessage(1, openBody)
      const combined = new Uint8Array([...keepalive, ...open])

      // Split the combined stream mid-OPEN-message (after the KEEPALIVE and
      // partway through the OPEN header/body).
      const splitPoint = keepalive.length + 10
      const segment1 = combined.slice(0, splitPoint)
      const segment2 = combined.slice(splitPoint)

      const packet1 = createRawPacket(segment1, 1)
      const packet2 = createRawPacket(segment2, 2)

      const result = parseBgpFromPackets([packet1, packet2])

      // First frame only yields the complete KEEPALIVE; the partial OPEN is
      // buffered rather than dropped.
      expect(result.packets).toHaveLength(2)
      expect(result.packets[0].frameIndex).toBe(1)
      expect(result.packets[0].messages).toHaveLength(1)
      expect(result.packets[0].messages[0].type).toBe('KEEPALIVE')

      // The reassembled OPEN is attributed to the completing frame (frame 2).
      expect(result.packets[1].frameIndex).toBe(2)
      expect(result.packets[1].messages).toHaveLength(1)
      const open2 = result.packets[1].messages[0] as BgpOpenMessage
      expect(open2.type).toBe('OPEN')
      expect(open2.myAs).toBe(65001)
      expect(open2.bgpIdentifier).toBe('10.0.0.1')

      expect(result.warnings.some((w) => w.includes('Partial message skipped'))).toBe(false)
    })

    test('parses a BGP message split across three segments', () => {
      const notifBody = [0x06, 0x02, 0xaa, 0xbb, 0xcc]
      const message = createBgpMessage(3, notifBody)

      // Split into three uneven pieces: header only, mid-body, rest.
      const segment1 = message.slice(0, 10)
      const segment2 = message.slice(10, 21)
      const segment3 = message.slice(21)

      const packets = [
        createRawPacket(segment1, 1),
        createRawPacket(segment2, 2),
        createRawPacket(segment3, 3),
      ]

      const result = parseBgpFromPackets(packets)

      expect(result.packets).toHaveLength(1)
      expect(result.packets[0].frameIndex).toBe(3)
      const notif = result.packets[0].messages[0] as BgpNotificationMessage
      expect(notif.type).toBe('NOTIFICATION')
      expect(notif.errorCode).toBe(6)
      expect(notif.errorSubcode).toBe(2)
      expect(notif.data).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]))
    })

    test('handles a segment ending mid-message followed by one completing it and starting another', () => {
      const first = createBgpMessage(4, []) // KEEPALIVE
      const second = createBgpMessage(4, []) // KEEPALIVE
      const third = createBgpMessage(4, []) // KEEPALIVE

      const combined = new Uint8Array([...first, ...second, ...third])

      // Segment 1 ends partway through `second`.
      const splitPoint = first.length + 5
      const segment1 = combined.slice(0, splitPoint)
      // Segment 2 completes `second` and fully contains `third`.
      const segment2 = combined.slice(splitPoint)

      const packet1 = createRawPacket(segment1, 1)
      const packet2 = createRawPacket(segment2, 2)

      const result = parseBgpFromPackets([packet1, packet2])

      expect(result.packets).toHaveLength(2)
      expect(result.packets[0].messages).toHaveLength(1) // `first`

      // `second` (completed) and `third` (fully contained) both land on frame 2.
      expect(result.packets[1].frameIndex).toBe(2)
      expect(result.packets[1].messages).toHaveLength(2)
      expect(result.packets[1].messages[0].type).toBe('KEEPALIVE')
      expect(result.packets[1].messages[1].type).toBe('KEEPALIVE')
    })

    test('keeps two interleaved flows separate with no cross-contamination', () => {
      // Flow A->B: OPEN split across two segments.
      const openBody = [
        0x04, 0xfd, 0xe9, 0x00, 0x5a, 0x0a, 0x00, 0x00, 0x01, 0x00,
      ]
      const openMsg = createBgpMessage(1, openBody)
      const openSeg1 = openMsg.slice(0, 12)
      const openSeg2 = openMsg.slice(12)

      // Flow B->A: NOTIFICATION split across two segments.
      const notifBody = [0x02, 0x02, 0xfd, 0xea]
      const notifMsg = createBgpMessage(3, notifBody)
      const notifSeg1 = notifMsg.slice(0, 15)
      const notifSeg2 = notifMsg.slice(15)

      const flowA = (payload: Uint8Array, frameIndex: number): RawPacket => ({
        frameIndex,
        timestamp: new Date('2024-01-01T00:00:00Z'),
        capturedLength: payload.length,
        originalLength: payload.length,
        srcIp: '10.0.0.1',
        dstIp: '10.0.0.2',
        srcPort: 54321,
        dstPort: 179,
        tcpPayload: payload,
        tcpFlags: { fin: false, syn: false, rst: false, psh: true, ack: true, urg: false },
      })

      const flowB = (payload: Uint8Array, frameIndex: number): RawPacket => ({
        frameIndex,
        timestamp: new Date('2024-01-01T00:00:00Z'),
        capturedLength: payload.length,
        originalLength: payload.length,
        srcIp: '10.0.0.2',
        dstIp: '10.0.0.1',
        srcPort: 179,
        dstPort: 54321,
        tcpPayload: payload,
        tcpFlags: { fin: false, syn: false, rst: false, psh: true, ack: true, urg: false },
      })

      // Interleave: A1, B1, A2, B2
      const packets = [
        flowA(openSeg1, 1),
        flowB(notifSeg1, 2),
        flowA(openSeg2, 3),
        flowB(notifSeg2, 4),
      ]

      const result = parseBgpFromPackets(packets)

      expect(result.packets).toHaveLength(2)

      const openPacket = result.packets.find((p) => p.frameIndex === 3)
      const notifPacket = result.packets.find((p) => p.frameIndex === 4)

      expect(openPacket).toBeDefined()
      expect(openPacket!.messages).toHaveLength(1)
      const open = openPacket!.messages[0] as BgpOpenMessage
      expect(open.type).toBe('OPEN')
      expect(open.myAs).toBe(65001)

      expect(notifPacket).toBeDefined()
      expect(notifPacket!.messages).toHaveLength(1)
      const notif = notifPacket!.messages[0] as BgpNotificationMessage
      expect(notif.type).toBe('NOTIFICATION')
      expect(notif.errorCode).toBe(2)
      expect(notif.errorSubcode).toBe(2)
    })

    test('does not grow the buffer unboundedly for a desynced/garbage flow', () => {
      // Bytes that never form a valid BGP marker (e.g. a permanently
      // misaligned stream, or garbage from retransmitted/duplicated
      // segments). Each segment fails marker validation, so it's held as the
      // flow's leftover buffer in case a later segment lets it resync - but
      // since resync never happens here, that buffer keeps being appended to
      // and would grow without bound if not capped.
      const garbageSegment = new Uint8Array(500).fill(0xab)

      const packets: RawPacket[] = []
      for (let f = 1; f <= 10; f++) {
        packets.push(createRawPacket(garbageSegment, f))
      }

      const result = parseBgpFromPackets(packets)

      // No message ever completes.
      expect(result.packets).toHaveLength(0)

      // The buffer must have been capped/discarded well before reaching
      // 10 * 500 = 5000 bytes; a desync warning must be emitted.
      expect(result.warnings.some((w) => w.includes('desynced'))).toBe(true)
    })

    test('warns when a flow ends with an incomplete message still buffered', () => {
      const openBody = [
        0x04, 0xfd, 0xe9, 0x00, 0x5a, 0x0a, 0x00, 0x00, 0x01, 0x00,
      ]
      const open = createBgpMessage(1, openBody)
      const segment1 = open.slice(0, 10) // never completed

      const rawPacket = createRawPacket(segment1, 1)

      const result = parseBgpFromPackets([rawPacket])

      expect(result.packets).toHaveLength(0)
      expect(
        result.warnings.some(
          (w) => w.includes('192.168.1.1:12345->192.168.1.2:179') && w.includes('incomplete')
        )
      ).toBe(true)
    })
  })

  describe('packet metadata', () => {
    test('preserves packet metadata', () => {
      const payload = createBgpMessage(4, [])
      const rawPacket: RawPacket = {
        frameIndex: 42,
        timestamp: new Date('2024-06-15T12:30:00Z'),
        capturedLength: payload.length,
        originalLength: payload.length,
        srcIp: '10.0.0.1',
        dstIp: '10.0.0.2',
        srcPort: 179,
        dstPort: 54321,
        tcpPayload: payload,
        tcpFlags: {
          fin: false,
          syn: false,
          rst: false,
          psh: true,
          ack: true,
          urg: false,
        },
      }

      const result = parseBgpFromPackets([rawPacket])

      expect(result.packets[0].srcIp).toBe('10.0.0.1')
      expect(result.packets[0].dstIp).toBe('10.0.0.2')
      expect(result.packets[0].srcPort).toBe(179)
      expect(result.packets[0].dstPort).toBe(54321)
      expect(result.packets[0].timestamp).toEqual(new Date('2024-06-15T12:30:00Z'))
    })
  })
})
