import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { pauseAt, PAUSE_EVERY, runInSlices, runToEnd, type Sliced } from '../../src/lib/sliced'
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
