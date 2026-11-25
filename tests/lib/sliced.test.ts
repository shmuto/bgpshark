import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { pauseAt, PAUSE_EVERY, runInSlices, runToEnd, sortWork, type Sliced } from '../../src/lib/sliced'
import { parsePcap, parsePcapWork, parsePcapng, parsePcapngWork } from '../../src/lib/pcap'
import { buildScenario } from '../../src/lib/build'
import { announce } from '../../src/lib/build/presets'

function* countTo(limit: number, seen: number[]): Sliced<number> {
  let total = 0
  for (let index = 0; index < limit; index++) {
    if (pauseAt(index)) yield
    seen.push(index)
    total += index
  }
  return total
}

describe('sliced work', () => {
  test('pauses once every PAUSE_EVERY items', () => {
    let pauses = 0
    for (let index = 0; index < PAUSE_EVERY * 3; index++) if (pauseAt(index)) pauses++
    expect(pauses).toBe(3)
  })

  test('runToEnd and runInSlices return the same result', async () => {
    const syncSeen: number[] = []
    const slicedSeen: number[] = []
    const limit = PAUSE_EVERY * 50
    expect(runToEnd(countTo(limit, syncSeen))).toBe((limit * (limit - 1)) / 2)
    expect(await runInSlices(countTo(limit, slicedSeen))).toBe((limit * (limit - 1)) / 2)
    expect(slicedSeen).toEqual(syncSeen)
  })

  test('runInSlices stops and resolves to null once the signal aborts', async () => {
    const controller = new AbortController()
    let resumed = 0
    function* forever(): Sliced<string> {
      for (;;) {
        // Each pause burns past the slice budget, so the driver hands back
        // to the event loop at every one.
        const until = performance.now() + 15
        while (performance.now() < until) {
          // spin
        }
        resumed++
        if (resumed === 2) controller.abort()
        yield
      }
    }
    expect(await runInSlices(forever(), controller.signal)).toBeNull()
    expect(resumed).toBeLessThanOrEqual(3)
  })
})

describe('reading a capture in slices', () => {
  test('parsePcapWork and parsePcapngWork read what parsePcap and parsePcapng read', async () => {
    const steps = [
      { kind: 'handshake' as const },
      ...Array.from({ length: PAUSE_EVERY * 4 }, (_, i) => ({
        kind: 'send' as const,
        from: 'a' as const,
        messages: [announce([`10.0.${i & 255}.0/24`], { nextHop: '192.0.2.1', asPath: [65001] })],
      })),
    ]
    const { bytes } = buildScenario({
      a: { ip: '192.0.2.1', as: 65001, routerId: '1.1.1.1' },
      b: { ip: '192.0.2.2', as: 65002, routerId: '2.2.2.2' },
      steps,
    })
    const pcap = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const sliced = await runInSlices(parsePcapWork(pcap))
    expect(sliced).toEqual(parsePcap(pcap))
    expect(sliced!.allPackets.length).toBeGreaterThan(PAUSE_EVERY * 4)

    const sample = readFileSync(new URL('../../public/sample.pcapng', import.meta.url))
    const pcapng = sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength) as ArrayBuffer
    expect(await runInSlices(parsePcapngWork(pcapng))).toEqual(parsePcapng(pcapng))
  })
})

describe('sortWork', () => {
  // The Routes screen sorts large lists with this instead of
  // Array.prototype.sort, so it must give exactly what that would.
  test('gives what a stable native sort gives, at every size around a run', () => {
    let seed = 1
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (const size of [0, 1, 2, 4095, 4096, 4097, 8192 + 3, 50_000]) {
      // Few distinct values, so ties are everywhere and stability shows.
      const items = Array.from({ length: size }, (_, index) => ({ value: Math.floor(random() * 20), index }))
      const compare = (a: { value: number }, b: { value: number }) => a.value - b.value
      const sorted = runToEnd(sortWork(items, compare))
      const expected = [...items].sort(compare)
      expect(sorted.length).toBe(expected.length)
      expect(sorted.every((item, at) => item === expected[at])).toBe(true)
    }
  })

  test('pauses while merging, and leaves its input alone', async () => {
    const items = Array.from({ length: 20_000 }, (_, index) => 20_000 - index)
    const copy = [...items]
    let pauses = 0
    const work = sortWork(items, (a, b) => a - b)
    let step = work.next()
    while (!step.done) {
      pauses++
      step = work.next()
    }
    expect(pauses).toBeGreaterThan(20_000 / 4096)
    expect(step.value).toEqual([...items].sort((a, b) => a - b))
    expect(items).toEqual(copy)
    expect(await runInSlices(sortWork(items, (a, b) => a - b))).toEqual(step.value)
  })
})
