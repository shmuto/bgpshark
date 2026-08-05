import { describe, test, expect } from 'bun:test'
import { parsePcapng, isPcapng } from '../../../src/lib/pcap/pcapng-parser'
import { LinkLayerType } from '../../../src/lib/pcap/types'

const SECTION_HEADER = 0x0a0d0d0a
const INTERFACE_DESCRIPTION = 0x00000001
const ENHANCED_PACKET = 0x00000006

/** Bytes of one block, already carrying its own type and both length fields. */
function block(type: number, body: Uint8Array): Uint8Array {
  const padding = (4 - (body.length % 4)) % 4
  const total = 12 + body.length + padding
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, type, true)
  view.setUint32(4, total, true)
  bytes.set(body, 8)
  view.setUint32(total - 4, total, true)
  return bytes
}

function sectionHeaderBlock(): Uint8Array {
  const body = new Uint8Array(16)
  const view = new DataView(body.buffer)
  view.setUint32(0, 0x1a2b3c4d, true) // Byte order magic
  view.setUint16(4, 1, true) // Major
  view.setUint16(6, 0, true) // Minor
  view.setUint32(8, 0xffffffff, true) // Section length: unknown
  view.setUint32(12, 0xffffffff, true)
  return block(SECTION_HEADER, body)
}

function interfaceDescriptionBlock(linkType: number = LinkLayerType.ETHERNET): Uint8Array {
  const body = new Uint8Array(8)
  const view = new DataView(body.buffer)
  view.setUint16(0, linkType, true)
  view.setUint32(4, 262144, true) // Snap length
  return block(INTERFACE_DESCRIPTION, body)
}

function enhancedPacketBlock(packet: Uint8Array): Uint8Array {
  const body = new Uint8Array(20 + packet.length)
  const view = new DataView(body.buffer)
  view.setUint32(0, 0, true) // Interface ID
  view.setUint32(4, 0, true) // Timestamp high
  view.setUint32(8, 1700000000, true) // Timestamp low
  view.setUint32(12, packet.length, true) // Captured length
  view.setUint32(16, packet.length, true) // Original length
  body.set(packet, 20)
  return block(ENHANCED_PACKET, body)
}

function concat(blocks: Uint8Array[]): ArrayBuffer {
  const total = blocks.reduce((sum, b) => sum + b.length, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const b of blocks) {
    bytes.set(b, offset)
    offset += b.length
  }
  return bytes.buffer as ArrayBuffer
}

/** A BGP OPEN: marker, length, type 1, then a minimal fixed part. */
function open(): Uint8Array {
  const message = new Uint8Array(29).fill(0xff)
  message[16] = 0x00
  message[17] = 0x1d
  message[18] = 0x01 // Type: OPEN
  message[19] = 0x04 // Version 4
  message[20] = 0xfd
  message[21] = 0xe8 // ASN 65000
  message[22] = 0x00
  message[23] = 0xb4 // Hold time 180
  message.set([10, 0, 0, 1], 24) // BGP identifier
  message[28] = 0x00 // Optional parameters length
  return message
}

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

function ipv6TcpPacket(
  options: {
    srcIp?: string
    dstIp?: string
    srcPort?: number
    dstPort?: number
    payload?: Uint8Array
    vlanTag?: boolean
  } = {}
): Uint8Array {
  const {
    srcIp = '2001:db8:1::a',
    dstIp = '2001:db8:2::b',
    srcPort = 179,
    dstPort = 54321,
    payload = open(),
    vlanTag = false,
  } = options

  const bytes: number[] = []
  bytes.push(0x00, 0x11, 0x22, 0x33, 0x44, 0x55)
  bytes.push(0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb)
  if (vlanTag) bytes.push(0x81, 0x00, 0x00, 0x64)
  bytes.push(0x86, 0xdd)

  const ipPayloadLength = 20 + payload.length
  bytes.push(0x60, 0x00, 0x00, 0x00)
  bytes.push((ipPayloadLength >> 8) & 0xff, ipPayloadLength & 0xff)
  bytes.push(0x06) // Next header: TCP
  bytes.push(0x40)
  bytes.push(...addressBytes(srcIp))
  bytes.push(...addressBytes(dstIp))

  bytes.push((srcPort >> 8) & 0xff, srcPort & 0xff)
  bytes.push((dstPort >> 8) & 0xff, dstPort & 0xff)
  bytes.push(0x00, 0x00, 0x00, 0x01)
  bytes.push(0x00, 0x00, 0x00, 0x00)
  bytes.push(0x50, 0x18)
  bytes.push(0xff, 0xff)
  bytes.push(0x00, 0x00)
  bytes.push(0x00, 0x00)
  bytes.push(...payload)

  return new Uint8Array(bytes)
}

