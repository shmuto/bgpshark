import { describe, test, expect } from 'bun:test'
import { pauseAt, PAUSE_EVERY, runInSlices, runToEnd, type Sliced } from '../../src/lib/sliced'

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
