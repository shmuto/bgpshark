/**
 * Packets that are not a BGP session, and bytes put into one verbatim.
 *
 * Read back through the app's parser for what BGPShark will show, and checked
 * the way a receiving stack checks them for what every other tool will: a
 * one's-complement sum over a segment that already holds its checksum is zero.
 */
import { describe, expect, test } from 'bun:test'
import {
  ROUTER_A,
  ROUTER_B,
  bgpMessage,
  buildPackets,
  buildScenario,
  establish,
  hex,
  keepSide,
  tcpFlags,
} from '../../../src/lib/build'
import { ByteWriter, internetChecksum } from '../../../src/lib/build/bytes'
import { parsePcap } from '../../../src/lib/pcap/parser'
import { parseBgpFromPackets } from '../../../src/lib/bgp/parser'

function readBack(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return parsePcap(buffer)
}

/** An untagged Ethernet/IPv4 frame's IP header and what follows it. */
function ipv4Layers(frame: Uint8Array) {
  const headerLength = (frame[14] & 0x0f) * 4
  const totalLength = (frame[16] << 8) | frame[17]
  return {
    header: frame.subarray(14, 14 + headerLength),
    protocol: frame[23],
    src: frame.subarray(26, 30),
    dst: frame.subarray(30, 34),
    segment: frame.subarray(14 + headerLength, 14 + totalLength),
  }
}

function pseudoHeader(src: Uint8Array, dst: Uint8Array, protocol: number, length: number) {
  return new ByteWriter().bytes(src).bytes(dst).u8(0).u8(protocol).u16(length).toBytes()
}

describe('buildPackets', () => {
  const capture = buildPackets({
    packets: [
      { protocol: 'icmp', src: '10.0.0.1', dst: '10.0.0.2' },
      { protocol: 'icmp', type: 0, src: '10.0.0.2', dst: '10.0.0.1' },
      { protocol: 'udp', src: '10.0.0.9', dst: '10.0.0.2', srcPort: 3784, dstPort: 3784, payload: hex('20 40 03 18') },
      { protocol: 'tcp', src: '192.0.2.1', dst: '10.0.0.2', srcPort: 40000, dstPort: 179, flags: 'RST,ACK', seq: 7 },
      { protocol: 89, src: '10.0.0.1', dst: '224.0.0.5', payload: hex('02 01 00 2c'), at: 5000 },
    ],
  })

  test('reads back as the packets described', () => {
    const packets = readBack(capture.bytes).allPackets
    expect(packets.map((p) => p.protocol)).toEqual(['ICMP', 'ICMP', 'UDP', 'TCP', 'OTHER'])
    expect(packets[2]).toMatchObject({ srcPort: 3784, dstPort: 3784, payloadLength: 4 })
    expect(packets[3].tcpFlags).toMatchObject({ rst: true, ack: true, syn: false })
    expect(packets[4]).toMatchObject({ protocolNumber: 89, dstIp: '224.0.0.5' })
  })

  test('spaces packets by the gap, and puts `at` where it says', () => {
    const times = capture.frames.map((frame) => frame.timestamp.getTime() - Date.UTC(2026, 0, 1))
    expect(times).toEqual([100, 200, 300, 400, 5000])
  })

  test('writes checksums a receiving stack accepts', () => {
    for (const frame of capture.frames) {
      const { header, protocol, src, dst, segment } = ipv4Layers(frame.frameBytes)
      expect(internetChecksum(header)).toBe(0)
      if (protocol === 1) expect(internetChecksum(segment)).toBe(0)
      if (protocol === 6 || protocol === 17) {
        expect(internetChecksum(pseudoHeader(src, dst, protocol, segment.length), segment)).toBe(0)
      }
    }
  })

  test('gives an echo its identifier and sequence, shared by request and reply', () => {
    const request = ipv4Layers(capture.frames[0].frameBytes).segment
    const reply = ipv4Layers(capture.frames[1].frameBytes).segment
    expect(request.length).toBe(8)
    expect([...request.subarray(4)]).toEqual([0, 1, 0, 1])
    expect([...reply.subarray(4)]).toEqual([0, 1, 0, 1])
  })

  test('tags packets with a side only when asked, so keepSide can sort them', () => {
    const tagged = buildPackets({
      packets: [
        { protocol: 'icmp', src: '10.0.0.1', dst: '10.0.0.2', from: 'a' },
        { protocol: 'icmp', src: '10.0.0.2', dst: '10.0.0.1' },
      ],
    })
    expect(tagged.senders).toEqual(['a', undefined])
    expect(keepSide(tagged, 'a').frames).toHaveLength(1)
  })

  test('rejects a flag it does not know', () => {
    expect(() => tcpFlags('SYN,PUSH')).toThrow(/PUSH/)
  })
})

describe('raw messages', () => {
  test('go on the stream verbatim, framed or not', () => {
    const unknownType = bgpMessage(9, [1, 2, 3])
    const garbage = hex('de ad be ef')
    const built = buildScenario({
      a: ROUTER_A,
      b: ROUTER_B,
      steps: [
        ...establish(),
        { kind: 'send', from: 'a', messages: [{ type: 'RAW', bytes: unknownType }] },
        { kind: 'send', from: 'b', messages: [{ type: 'RAW', bytes: garbage }] },
      ],
    })

    const packets = readBack(built.bytes).packets
    expect([...packets[packets.length - 2].tcpPayload]).toEqual([...unknownType])
    expect([...packets[packets.length - 1].tcpPayload]).toEqual([...garbage])
    expect(unknownType.subarray(16, 19)).toEqual(Uint8Array.of(0, 22, 9))

    // The app sees the half-message as exactly that.
    const bgp = parseBgpFromPackets(packets)
    expect(bgp.warnings.some((w) => /incomplete byte/.test(w))).toBe(true)
  })

  test('bgpMessage does not refuse what a well-behaved speaker would', () => {
    expect(bgpMessage(2, new Uint8Array(5000)).length).toBe(5019)
  })
})

describe('hex', () => {
  test('ignores separators and a 0x prefix', () => {
    expect([...hex('0xFF ff:00-13')]).toEqual([0xff, 0xff, 0x00, 0x13])
  })

  test('refuses half a byte', () => {
    expect(() => hex('fff')).toThrow(/Not hex/)
  })
})
