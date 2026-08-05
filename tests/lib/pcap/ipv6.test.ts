import { describe, test, expect } from 'bun:test'
import { parsePcap } from '../../../src/lib/pcap/parser'
import { formatIpv6 } from '../../../src/lib/pcap/ipv6'
import { PcapMagic, LinkLayerType } from '../../../src/lib/pcap/types'

/** Expands any accepted IPv6 text form into the 16 bytes that go on the wire. */
function addressBytes(text: string): Uint8Array {
  const [head, tail = ''] = text.split('::')
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  const groups = text.includes('::')
    ? [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups]
    : headGroups

  const bytes = new Uint8Array(16)
  groups.forEach((group, i) => {
    const value = parseInt(group, 16)
    bytes[i * 2] = (value >> 8) & 0xff
    bytes[i * 2 + 1] = value & 0xff
  })
  return bytes
}

/** A BGP KEEPALIVE: 16-byte marker, length 19, type 4. */
function keepalive(): Uint8Array {
  const message = new Uint8Array(19).fill(0xff)
  message[16] = 0x00
  message[17] = 0x13
  message[18] = 0x04
  return message
}

interface Ipv6PacketOptions {
  srcIp?: string
  dstIp?: string
  srcPort?: number
  dstPort?: number
  payload?: Uint8Array
  /** Number of 802.1Q/802.1ad tags in front of the IPv6 EtherType. */
  vlanTags?: number
  linkType?: number
  /** Extension headers between the fixed header and TCP, as [nextHeaderValue, bytes]. */
  extensionHeaders?: Uint8Array[]
  /** Protocol number of the first header after the fixed one; defaults to TCP. */
  firstNextHeader?: number
}

/**
 * Ethernet (or SLL) frame carrying IPv6/TCP, built byte by byte so the tests do
 * not depend on a committed fixture.
 */
function createIpv6TcpPacket(options: Ipv6PacketOptions = {}): Uint8Array {
  const {
    srcIp = '2001:db8::1',
    dstIp = '2001:db8::2',
    srcPort = 179,
    dstPort = 54321,
    payload = keepalive(),
    vlanTags = 0,
    linkType = LinkLayerType.ETHERNET,
    extensionHeaders = [],
    firstNextHeader = 6,
  } = options

  const extensionBytes = extensionHeaders.reduce((sum, h) => sum + h.length, 0)
  const linkLength =
    linkType === LinkLayerType.SLL ? 16 : 14 + vlanTags * 4
  const bytes: number[] = []

  if (linkType === LinkLayerType.SLL) {
    bytes.push(0x00, 0x00, 0x00, 0x01, 0x00, 0x06)
    bytes.push(0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x00, 0x00)
  } else {
    bytes.push(0x00, 0x11, 0x22, 0x33, 0x44, 0x55)
    bytes.push(0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb)
    for (let i = 0; i < vlanTags; i++) {
      // Outer tags are 802.1ad, the innermost is 802.1Q.
      const tpid = i === vlanTags - 1 ? [0x81, 0x00] : [0x88, 0xa8]
      bytes.push(tpid[0], tpid[1], 0x00, 0x64)
    }
  }

  // EtherType: IPv6
  bytes.push(0x86, 0xdd)

  // IPv6 fixed header
  const ipPayloadLength = extensionBytes + 20 + payload.length
  bytes.push(0x60, 0x00, 0x00, 0x00) // Version 6, traffic class, flow label
  bytes.push((ipPayloadLength >> 8) & 0xff, ipPayloadLength & 0xff)
  bytes.push(firstNextHeader)
  bytes.push(0x40) // Hop limit
  bytes.push(...addressBytes(srcIp))
  bytes.push(...addressBytes(dstIp))

  for (const header of extensionHeaders) {
    bytes.push(...header)
  }

  // TCP header
  bytes.push((srcPort >> 8) & 0xff, srcPort & 0xff)
  bytes.push((dstPort >> 8) & 0xff, dstPort & 0xff)
  bytes.push(0x00, 0x00, 0x00, 0x01) // Sequence
  bytes.push(0x00, 0x00, 0x00, 0x00) // Ack
  bytes.push(0x50, 0x18) // Data offset 20 bytes, PSH+ACK
  bytes.push(0xff, 0xff) // Window
  bytes.push(0x00, 0x00) // Checksum
  bytes.push(0x00, 0x00) // Urgent pointer
  bytes.push(...payload)

  const packet = new Uint8Array(bytes)
  expect(packet.length).toBe(linkLength + 40 + ipPayloadLength)
  return packet
}