/** IPv4/TCP frame, so the mixed-family and recovery cases have a v4 baseline. */
function ipv4TcpPacket(payload: Uint8Array, dstPort = 179): Uint8Array {
  const bytes = new Uint8Array(14 + 20 + 20 + payload.length)
  const view = new DataView(bytes.buffer)
  bytes.set([0x08, 0x00], 12)
  bytes[14] = 0x45
  view.setUint16(16, 40 + payload.length, false) // Total length
  bytes[14 + 9] = 6 // TCP
  bytes.set([192, 0, 2, 1], 26)
  bytes.set([192, 0, 2, 2], 30)
  view.setUint16(34, 12345, false)
  view.setUint16(36, dstPort, false)
  bytes[34 + 12] = 0x50
  bytes[34 + 13] = 0x18
  bytes.set(payload, 54)
  return bytes
}

/**
 * Bumps an Enhanced Packet Block's captured length past its own block, the same
 * corruption `tests/e2e/helpers.ts` produces from the sample capture.
 */
function corruptCapturedLength(file: ArrayBuffer, whichPacketBlock: number): ArrayBuffer {
  const bytes = new Uint8Array(file.slice(0))
  const view = new DataView(bytes.buffer)
  let offset = 0
  let seen = 0

  while (offset + 8 <= bytes.length) {
    const type = view.getUint32(offset, true)
    const length = view.getUint32(offset + 4, true)
    if (length < 12 || offset + length > bytes.length) break
    if (type === ENHANCED_PACKET) {
      if (seen === whichPacketBlock) {
        view.setUint32(offset + 20, view.getUint32(offset + 20, true) + 40, true)
        return bytes.buffer as ArrayBuffer
      }
      seen++
    }
    offset += length
  }

  throw new Error('no such packet block')
}

describe('isPcapng', () => {
  test('recognises a Section Header Block', () => {
    expect(isPcapng(concat([sectionHeaderBlock()]))).toBe(true)
  })
})

describe('parsePcapng over IPv6', () => {
  test('extracts a BGP OPEN from an IPv6 session', () => {
    const payload = open()
    const file = concat([
      sectionHeaderBlock(),
      interfaceDescriptionBlock(),
      enhancedPacketBlock(ipv6TcpPacket({ payload })),
    ])

    const result = parsePcapng(file)

    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.packets).toHaveLength(1)
    expect(result.packets[0].srcIp).toBe('2001:db8:1::a')
    expect(result.packets[0].dstIp).toBe('2001:db8:2::b')
    expect(result.packets[0].srcPort).toBe(179)
    expect(result.packets[0].tcpPayload).toEqual(payload)
    expect(result.allPackets[0].protocol).toBe('TCP')
  })

  test('handles an 802.1Q tag in front of the IPv6 EtherType', () => {
    const file = concat([
      sectionHeaderBlock(),
      interfaceDescriptionBlock(),
      enhancedPacketBlock(ipv6TcpPacket({ vlanTag: true })),
    ])

    const result = parsePcapng(file)

    expect(result.errors).toHaveLength(0)
    expect(result.packets).toHaveLength(1)
    expect(result.packets[0].srcIp).toBe('2001:db8:1::a')
  })

  test('parses IPv6 over Linux SLL', () => {
    const ethernet = ipv6TcpPacket()
    // Same IPv6 payload behind a 16-byte cooked header instead of 14 bytes of
    // Ethernet, with the protocol field in the last two bytes.
    const sll = new Uint8Array(16 + (ethernet.length - 14))
    sll.set([0x00, 0x00, 0x00, 0x01, 0x00, 0x06], 0)
    sll.set([0x86, 0xdd], 14)
    sll.set(ethernet.subarray(14), 16)

    const file = concat([
      sectionHeaderBlock(),
      interfaceDescriptionBlock(LinkLayerType.SLL),
      enhancedPacketBlock(sll),
    ])

    const result = parsePcapng(file)

    expect(result.packets).toHaveLength(1)
    expect(result.packets[0].srcIp).toBe('2001:db8:1::a')
  })

  test('still parses IPv4 alongside IPv6', () => {
    const file = concat([
      sectionHeaderBlock(),
      interfaceDescriptionBlock(),
      enhancedPacketBlock(ipv4TcpPacket(new Uint8Array([1, 2, 3]))),
      enhancedPacketBlock(ipv6TcpPacket({ payload: new Uint8Array([4, 5, 6]) })),
    ])

    const result = parsePcapng(file)

    expect(result.packets).toHaveLength(2)
    expect(result.packets[0].srcIp).toBe('192.0.2.1')
    expect(result.packets[1].srcIp).toBe('2001:db8:1::a')
  })
})

