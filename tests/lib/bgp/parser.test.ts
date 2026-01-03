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
