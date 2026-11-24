/**
 * Long computations written once, run either in one go or in slices.
 *
 * The findings are worked out by loops over every packet, frame and route of
 * a capture. On a large one that was seconds of the page frozen after the
 * route statistics finished — the longest freeze left in a load. Each loop is
 * therefore a generator that pauses (`yield`) every few hundred items, and a
 * driver decides what a pause means: `runToEnd` ignores it, so tests and
 * small captures get the answer synchronously as before; `runInSlices` hands
 * the page back once a slice has used its time.
 *
 * One body for both, rather than an async copy of each rule beside the sync
 * one, so the two cannot drift apart: the findings a large capture shows are
 * by construction the ones a test computes.
 */
import { yieldToPage } from './yield-to-page'

/** A computation that pauses now and then and finally returns a `T`. */
export type Sliced<T> = Generator<void, T, void>

/**
 * How often, in items, a loop offers to pause. A pause is a generator resume
 * and, in `runInSlices`, a clock read: cheap, but not per item of a loop
 * whose items take a fraction of a microsecond.
 */
export const PAUSE_EVERY = 256

/** Whether a loop at item `index` should offer to pause. */
export function pauseAt(index: number): boolean {
  return (index & (PAUSE_EVERY - 1)) === PAUSE_EVERY - 1
}

/** Run `work` to completion without ever handing the page back. */
export function runToEnd<T>(work: Sliced<T>): T {
  let step = work.next()
  while (!step.done) step = work.next()
  return step.value
}

/**
 * How long one slice may run before the page gets the event loop back. The
 * same budget as decoding and route statistics use.
 */
const SLICE_MS = 12

/**
 * Run `work` in slices of about `SLICE_MS`, returning to the event loop
 * between them. Resolves to null — and abandons the work — if `signal` aborts
 * first.
 */
export async function runInSlices<T>(work: Sliced<T>, signal?: AbortSignal): Promise<T | null> {
  let sliceStart = performance.now()
  let step = work.next()
  while (!step.done) {
    if (performance.now() - sliceStart > SLICE_MS) {
      await yieldToPage()
      if (signal?.aborted) {
        work.return(undefined as T)
        return null
      }
      sliceStart = performance.now()
    }
    step = work.next()
  }
  return step.value
}
