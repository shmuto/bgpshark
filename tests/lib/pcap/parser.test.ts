import { describe, test, expect } from 'bun:test'
import { parsePcap } from '../../../src/lib/pcap/parser'
import { PcapMagic, LinkLayerType } from '../../../src/lib/pcap/types'

/**
 * Helper to create a pcap buffer with given packets
 */
function createPcapBuffer(options: {
  littleEndian?: boolean
  linkType?: number
  packets?: Array<{
    timestamp?: number
    data: Uint8Array
  }>
}): ArrayBuffer {
  const {
    littleEndian = true,
    linkType = LinkLayerType.ETHERNET,
    packets = [],
  } = options

  // Calculate total size
  let totalSize = 24 // Global header
  for (const pkt of packets) {
    totalSize += 16 + pkt.data.length // Packet header + data
  }

  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  let offset = 0

  // Write global header
  // pcap magic number is always 0xa1b2c3d4 when read with correct endianness
  // Little-endian file: bytes are d4 c3 b2 a1
  // Big-endian file: bytes are a1 b2 c3 d4
  const magic = PcapMagic.LITTLE_ENDIAN_MICROSECONDS // 0xa1b2c3d4

  view.setUint32(offset, magic, littleEndian)
  offset += 4
  view.setUint16(offset, 2, littleEndian) // Major version
  offset += 2
  view.setUint16(offset, 4, littleEndian) // Minor version
  offset += 2
  view.setUint32(offset, 0, littleEndian) // Reserved
  offset += 4
  view.setUint32(offset, 0, littleEndian) // Reserved
  offset += 4
  view.setUint32(offset, 65535, littleEndian) // Snap length
  offset += 4
  view.setUint32(offset, linkType, littleEndian) // Link type
  offset += 4

  // Write packets
  for (const pkt of packets) {
    const ts = pkt.timestamp ?? 0
    view.setUint32(offset, Math.floor(ts), littleEndian) // Timestamp seconds
    offset += 4
    view.setUint32(offset, (ts % 1) * 1000000, littleEndian) // Timestamp microseconds
    offset += 4
    view.setUint32(offset, pkt.data.length, littleEndian) // Captured length
    offset += 4
    view.setUint32(offset, pkt.data.length, littleEndian) // Original length
    offset += 4

    new Uint8Array(buffer, offset).set(pkt.data)
    offset += pkt.data.length
  }

  return buffer
}

/**
 * Create an Ethernet frame with IPv4/TCP packet
 */
function createEthernetTcpPacket(options: {
  srcIp?: number[]
  dstIp?: number[]
  srcPort?: number
  dstPort?: number
  payload?: Uint8Array
  vlanTag?: boolean
}): Uint8Array {
  const {
    srcIp = [192, 168, 1, 1],
    dstIp = [192, 168, 1, 2],
    srcPort = 12345,
    dstPort = 179,
    payload = new Uint8Array([]),
    vlanTag = false,
  } = options

  const ethHeaderLen = vlanTag ? 18 : 14
  const ipHeaderLen = 20
  const tcpHeaderLen = 20
  const totalLen = ethHeaderLen + ipHeaderLen + tcpHeaderLen + payload.length

  const pkt = new Uint8Array(totalLen)
  let offset = 0

  // Ethernet header
  // Destination MAC (6 bytes)
  pkt.set([0x00, 0x11, 0x22, 0x33, 0x44, 0x55], offset)
  offset += 6
  // Source MAC (6 bytes)
  pkt.set([0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb], offset)
  offset += 6

  if (vlanTag) {
    // VLAN tag (802.1Q)
    pkt[offset++] = 0x81
    pkt[offset++] = 0x00
    pkt[offset++] = 0x00 // VLAN ID high + priority
    pkt[offset++] = 0x64 // VLAN ID low (100)
  }

  // EtherType: IPv4
  pkt[offset++] = 0x08
  pkt[offset++] = 0x00

  // IPv4 header
  pkt[offset++] = 0x45 // Version 4, IHL 5
  pkt[offset++] = 0x00 // DSCP/ECN
  const ipTotalLen = ipHeaderLen + tcpHeaderLen + payload.length
  pkt[offset++] = (ipTotalLen >> 8) & 0xff
  pkt[offset++] = ipTotalLen & 0xff
  pkt[offset++] = 0x00 // ID
  pkt[offset++] = 0x00
  pkt[offset++] = 0x40 // Flags (Don't Fragment)
  pkt[offset++] = 0x00 // Fragment offset
  pkt[offset++] = 0x40 // TTL
  pkt[offset++] = 0x06 // Protocol: TCP
  pkt[offset++] = 0x00 // Checksum (placeholder)
  pkt[offset++] = 0x00
  pkt.set(srcIp, offset)
  offset += 4
  pkt.set(dstIp, offset)
  offset += 4

  // TCP header
  pkt[offset++] = (srcPort >> 8) & 0xff
  pkt[offset++] = srcPort & 0xff
  pkt[offset++] = (dstPort >> 8) & 0xff
  pkt[offset++] = dstPort & 0xff
  pkt[offset++] = 0x00 // Sequence number
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x01
  pkt[offset++] = 0x00 // Ack number
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x50 // Data offset (5 * 4 = 20 bytes)
  pkt[offset++] = 0x18 // Flags: PSH, ACK
  pkt[offset++] = 0xff // Window
  pkt[offset++] = 0xff
  pkt[offset++] = 0x00 // Checksum
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00 // Urgent pointer
  pkt[offset++] = 0x00

  // Payload
  pkt.set(payload, offset)

  return pkt
}

