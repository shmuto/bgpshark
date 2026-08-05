import { describe, expect, test } from 'bun:test'
import { writePcap, sliceFileName } from '../../../src/lib/pcap/writer'
import { parsePcap } from '../../../src/lib/pcap/parser'
import { LinkLayerType } from '../../../src/lib/pcap/types'

/**
 * An Ethernet/IPv4/TCP frame carrying `payload`, so a written file can be read
 * back through the real parser rather than compared byte by byte against an
 * expectation that would just restate the writer.
 */
function ethernetTcpFrame(options: {
  srcIp?: number[]
  dstIp?: number[]
  srcPort?: number
  dstPort?: number
  payload?: Uint8Array
}): Uint8Array {
  const {
    srcIp = [10, 0, 0, 1],
    dstIp = [10, 0, 0, 2],
    srcPort = 40000,
    dstPort = 179,
    payload = new Uint8Array(0),
  } = options

  const frame = new Uint8Array(14 + 20 + 20 + payload.length)
  const view = new DataView(frame.buffer)

  frame.set([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff], 0)
  frame.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], 6)
  view.setUint16(12, 0x0800)

  frame[14] = 0x45
  view.setUint16(16, 20 + 20 + payload.length)
  frame[22] = 64
  frame[23] = 6
  frame.set(srcIp, 26)
  frame.set(dstIp, 30)

  view.setUint16(34, srcPort)
  view.setUint16(36, dstPort)
  frame[46] = 0x50
  frame[47] = 0x18
  frame.set(payload, 54)

  return frame
}

/** A BGP KEEPALIVE: 16-byte marker, length 19, type 4. */
function keepalive(): Uint8Array {
  const msg = new Uint8Array(19)
  msg.fill(0xff, 0, 16)
  msg[17] = 0x13
  msg[18] = 0x04
  return msg
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('writePcap', () => {
  test('what it writes, the parser reads back', () => {
    const frame = ethernetTcpFrame({ payload: keepalive() })
    const written = writePcap(
      [{ timestamp: new Date('2026-08-05T10:00:00.000Z'), frameBytes: frame, originalLength: frame.length }],
      LinkLayerType.ETHERNET
    )

    const result = parsePcap(toArrayBuffer(written))

    expect(result.errors).toEqual([])
    expect(result.allPackets.length).toBe(1)
    expect(result.allPackets[0].srcIp).toBe('10.0.0.1')
    expect(result.allPackets[0].dstIp).toBe('10.0.0.2')
    expect(result.packets.length).toBe(1)
    expect(result.packets[0].tcpPayload).toEqual(keepalive())
  })

  test('frames come back in the order they were given', () => {
    const frames = [3, 1, 2].map((n) => ({
      timestamp: new Date(`2026-08-05T10:00:0${n}.000Z`),
      frameBytes: ethernetTcpFrame({ srcPort: 40000 + n, payload: keepalive() }),
      originalLength: 74,
    }))

    const result = parsePcap(toArrayBuffer(writePcap(frames, LinkLayerType.ETHERNET)))

    expect(result.allPackets.map((p) => p.srcPort)).toEqual([40003, 40001, 40002])
  })

  test('timestamps survive to the millisecond', () => {
    const timestamp = new Date('2026-08-05T10:36:42.019Z')
    const frame = ethernetTcpFrame({ payload: keepalive() })

    const result = parsePcap(
      toArrayBuffer(
        writePcap([{ timestamp, frameBytes: frame, originalLength: frame.length }], LinkLayerType.ETHERNET)
      )
    )

    expect(result.allPackets[0].timestamp.getTime()).toBe(timestamp.getTime())
  })

  test('the link type is carried over, not assumed', () => {
    const frame = ethernetTcpFrame({ payload: keepalive() })
    const written = writePcap(
      [{ timestamp: new Date(0), frameBytes: frame, originalLength: frame.length }],
      LinkLayerType.SLL
    )

    // Byte 20 of the global header is the link type.
    expect(new DataView(toArrayBuffer(written)).getUint32(20, true)).toBe(LinkLayerType.SLL)
  })

  test('a snapped frame keeps its original wire length', () => {
    const frame = ethernetTcpFrame({ payload: keepalive() })
    const written = writePcap(
      [{ timestamp: new Date(0), frameBytes: frame, originalLength: 9000 }],
      LinkLayerType.ETHERNET
    )

    const result = parsePcap(toArrayBuffer(written))
    expect(result.allPackets[0].capturedLength).toBe(frame.length)
    expect(result.allPackets[0].originalLength).toBe(9000)
  })

  test('an original length below the captured length is not written back', () => {
    // Such a file would be self-contradictory; the captured bytes are the truth.
    const frame = ethernetTcpFrame({ payload: keepalive() })
    const written = writePcap(
      [{ timestamp: new Date(0), frameBytes: frame, originalLength: 10 }],
      LinkLayerType.ETHERNET
    )

    const result = parsePcap(toArrayBuffer(written))
    expect(result.allPackets[0].originalLength).toBe(frame.length)
  })

  test('an empty selection is still a valid, empty capture', () => {
    const result = parsePcap(toArrayBuffer(writePcap([], LinkLayerType.ETHERNET)))
    expect(result.errors).toEqual([])
    expect(result.allPackets).toEqual([])
  })
})

describe('sliceFileName', () => {
  test('replaces the source extension', () => {
    expect(sliceFileName('capture.pcapng')).toBe('capture-filtered.pcap')
    expect(sliceFileName('capture.pcap')).toBe('capture-filtered.pcap')
    expect(sliceFileName('CAPTURE.CAP')).toBe('CAPTURE-filtered.pcap')
  })

  test('copes with a name that has no extension, or no name at all', () => {
    expect(sliceFileName('capture')).toBe('capture-filtered.pcap')
    expect(sliceFileName(null)).toBe('capture-filtered.pcap')
  })

  test('leaves dots inside the name alone', () => {
    expect(sliceFileName('bgp.session.2026-08-05.pcapng')).toBe('bgp.session.2026-08-05-filtered.pcap')
  })
})
