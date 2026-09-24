/**
 * How far a capture load has got, as one number and the words that explain it.
 *
 * A large capture takes long enough to load that a spinner stops meaning
 * "working" and starts meaning "stuck" — which is exactly what an 18MB capture
 * looked like when it took two minutes, and why this exists. A gauge answers
 * the question a spinner cannot: is it still moving?
 *
 * The load is a sequence of stages of very different lengths, and only one of
 * them can report progress from inside: the DuckDB insert is asynchronous and
 * goes in batches, so it can say how many rows are in. The parsers are
 * synchronous — the page cannot repaint until they return — so all they can do
 * is announce that they have started. The bar therefore steps through the
 * early stages and moves smoothly through the database one.
 *
 * Each stage owns a slice of the bar sized by how long it actually takes. The
 * slices were measured in Chromium on two 18MB captures: 225,000 UPDATEs packed
 * into full segments, and 120,000 UPDATEs one to a frame. Parsing took well
 * under a second on both and decoding one to two; the database took everything
 * else — about three quarters of the load on the sparse capture and over nine
 * tenths on the dense one — and reading and saving next to nothing. They are
 * not exact for every capture, and do not need to be; what matters is that the
 * bar never runs backwards and does not race to a third and then crawl.
 */

export type LoadStage = 'reading' | 'parsing' | 'decoding' | 'database' | 'saving'

export interface LoadProgress {
  stage: LoadStage
  /** The whole load, 0 to 1. */
  fraction: number
  /** What is happening, in words, e.g. "Loading into DuckDB — 420,000 of 1,600,000 rows". */
  label: string
}

/** Where each stage's slice of the bar starts and ends. */
const STAGE_SPAN: Record<LoadStage, [number, number]> = {
  reading: [0, 0.02],
  parsing: [0.02, 0.06],
  decoding: [0.06, 0.15],
  database: [0.15, 0.98],
  saving: [0.98, 1],
}

const STAGE_LABEL: Record<LoadStage, string> = {
  reading: 'Reading file',
  parsing: 'Parsing packets',
  decoding: 'Decoding BGP messages',
  database: 'Loading into DuckDB',
  saving: 'Saving for next visit',
}

/**
 * Progress at a point inside a stage.
 *
 * `done` and `total` are the stage's own units — rows, for the database — and
 * are left out when the stage cannot measure itself, which places the bar at
 * the start of the stage's slice.
 */
export function loadProgress(stage: LoadStage, done?: number, total?: number): LoadProgress {
  const [start, end] = STAGE_SPAN[stage]
  const within = total && total > 0 ? Math.min(1, Math.max(0, (done ?? 0) / total)) : 0
  // Before the database can count rows it has to empty its tables and flatten
  // every packet into them, which on a large capture is a couple of seconds
  // with nothing to count. Saying so beats a label that looks frozen.
  const counted =
    total && total > 0
      ? ` — ${(done ?? 0).toLocaleString('en-US')} of ${total.toLocaleString('en-US')} rows`
      : stage === 'database'
        ? ' — preparing rows'
        : ''
  return {
    stage,
    fraction: start + (end - start) * within,
    label: `${STAGE_LABEL[stage]}${counted}`,
  }
}