/**
 * Create an SLL frame with IPv4/TCP packet
 */
function createSllTcpPacket(options: {
  srcIp?: number[]
  dstIp?: number[]
  srcPort?: number
  dstPort?: number
  payload?: Uint8Array
}): Uint8Array {
  const {
    srcIp = [192, 168, 1, 1],
    dstIp = [192, 168, 1, 2],
    srcPort = 12345,
    dstPort = 179,
    payload = new Uint8Array([]),
  } = options

  const sllHeaderLen = 16
  const ipHeaderLen = 20
  const tcpHeaderLen = 20
  const totalLen = sllHeaderLen + ipHeaderLen + tcpHeaderLen + payload.length

  const pkt = new Uint8Array(totalLen)
  let offset = 0

  // SLL header (16 bytes)
  pkt[offset++] = 0x00 // Packet type (host)
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00 // ARPHRD type
  pkt[offset++] = 0x01
  pkt[offset++] = 0x00 // Link-layer address length
  pkt[offset++] = 0x06
  // Link-layer address (8 bytes, padded)
  pkt.set([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x00, 0x00], offset)
  offset += 8
  // Protocol type: IPv4
  pkt[offset++] = 0x08
  pkt[offset++] = 0x00

  // IPv4 header (same as Ethernet)
  pkt[offset++] = 0x45
  pkt[offset++] = 0x00
  const ipTotalLen = ipHeaderLen + tcpHeaderLen + payload.length
  pkt[offset++] = (ipTotalLen >> 8) & 0xff
  pkt[offset++] = ipTotalLen & 0xff
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x40
  pkt[offset++] = 0x00
  pkt[offset++] = 0x40
  pkt[offset++] = 0x06 // TCP
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt.set(srcIp, offset)
  offset += 4
  pkt.set(dstIp, offset)
  offset += 4

  // TCP header
  pkt[offset++] = (srcPort >> 8) & 0xff
  pkt[offset++] = srcPort & 0xff
  pkt[offset++] = (dstPort >> 8) & 0xff
  pkt[offset++] = dstPort & 0xff
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x01
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x50
  pkt[offset++] = 0x18
  pkt[offset++] = 0xff
  pkt[offset++] = 0xff
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00
  pkt[offset++] = 0x00

  pkt.set(payload, offset)

  return pkt
}