function createPcapBuffer(packets: Uint8Array[], linkType: number = LinkLayerType.ETHERNET): ArrayBuffer {
  const totalSize = 24 + packets.reduce((sum, p) => sum + 16 + p.length, 0)
  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)

  view.setUint32(0, PcapMagic.LITTLE_ENDIAN_MICROSECONDS, true)
  view.setUint16(4, 2, true)
  view.setUint16(6, 4, true)
  view.setUint32(16, 65535, true)
  view.setUint32(20, linkType, true)

  let offset = 24
  for (const packet of packets) {
    view.setUint32(offset, 1700000000, true)
    view.setUint32(offset + 4, 0, true)
    view.setUint32(offset + 8, packet.length, true)
    view.setUint32(offset + 12, packet.length, true)
    new Uint8Array(buffer, offset + 16).set(packet)
    offset += 16 + packet.length
  }

  return buffer
}

/** Hop-by-hop or destination options header of the minimum 8 bytes. */
function optionsHeader(nextHeader: number): Uint8Array {
  return new Uint8Array([nextHeader, 0x00, 0x01, 0x04, 0x00, 0x00, 0x00, 0x00])
}

function fragmentHeader(nextHeader: number, fragmentOffset: number): Uint8Array {
  const offsetAndFlags = (fragmentOffset / 8) << 3
  return new Uint8Array([
    nextHeader,
    0x00,
    (offsetAndFlags >> 8) & 0xff,
    offsetAndFlags & 0xff,
    0x00,
    0x00,
    0x00,
    0x01,
  ])
}