describe('parsePcapng recovery from corruption', () => {
  function fiftyPacketFile(): ArrayBuffer {
    const blocks = [sectionHeaderBlock(), interfaceDescriptionBlock()]
    for (let i = 0; i < 50; i++) {
      blocks.push(enhancedPacketBlock(ipv4TcpPacket(new Uint8Array([i + 1]))))
    }
    return concat(blocks)
  }

  test('a packet claiming more bytes than its block holds costs only that block', () => {
    const result = parsePcapng(corruptCapturedLength(fiftyPacketFile(), 0))

    expect(result.errors).toHaveLength(0)
    expect(result.packets).toHaveLength(49)
    expect(result.allPackets).toHaveLength(49)
    // The survivors are the ones after the bad block, still in order and still
    // numbered the way the capture numbered them.
    expect(result.packets[0].frameIndex).toBe(2)
    expect(result.packets[0].tcpPayload).toEqual(new Uint8Array([2]))
    expect(result.packets[48].tcpPayload).toEqual(new Uint8Array([50]))
  })

  test('the skipped block is reported as a warning, not as a stopped parse', () => {
    const result = parsePcapng(corruptCapturedLength(fiftyPacketFile(), 10))

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/captured length \d+ exceeds the \d+ bytes its block holds/)
    expect(result.warnings[0]).toMatch(/block skipped/)
    expect(result.warnings.join(' ')).not.toMatch(/Invalid block length/)
    expect(result.packets).toHaveLength(49)
  })

  test('several corrupt blocks each cost only themselves', () => {
    let file = fiftyPacketFile()
    for (const index of [0, 10, 25]) {
      file = corruptCapturedLength(file, index)
    }

    const result = parsePcapng(file)

    expect(result.warnings).toHaveLength(3)
    expect(result.packets).toHaveLength(47)
  })

  test('a nonsensical block length ends the file and says how much was abandoned', () => {
    const blocks = [sectionHeaderBlock(), interfaceDescriptionBlock()]
    for (let i = 0; i < 3; i++) {
      blocks.push(enhancedPacketBlock(ipv4TcpPacket(new Uint8Array([i + 1]))))
    }
    const file = concat(blocks)

    // Break the framing of the last block: a length of 7 cannot be true, and
    // nothing after it can be located.
    const view = new DataView(file)
    const badBlockOffset = file.byteLength - blocks[blocks.length - 1].length
    view.setUint32(badBlockOffset + 4, 7, true)

    const result = parsePcapng(file)

    expect(result.packets).toHaveLength(2)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(
      new RegExp(`parsing stopped at byte ${badBlockOffset} of ${file.byteLength}`)
    )
    expect(result.warnings[0]).toMatch(/remaining bytes skipped/)
  })

  test('trailing garbage does not discard the packets already parsed', () => {
    const blocks = [sectionHeaderBlock(), interfaceDescriptionBlock()]
    for (let i = 0; i < 3; i++) {
      blocks.push(enhancedPacketBlock(ipv4TcpPacket(new Uint8Array([i + 1]))))
    }
    const garbage = new Uint8Array(16).fill(0xab)

    const result = parsePcapng(concat([...blocks, garbage]))

    expect(result.packets).toHaveLength(3)
    expect(result.warnings[0]).toMatch(/Invalid block length/)
  })
})
