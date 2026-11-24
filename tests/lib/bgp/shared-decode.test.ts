import { describe, test, expect } from 'bun:test'
import { parseBgpFromPackets } from '../../../src/lib/bgp/parser'
import { parsePcap } from '../../../src/lib/pcap/parser'
import { SharedTable } from '../../../src/lib/bgp/shared-decode'
import { announce, buildScenario, type BgpMessageSpec, type Scenario } from '../../../src/lib/build'
import { Afi, Safi } from '../../../src/lib/bgp/constants'
import type { BgpUpdateMessage } from '../../../src/lib/bgp/types'
import type { RawPacket } from '../../../src/lib/pcap/types'

/**
 * The decoder hands identical values to every message that carries them
 * (`shared-decode.ts`). What must hold is that sharing is invisible: the same
 * values as decoding each message afresh, the same warnings, nothing shared
 * that depends on more than its own bytes.
 */

const A = { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1' }
const B = { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2' }

function updatesOf(scenario: Scenario): { updates: BgpUpdateMessage[]; warnings: string[] } {
  const raw = parsePcap(buildScenario(scenario).bytes.slice().buffer as ArrayBuffer).packets
  const result = parseBgpFromPackets(raw)
  const updates = result.packets.flatMap((p) => p.messages).filter((m): m is BgpUpdateMessage => m.type === 'UPDATE')
  return { updates, warnings: result.warnings }
}

function established(messages: BgpMessageSpec[], options: Partial<Scenario> = {}): Scenario {
  return {
    a: A,
    b: B,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      ...messages.map((message) => ({ kind: 'send' as const, from: 'b' as const, messages: [message] })),
    ],
    ...options,
  }
}

describe('shared decoded values', () => {
  test('UPDATEs with the same attributes share one decoded list, and the same prefix one object', () => {
    const route = { nextHop: '10.0.0.2', asPath: [65002, 3356], med: 10 }
    const { updates } = updatesOf(
      established([announce(['192.0.2.0/24'], route), announce(['198.51.100.0/24'], route), announce(['192.0.2.0/24'], route)])
    )
    expect(updates).toHaveLength(3)
    expect(updates[1].pathAttributes).toBe(updates[0].pathAttributes)
    expect(updates[2].nlri[0]).toBe(updates[0].nlri[0])
    expect(updates[1].nlri[0].prefix).toBe('198.51.100.0')
  })

  test('an attribute shared between different lists is the same object, and the lists still differ', () => {
    const { updates } = updatesOf(
      established([
        announce(['192.0.2.0/24'], { nextHop: '10.0.0.2', asPath: [65002, 3356] }),
        announce(['192.0.2.0/24'], { nextHop: '10.0.0.2', asPath: [65002, 174] }),
      ])
    )
    const [first, second] = updates.map((u) => u.pathAttributes)
    expect(second).not.toBe(first)
    const origin = (list: typeof first) => list.find((a) => a.typeName === 'ORIGIN')
    expect(origin(second)).toBe(origin(first))
    const asns = (list: typeof first) =>
      list.find((a) => a.parsed?.type === 'AS_PATH')?.parsed as { segments: Array<{ asNumbers: number[] }> }
    expect(asns(first).segments[0].asNumbers).toEqual([65002, 3356])
    expect(asns(second).segments[0].asNumbers).toEqual([65002, 174])
  })

  test('a value whose decoding warns is decoded, and warns, every time', () => {
    // No OPENs, so the AS width has to be guessed, and this AS_PATH — written
    // with 2-byte AS numbers — fits both readings, which the parser says. Were
    // it shared, the second UPDATE would arrive without its warning.
    const asPath = [2, 2, 0xfd, 0xe9, 0xfd, 0xea, 1, 1, 0xfd, 0xeb]
    const attributes = [0x40, 1, 1, 0, 0x40, 2, asPath.length, ...asPath, 0x40, 3, 4, 10, 0, 0, 1]
    const body = [0, 0, 0, attributes.length, ...attributes, 24, 192, 0, 2]
    const message = new Uint8Array([...new Array(16).fill(0xff), 0, 19 + body.length, 2, ...body])
    const packet = (frameIndex: number): RawPacket => ({
      frameIndex,
      timestamp: new Date('2024-01-01T00:00:00Z'),
      capturedLength: message.length,
      originalLength: message.length,
      srcIp: '10.0.0.2',
      dstIp: '10.0.0.1',
      srcPort: 179,
      dstPort: 51000,
      tcpPayload: message,
      tcpFlags: { fin: false, syn: false, rst: false, psh: true, ack: true, urg: false },
    })
    const result = parseBgpFromPackets([packet(1), packet(2)])
    expect(result.packets).toHaveLength(2)
    expect(result.warnings.filter((w) => w.includes('fits both 2-byte and 4-byte'))).toHaveLength(2)
    expect(result.packets.map((p) => p.parseWarnings.length)).toEqual([1, 1])
  })

  test('prefixes with a Path Identifier keep their own', () => {
    const capabilities = (as: number) => [
      { type: 'MULTIPROTOCOL' as const, afi: Afi.IPV4, safi: Safi.UNICAST },
      { type: 'FOUR_OCTET_AS' as const, asNumber: as },
      { type: 'ADD_PATH' as const, addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST, sendReceive: 'both' as const }] },
    ]
    const route = { nextHop: '10.0.0.2', asPath: [65002] }
    const { updates } = updatesOf(
      established(
        [
          announce([{ prefix: '192.0.2.0/24', pathId: 1 }], route),
          announce([{ prefix: '192.0.2.0/24', pathId: 2 }], route),
        ],
        { a: { ...A, capabilities: capabilities(65001) }, b: { ...B, capabilities: capabilities(65002) } }
      )
    )
    expect(updates.map((u) => u.nlri[0])).toEqual([
      { prefix: '192.0.2.0', length: 24, pathId: 1 },
      { prefix: '192.0.2.0', length: 24, pathId: 2 },
    ])
  })

  test('more distinct prefixes than the cache has room for still decode to themselves', () => {
    // Every prefix differs, across all lengths; collisions in the cache must
    // cost a second decode, never the wrong prefix.
    const messages: BgpMessageSpec[] = []
    const expected: string[] = []
    for (let i = 0; i < 6000; i++) {
      const length = 8 + (i % 25)
      const address = ((i * 2654435761) >>> 0) & (length === 32 ? 0xffffffff : ~(0xffffffff >>> length))
      const text = `${address >>> 24}.${(address >>> 16) & 255}.${(address >>> 8) & 255}.${address & 255}/${length}`
      expected.push(text.split("/")[0])
      messages.push(announce([text], { nextHop: '10.0.0.2', asPath: [65002] }))
    }
    const { updates } = updatesOf(established([], { steps: [{ kind: 'handshake' }, { kind: 'open', from: 'a' }, { kind: 'open', from: 'b' }, { kind: 'send', from: 'b', messages }, { kind: 'send', from: 'b', messages }] }))
    expect(updates.map((u) => u.nlri[0].prefix)).toEqual([...expected, ...expected])
  })
})

describe('SharedTable', () => {
  test('rests once lookups stop finding anything, then tries again', () => {
    const table = new SharedTable<number, string>()
    let consulted = 0
    for (let i = 0; i < 200_000; i++) {
      if (!table.active()) continue
      consulted++
      if (table.get(i) === undefined) table.set(i, String(i))
    }
    // Nothing ever repeats, so most of these were skipped — but not all: it
    // keeps checking.
    expect(consulted).toBeLessThan(40_000)
    expect(consulted).toBeGreaterThan(4096)
  })

  test('keeps sharing while lookups keep finding things', () => {
    const table = new SharedTable<number, string>()
    let consulted = 0
    for (let i = 0; i < 200_000; i++) {
      if (!table.active()) continue
      consulted++
      if (table.get(i % 100) === undefined) table.set(i % 100, String(i % 100))
    }
    expect(consulted).toBe(200_000)
  })
})