describe('parsePcap', () => {
  describe('global header parsing', () => {
    test('parses little-endian pcap', () => {
      const buffer = createPcapBuffer({ littleEndian: true })
      const result = parsePcap(buffer)

      expect(result.errors).toHaveLength(0)
      expect(result.globalHeader.isLittleEndian).toBe(true)
      expect(result.globalHeader.versionMajor).toBe(2)
      expect(result.globalHeader.versionMinor).toBe(4)
      expect(result.globalHeader.linkType).toBe(LinkLayerType.ETHERNET)
    })

    test('parses big-endian pcap', () => {
      const buffer = createPcapBuffer({ littleEndian: false })
      const result = parsePcap(buffer)

      expect(result.errors).toHaveLength(0)
      expect(result.globalHeader.isLittleEndian).toBe(false)
    })

    test('rejects invalid magic number', () => {
      const buffer = new ArrayBuffer(24)
      new DataView(buffer).setUint32(0, 0x12345678, true)

      const result = parsePcap(buffer)

      expect(result.errors).toContain('Invalid pcap file: unrecognized magic number')
    })

    test('rejects unsupported link type', () => {
      const buffer = createPcapBuffer({ linkType: 999 })
      const result = parsePcap(buffer)

      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('Unsupported link layer type')
    })
  })

  describe('packet parsing', () => {
    test('extracts BGP packets on port 179', () => {
      const bgpPayload = new Uint8Array([0xff, 0xff, 0xff]) // Dummy payload
      const packet = createEthernetTcpPacket({
        srcPort: 12345,
        dstPort: 179,
        payload: bgpPayload,
      })

      const buffer = createPcapBuffer({
        packets: [{ data: packet }],
      })

      const result = parsePcap(buffer)

      expect(result.errors).toHaveLength(0)
      expect(result.packets).toHaveLength(1)
      expect(result.packets[0].srcPort).toBe(12345)
      expect(result.packets[0].dstPort).toBe(179)
      expect(result.packets[0].tcpPayload).toEqual(bgpPayload)
    })

    test('extracts BGP packets from source port 179', () => {
      const bgpPayload = new Uint8Array([0xaa, 0xbb])
      const packet = createEthernetTcpPacket({
        srcPort: 179,
        dstPort: 54321,
        payload: bgpPayload,
      })

      const buffer = createPcapBuffer({
        packets: [{ data: packet }],
      })

      const result = parsePcap(buffer)

      expect(result.packets).toHaveLength(1)
      expect(result.packets[0].srcPort).toBe(179)
    })

    test('ignores non-BGP traffic', () => {
      const packet = createEthernetTcpPacket({
        srcPort: 80,
        dstPort: 443,
        payload: new Uint8Array([1, 2, 3]),
      })

      const buffer = createPcapBuffer({
        packets: [{ data: packet }],
      })

      const result = parsePcap(buffer)

      expect(result.packets).toHaveLength(0)
    })

    test('ignores packets without payload', () => {
      const packet = createEthernetTcpPacket({
        dstPort: 179,
        payload: new Uint8Array([]),
      })

      const buffer = createPcapBuffer({
        packets: [{ data: packet }],
      })

      const result = parsePcap(buffer)

      expect(result.packets).toHaveLength(0)
    })

    test('parses IP addresses correctly', () => {
      const packet = createEthernetTcpPacket({
        srcIp: [10, 0, 0, 1],
        dstIp: [10, 0, 0, 2],
        dstPort: 179,
        payload: new Uint8Array([1]),
      })

      const buffer = createPcapBuffer({
        packets: [{ data: packet }],
      })

      const result = parsePcap(buffer)

      expect(result.packets).toHaveLength(1)
      expect(result.packets[0].srcIp).toBe('10.0.0.1')
      expect(result.packets[0].dstIp).toBe('10.0.0.2')
    })
  })

  describe('VLAN handling', () => {
    test('handles 802.1Q VLAN tagged frames', () => {
      const packet = createEthernetTcpPacket({
        dstPort: 179,
        payload: new Uint8Array([1, 2, 3]),
        vlanTag: true,
      })

      const buffer = createPcapBuffer({
        packets: [{ data: packet }],
      })

      const result = parsePcap(buffer)

      expect(result.errors).toHaveLength(0)
      expect(result.packets).toHaveLength(1)
    })
  })

  describe('SLL (Linux cooked capture) handling', () => {
    test('parses SLL frames', () => {
      const bgpPayload = new Uint8Array([0x11, 0x22, 0x33])
      const packet = createSllTcpPacket({
        srcIp: [172, 16, 0, 1],
        dstIp: [172, 16, 0, 2],
        dstPort: 179,
        payload: bgpPayload,
      })

      const buffer = createPcapBuffer({
        linkType: LinkLayerType.SLL,
        packets: [{ data: packet }],
      })

      const result = parsePcap(buffer)

      expect(result.errors).toHaveLength(0)
      expect(result.packets).toHaveLength(1)
      expect(result.packets[0].srcIp).toBe('172.16.0.1')
      expect(result.packets[0].dstIp).toBe('172.16.0.2')
      expect(result.packets[0].tcpPayload).toEqual(bgpPayload)
    })
  })

  describe('multiple packets', () => {
    test('parses multiple BGP packets', () => {
      const packets = [
        createEthernetTcpPacket({ dstPort: 179, payload: new Uint8Array([1]) }),
        createEthernetTcpPacket({ srcPort: 179, payload: new Uint8Array([2]) }),
        createEthernetTcpPacket({ dstPort: 80, payload: new Uint8Array([3]) }), // Non-BGP
        createEthernetTcpPacket({ dstPort: 179, payload: new Uint8Array([4]) }),
      ]

      const buffer = createPcapBuffer({
        packets: packets.map((data) => ({ data })),
      })

      const result = parsePcap(buffer)

      expect(result.packets).toHaveLength(3)
      expect(result.packets[0].tcpPayload).toEqual(new Uint8Array([1]))
      expect(result.packets[1].tcpPayload).toEqual(new Uint8Array([2]))
      expect(result.packets[2].tcpPayload).toEqual(new Uint8Array([4]))
    })
  })
})