describe('formatIpv6', () => {
  test('strips leading zeroes and compresses the longest zero run', () => {
    expect(formatIpv6(new Uint8Array([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))).toBe(
      '2001:db8::1'
    )
  })

  test('leaves a single zero hextet uncompressed', () => {
    const bytes = new Uint8Array(16)
    bytes.set([0x20, 0x01, 0x0d, 0xb8], 0)
    bytes.set([0, 1, 0, 2, 0, 3, 0, 4, 0, 5], 6)
    expect(formatIpv6(bytes)).toBe('2001:db8:0:1:2:3:4:5')
  })

  test('compresses the first of two equal-length zero runs', () => {
    const bytes = new Uint8Array(16)
    bytes.set([0x20, 0x01], 0)
    bytes[7] = 1
    bytes[13] = 1
    bytes[15] = 2
    expect(formatIpv6(bytes)).toBe('2001::1:0:0:1:2')
  })

  test('renders the unspecified and loopback addresses', () => {
    expect(formatIpv6(new Uint8Array(16))).toBe('::')
    const loopback = new Uint8Array(16)
    loopback[15] = 1
    expect(formatIpv6(loopback)).toBe('::1')
  })

  test('compresses a trailing zero run', () => {
    const bytes = new Uint8Array(16)
    bytes.set([0xfe, 0x80], 0)
    expect(formatIpv6(bytes)).toBe('fe80::')
  })
})

describe('parsePcap over IPv6', () => {
  test('extracts a BGP KEEPALIVE from an IPv6 session', () => {
    const payload = keepalive()
    const buffer = createPcapBuffer([createIpv6TcpPacket({ payload })])

    const result = parsePcap(buffer)

    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.packets).toHaveLength(1)
    expect(result.packets[0].srcIp).toBe('2001:db8::1')
    expect(result.packets[0].dstIp).toBe('2001:db8::2')
    expect(result.packets[0].srcPort).toBe(179)
    expect(result.packets[0].tcpPayload).toEqual(payload)
    expect(result.packets[0].tcpFlags.psh).toBe(true)
  })

  test('IPv6 packets reach allPackets like IPv4 ones', () => {
    const buffer = createPcapBuffer([createIpv6TcpPacket({ srcPort: 12345, dstPort: 179 })])

    const result = parsePcap(buffer)

    expect(result.allPackets).toHaveLength(1)
    expect(result.allPackets[0].protocol).toBe('TCP')
    expect(result.allPackets[0].protocolNumber).toBe(6)
    expect(result.allPackets[0].srcIp).toBe('2001:db8::1')
    expect(result.allPackets[0].payloadLength).toBe(19)
  })

  test('handles an 802.1Q tag in front of the IPv6 EtherType', () => {
    const buffer = createPcapBuffer([createIpv6TcpPacket({ vlanTags: 1 })])

    const result = parsePcap(buffer)

    expect(result.errors).toHaveLength(0)
    expect(result.packets).toHaveLength(1)
    expect(result.packets[0].srcIp).toBe('2001:db8::1')
  })

  test('handles QinQ tags in front of the IPv6 EtherType', () => {
    const buffer = createPcapBuffer([createIpv6TcpPacket({ vlanTags: 2 })])

    const result = parsePcap(buffer)

    expect(result.packets).toHaveLength(1)
  })

  test('parses IPv6 over Linux SLL', () => {
    const buffer = createPcapBuffer(
      [createIpv6TcpPacket({ linkType: LinkLayerType.SLL, srcIp: 'fe80::1', dstIp: 'fe80::2' })],
      LinkLayerType.SLL
    )

    const result = parsePcap(buffer)

    expect(result.errors).toHaveLength(0)
    expect(result.packets).toHaveLength(1)
    expect(result.packets[0].srcIp).toBe('fe80::1')
    expect(result.packets[0].dstIp).toBe('fe80::2')
  })

  test('walks a hop-by-hop and destination options chain to the TCP header', () => {
    const payload = keepalive()
    const buffer = createPcapBuffer([
      createIpv6TcpPacket({
        firstNextHeader: 0, // Hop-by-hop
        extensionHeaders: [optionsHeader(60), optionsHeader(6)],
        payload,
      }),
    ])

    const result = parsePcap(buffer)

    expect(result.warnings).toHaveLength(0)
    expect(result.packets).toHaveLength(1)
    expect(result.packets[0].tcpPayload).toEqual(payload)
    expect(result.allPackets[0].payloadLength).toBe(payload.length)
  })

  test('walks a routing header', () => {
    const buffer = createPcapBuffer([
      createIpv6TcpPacket({ firstNextHeader: 43, extensionHeaders: [optionsHeader(6)] }),
    ])

    expect(parsePcap(buffer).packets).toHaveLength(1)
  })

  test('accepts the first fragment of a fragmented packet', () => {
    const buffer = createPcapBuffer([
      createIpv6TcpPacket({ firstNextHeader: 44, extensionHeaders: [fragmentHeader(6, 0)] }),
    ])

    const result = parsePcap(buffer)

    expect(result.warnings).toHaveLength(0)
    expect(result.packets).toHaveLength(1)
  })

  test('skips a non-first fragment with a warning', () => {
    const buffer = createPcapBuffer([
      createIpv6TcpPacket({ firstNextHeader: 44, extensionHeaders: [fragmentHeader(6, 1448)] }),
    ])

    const result = parsePcap(buffer)

    expect(result.packets).toHaveLength(0)
    expect(result.allPackets).toHaveLength(0)
    expect(result.warnings[0]).toMatch(/IPv6 fragment at offset 1448 skipped/)
  })

  test('reports a non-TCP upper layer instead of dropping the packet', () => {
    const buffer = createPcapBuffer([createIpv6TcpPacket({ firstNextHeader: 58 })]) // ICMPv6

    const result = parsePcap(buffer)

    expect(result.packets).toHaveLength(0)
    expect(result.allPackets).toHaveLength(1)
    expect(result.allPackets[0].protocol).toBe('OTHER')
    expect(result.allPackets[0].protocolNumber).toBe(58)
  })

  test('mixes IPv4 and IPv6 packets in one capture', () => {
    const v6 = createIpv6TcpPacket({ payload: new Uint8Array([1, 2, 3]) })
    const v4 = new Uint8Array(14 + 20 + 20 + 3)
    v4.set([0x08, 0x00], 12)
    v4.set([0x45, 0x00, 0x00, 43], 14) // Version/IHL, DSCP, total length 43
    v4[14 + 9] = 6 // TCP
    v4.set([10, 0, 0, 1], 14 + 12)
    v4.set([10, 0, 0, 2], 14 + 16)
    v4.set([0x00, 0xb3, 0x30, 0x39], 34) // Ports 179 -> 12345
    v4[34 + 12] = 0x50
    v4[34 + 13] = 0x18
    v4.set([4, 5, 6], 54)

    const result = parsePcap(createPcapBuffer([v6, v4]))

    expect(result.packets).toHaveLength(2)
    expect(result.packets[0].srcIp).toBe('2001:db8::1')
    expect(result.packets[1].srcIp).toBe('10.0.0.1')
  })
})
