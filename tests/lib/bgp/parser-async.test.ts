import { describe, test, expect } from 'bun:test'
import { parseBgpFromPackets, parseBgpFromPacketsAsync } from '../../../src/lib/bgp/parser'
import { parsePcap } from '../../../src/lib/pcap/parser'
import type { RawPacket } from '../../../src/lib/pcap/types'
import { announce, buildScenario, withdraw, type BgpMessageSpec } from '../../../src/lib/build'
import { Afi, Safi } from '../../../src/lib/bgp/constants'

/**
 * The sliced decoder must be the plain decoder with pauses in it, nothing
 * more. What could break that is state carried between packets — a flow's
 * half-received message, a session's negotiated AS width and ADD-PATH — so
 * these captures are built to have a lot of it in flight at every slice
 * boundary, and a slice budget of zero makes every 16th packet a boundary.
 */

/**
 * Two sessions whose OPENs decide how their UPDATEs read: one negotiates
 * ADD-PATH, so its NLRI carries Path Identifiers, the other does not. Their UPDATEs are sent as a
 * burst, then the TCP payloads are re-cut into 7-byte segments and the two
 * sessions' segments interleaved, so nearly every message straddles several
 * frames and most slice boundaries fall inside one.
 */
function interleavedFragmentedPackets(): RawPacket[] {
  const updates = (offset: number, withPathId = true): BgpMessageSpec[] => {
    const messages: BgpMessageSpec[] = []
    for (let i = 0; i < 120; i++) {
      const prefix = withPathId ? { prefix: `10.${offset}.${i}.0/24`, pathId: (i % 3) + 1 } : `10.${offset}.${i}.0/24`
      messages.push(
        announce([prefix], {
          nextHop: '10.0.0.2',
          asPath: [65002, 64512 + (i % 7)],
        })
      )
      if (i % 10 === 9) messages.push(withdraw([prefix]))
    }
    return messages
  }
  const addPath = buildScenario({
    a: {
      ip: '10.0.0.1',
      as: 65001,
      routerId: '1.1.1.1',
      capabilities: [
        { type: 'MULTIPROTOCOL', afi: Afi.IPV4, safi: Safi.UNICAST },
        { type: 'FOUR_OCTET_AS', asNumber: 65001 },
        { type: 'ADD_PATH', addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST, sendReceive: 'both' }] },
      ],
    },
    b: {
      ip: '10.0.0.2',
      as: 65002,
      routerId: '2.2.2.2',
      capabilities: [
        { type: 'MULTIPROTOCOL', afi: Afi.IPV4, safi: Safi.UNICAST },
        { type: 'FOUR_OCTET_AS', asNumber: 65002 },
        { type: 'ADD_PATH', addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST, sendReceive: 'both' }] },
      ],
    },
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'send', from: 'b', messages: updates(1) },
    ],
  })
  const plain = buildScenario({
    a: { ip: '10.0.1.1', as: 65011, routerId: '3.3.3.3' },
    b: { ip: '10.0.1.2', as: 65012, routerId: '4.4.4.4' },
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'send', from: 'b', messages: updates(2, false) },
    ],
  })

  const fragment = (bytes: Uint8Array): RawPacket[] =>
    parsePcap(bytes.slice().buffer as ArrayBuffer).packets.flatMap((packet) => {
      const pieces: RawPacket[] = []
      for (let at = 0; at < packet.tcpPayload.length; at += 7) {
        const tcpPayload = packet.tcpPayload.slice(at, at + 7)
        pieces.push({ ...packet, tcpPayload, capturedLength: tcpPayload.length })
      }
      return pieces
    })
  const first = fragment(addPath.bytes)
  const second = fragment(plain.bytes)
  const merged: RawPacket[] = []
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    if (i < first.length) merged.push(first[i])
    if (i < second.length) merged.push(second[i])
  }
  return merged.map((packet, i) => ({ ...packet, frameIndex: i + 1 }))
}

describe('parseBgpFromPacketsAsync', () => {
  test('decodes exactly what the one-pass decoder does, across slice boundaries', async () => {
    const raw = interleavedFragmentedPackets()
    // The fixture is only a test of slicing if messages really do straddle
    // frames: far more frames than the messages they carry.
    const expected = parseBgpFromPackets(raw)
    const messageCount = expected.packets.reduce((sum, p) => sum + p.messages.length, 0)
    expect(raw.length).toBeGreaterThan(messageCount * 3)
    expect(expected.packets.some((p) => p.messages.some((m) => m.type === 'UPDATE' && m.nlri.some((n) => n.pathId !== undefined)))).toBe(true)

    const reports: number[] = []
    const actual = await parseBgpFromPacketsAsync(raw, {
      sliceMs: 0,
      onProgress: (done, total) => {
        expect(total).toBe(raw.length)
        reports.push(done)
      },
    })

    expect(actual).toEqual(expected)
    // It did pause, often, and the count only went up, ending at all of them.
    expect(reports.length).toBeGreaterThan(100)
    for (let i = 1; i < reports.length; i++) expect(reports[i]).toBeGreaterThan(reports[i - 1])
    expect(reports[reports.length - 1]).toBe(raw.length)
  })

  test('stops, and resolves to null, once nobody wants the result', async () => {
    const raw = interleavedFragmentedPackets()
    let slices = 0
    const result = await parseBgpFromPacketsAsync(raw, {
      sliceMs: 0,
      onProgress: () => slices++,
      shouldStop: () => slices >= 3,
    })
    expect(result).toBeNull()
    expect(slices).toBe(3)
  })

  test('an empty capture still resolves, with nothing in it', async () => {
    expect(await parseBgpFromPacketsAsync([])).toEqual({ packets: [], warnings: [] })
  })
})
