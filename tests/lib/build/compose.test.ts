/**
 * `mergeCaptures` and `keepSide` are checked through the real parser, like the
 * rest of the builder: what matters is which frames the app reads out of the
 * file, not what the arrays held on the way in.
 */
import { describe, expect, test } from 'bun:test'
import {
  ROUTER_A,
  ROUTER_B,
  buildScenario,
  establish,
  keepSide,
  mergeCaptures,
} from '../../../src/lib/build'
import { parsePcap } from '../../../src/lib/pcap/parser'
import { LinkLayerType } from '../../../src/lib/pcap/types'

function framesIn(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return parsePcap(buffer).allPackets
}

describe('establish', () => {
  test('gives each caller its own steps', () => {
    const first = establish()
    first[0].gap = 5
    expect(establish()[0].gap).toBeUndefined()
  })
})

describe('buildScenario senders', () => {
  test('names the peer behind every frame', () => {
    const built = buildScenario({ a: ROUTER_A, b: ROUTER_B, steps: establish() })
    const frames = framesIn(built.bytes)

    expect(built.senders).toHaveLength(frames.length)
    frames.forEach((frame, i) => {
      expect(frame.srcIp).toBe(built.senders[i] === 'a' ? ROUTER_A.ip : ROUTER_B.ip)
    })
  })
})

describe('keepSide', () => {
  test('keeps only what one peer sent, whatever the encapsulation', () => {
    // QinQ over IPv6: the source address is nowhere near where a fixed byte
    // offset into an untagged IPv4 frame would look for it.
    const built = buildScenario({
      a: { ip: '2001:db8::1', as: 65001, routerId: '1.1.1.1' },
      b: { ip: '2001:db8::2', as: 65002, routerId: '2.2.2.2' },
      vlanIds: [100, 200],
      steps: establish(),
    })

    const fromB = keepSide(built, 'b')
    const frames = framesIn(fromB.bytes)

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.length).toBe(built.senders.filter((side) => side === 'b').length)
    expect(new Set(frames.map((frame) => frame.srcIp))).toEqual(new Set(['2001:db8::2']))
    expect(fromB.senders.every((side) => side === 'b')).toBe(true)
  })
})

describe('mergeCaptures', () => {
  test('interleaves frames in time order and keeps their senders with them', () => {
    const early = buildScenario({
      a: ROUTER_A,
      b: ROUTER_B,
      startTime: new Date('2026-01-01T00:00:00Z'),
      gap: 1000,
      steps: establish(),
    })
    const late = buildScenario({
      a: { ...ROUTER_A, ip: '10.0.1.1' },
      b: { ...ROUTER_B, ip: '10.0.1.2' },
      startTime: new Date('2026-01-01T00:00:00.5Z'),
      gap: 1000,
      steps: establish(),
    })

    const merged = mergeCaptures([early, late])
    const frames = framesIn(merged.bytes)
    const times = frames.map((frame) => frame.timestamp.getTime())

    expect(frames).toHaveLength(early.frames.length + late.frames.length)
    expect(times).toEqual([...times].sort((x, y) => x - y))
    // Interleaved, not appended: the second session starts before the first ends.
    expect(frames.findIndex((frame) => frame.srcIp === '10.0.1.1')).toBeLessThan(early.frames.length)
    frames.forEach((frame, i) => {
      const fromA = frame.srcIp === ROUTER_A.ip || frame.srcIp === '10.0.1.1'
      expect(merged.senders[i]).toBe(fromA ? 'a' : 'b')
    })
  })

  test('refuses captures of different link types', () => {
    const ethernet = buildScenario({ a: ROUTER_A, b: ROUTER_B, steps: establish() })
    const cooked = buildScenario({
      a: ROUTER_A,
      b: ROUTER_B,
      linkType: LinkLayerType.SLL,
      steps: establish(),
    })
    expect(() => mergeCaptures([ethernet, cooked])).toThrow(/link types/)
  })
})
