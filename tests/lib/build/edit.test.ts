/**
 * Reading captures in and editing them, checked through the app's parser:
 * an edit is only useful if BGPShark sees the damage it was meant to make.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ROUTER_A,
  ROUTER_B,
  buildScenario,
  dropFrames,
  editFrame,
  establish,
  filterFrames,
  overwriteBytes,
  patchRecord,
  readCapture,
  shiftTime,
  snapFrames,
  startAt,
} from '../../../src/lib/build'
import { parsePcap } from '../../../src/lib/pcap/parser'
import { parsePcapng } from '../../../src/lib/pcap/pcapng-parser'
import { writePcap } from '../../../src/lib/pcap/writer'
import { parseBgpFromPackets } from '../../../src/lib/bgp/parser'
import { LinkLayerType } from '../../../src/lib/pcap/types'

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const session = () =>
  buildScenario({
    a: ROUTER_A,
    b: ROUTER_B,
    gap: 200,
    steps: [...establish(), { kind: 'keepalive', from: 'a' }],
  })

describe('readCapture', () => {
  test('reads the bundled pcapng into the frames the app reads from it', () => {
    const raw = readFileSync(resolve(import.meta.dir, '../../../public/sample.pcapng'))
    const capture = readCapture(raw)
    const original = parsePcapng(buffer(raw)).allPackets
    const rewritten = parsePcap(buffer(capture.bytes)).allPackets

    expect(rewritten).toHaveLength(original.length)
    rewritten.forEach((packet, i) => {
      expect(packet.srcIp).toBe(original[i].srcIp)
      expect(packet.timestamp).toEqual(original[i].timestamp)
      expect(packet.payloadLength).toBe(original[i].payloadLength)
    })
  })

  test('keeps frames the app has no use for', () => {
    // An ARP request: not IP, so the app's parser skips it — and an edit that
    // went through that parser would silently delete it.
    const arp = new Uint8Array(42)
    arp.fill(0xff, 0, 6)
    arp.set([0x08, 0x06], 12)
    const file = writePcap(
      [{ timestamp: new Date(0), frameBytes: arp, originalLength: arp.length }],
      LinkLayerType.ETHERNET
    )

    expect(parsePcap(buffer(file)).allPackets).toHaveLength(0)
    expect(readCapture(file).frames.map((f) => [...f.frameBytes])).toEqual([[...arp]])
  })

  test('round-trips a built capture byte for byte', () => {
    const built = session()
    expect(readCapture(built.bytes).bytes).toEqual(built.bytes)
  })

  test('refuses a file it cannot read completely', () => {
    const cut = session().bytes.slice(0, -5)
    expect(() => readCapture(cut)).toThrow(/claims \d+ bytes/)
    expect(() => readCapture(new Uint8Array(30))).toThrow(/magic/)
  })
})

describe('frame edits', () => {
  test('dropFrames and filterFrames number frames from 1, as the app does', () => {
    const built = session()
    expect(dropFrames(built, [1, 2]).frames[0]).toBe(built.frames[2])
    expect(filterFrames(built, (_, n) => n % 2 === 0).frames).toHaveLength(4)
    expect(() => dropFrames(built, [99])).toThrow(/No frame 99/)
  })

  test('shiftTime moves the frames from one on, and keeps the senders aligned', () => {
    const built = session()
    const shifted = shiftTime(built, 60_000, { from: 6 })
    const gap = shifted.frames[5].timestamp.getTime() - shifted.frames[4].timestamp.getTime()
    expect(gap).toBe(60_200)
    expect(shifted.senders).toEqual(built.senders)
  })

  test('startAt moves the whole capture', () => {
    const moved = startAt(session(), new Date('2030-05-01T12:00:00Z'))
    expect(moved.frames[0].timestamp.toISOString()).toBe('2030-05-01T12:00:00.000Z')
  })

  test('overwriteBytes damages what the app reads', () => {
    // Frame 4 is A's OPEN; byte 54 is the first byte of its BGP marker.
    const damaged = overwriteBytes(session(), 4, 54, [0x00])
    const bgp = parseBgpFromPackets(parsePcap(buffer(damaged.bytes)).packets)
    expect(bgp.warnings.join('\n')).toMatch(/marker/i)
    expect(() => overwriteBytes(session(), 4, 500, [0])).toThrow(/cannot write/)
  })

  test('editFrame can lengthen a frame, and its length on the wire follows', () => {
    const edited = editFrame(session(), 1, (bytes) => Uint8Array.from([...bytes, 0, 0]))
    expect(edited.frames[0].frameBytes.length).toBe(62)
    expect(edited.frames[0].originalLength).toBe(62)
  })

  test('snapFrames cuts what was captured but not what was sent', () => {
    const snapped = snapFrames(session(), 60)
    const open = snapped.frames[3]
    expect(open.frameBytes.length).toBe(60)
    expect(open.originalLength).toBeGreaterThan(60)
  })
})

describe('patchRecord', () => {
  test('makes a file the app reads as truncated', () => {
    const file = patchRecord(session().bytes, 3, { capturedLength: 5000 })
    const result = parsePcap(buffer(file))
    expect(result.warnings.join('\n')).toMatch(/Packet 3: file appears truncated/)
    expect(result.allPackets).toHaveLength(2)
  })

  test('rewrites a timestamp in place', () => {
    const file = patchRecord(session().bytes, 2, { timestamp: new Date('2025-12-31T23:59:59Z') })
    const packets = parsePcap(buffer(file)).allPackets
    expect(packets[1].timestamp.toISOString()).toBe('2025-12-31T23:59:59.000Z')
  })
})
