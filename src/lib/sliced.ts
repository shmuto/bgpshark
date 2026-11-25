/**
 * Long computations written once, run either in one go or in slices.
 *
 * Reading a capture file and working out its findings are loops over every
 * record, packet, frame and route of a capture. On a large one each of them
 * held the page frozen for seconds. Each loop is therefore a generator that
 * pauses (`yield`) every few hundred items, and a driver decides what a pause
 * means: `runToEnd` ignores it, so tests and callers that cannot wait get the
 * answer synchronously as before; `runInSlices` hands the page back once a
 * slice has used its time.
 *
 * One body for both, rather than an async copy of each rule beside the sync
 * one, so the two cannot drift apart: what a large capture shows is by
 * construction what a test computes.
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
 * between them. Resolves to null — and abandons the work — if `stop` (a
 * signal, or a question asked between slices) says so first.
 */
export async function runInSlices<T>(
  work: Sliced<T>,
  stop?: AbortSignal | (() => boolean)
): Promise<T | null> {
  const stopped = typeof stop === 'function' ? stop : () => stop?.aborted === true
  let sliceStart = performance.now()
  let step = work.next()
  while (!step.done) {
    if (performance.now() - sliceStart > SLICE_MS) {
      await yieldToPage()
      if (stopped()) {
        work.return(undefined as T)
        return null
      }
      sliceStart = performance.now()
    }
    step = work.next()
  }
  return step.value
}

/**
 * How many items each run of `sortWork` sorts with `Array.prototype.sort`
 * before the runs are merged. Small enough that one run is a millisecond or
 * two; large enough that only a handful of merge passes follow.
 */
const SORT_RUN = 4096

/**
 * A sorted copy of `items`, as `[...items].sort(compare)` would give it —
 * stable, so equal items keep their order — that can pause.
 *
 * `Array.prototype.sort` cannot be interrupted, and the Routes screen sorts
 * every route of the capture: on a 300MB capture of one-off routes that is
 * 2.4 million of them, about a second in one go. Here runs of `SORT_RUN` are
 * sorted natively, and the runs are merged pairwise, pausing every few
 * hundred items, until one is left. Merging stable runs in order is itself
 * stable, so the result is the native sort's, item for item.
 */
export function* sortWork<T>(items: readonly T[], compare: (a: T, b: T) => number): Sliced<T[]> {
  const n = items.length
  let from: T[] = new Array<T>(n)
  for (let start = 0; start < n; start += SORT_RUN) {
    const run = items.slice(start, start + SORT_RUN).sort(compare)
    for (let i = 0; i < run.length; i++) from[start + i] = run[i]
    yield
  }
  if (n <= SORT_RUN) return from

  let to: T[] = new Array<T>(n)
  let steps = 0
  for (let width = SORT_RUN; width < n; width *= 2) {
    for (let left = 0; left < n; left += 2 * width) {
      const middle = Math.min(left + width, n)
      const end = Math.min(left + 2 * width, n)
      let i = left
      let j = middle
      let out = left
      while (i < middle && j < end) {
        // Ties take the left run's item: it came first.
        to[out++] = compare(from[j], from[i]) < 0 ? from[j++] : from[i++]
        if (pauseAt(++steps)) yield
      }
      while (i < middle) to[out++] = from[i++]
      while (j < end) to[out++] = from[j++]
    }
    const swap = from
    from = to
    to = swap
  }
  return from
}
