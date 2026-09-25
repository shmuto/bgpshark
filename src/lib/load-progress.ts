/**
 * How far a capture load has got, as one number and the words that explain it.
 *
 * A large capture takes long enough to load that a spinner stops meaning
 * "working" and starts meaning "stuck" — which is exactly what an 18MB capture
 * looked like when it took two minutes, and why this exists. A gauge answers
 * the question a spinner cannot: is it still moving?
 *
 * There are two loads, and they are measured separately because the reader
 * waits for only one of them.
 *
 * The first is the capture itself — read, parse, decode — and the screens need
 * it before they can show anything. The parsers are synchronous, so the page
 * cannot repaint until each returns, and all they can do is announce that they
 * have started. Each stage owns a slice of the bar sized by how long it takes:
 * measured in Chromium on captures up to the 50MB limit, parsing the pcap is a
 * few percent of this load and decoding BGP is nearly all of it.
 *
 * The second is DuckDB, which used to be the last stage of the first load and
 * was nine tenths of the wait — 37 of 48 seconds on a 50MB capture — for
 * something only the SQL console strictly needs. It now runs after the
 * screens have appeared, and reports rows as they go in.
 */

export type LoadStage = 'reading' | 'parsing' | 'decoding'

export interface LoadProgress {
  stage: LoadStage
  /** This load, 0 to 1. */
  fraction: number
  /** What is happening, in words. */
  label: string
}

/** Where each stage's slice of the bar starts and ends. */
const STAGE_SPAN: Record<LoadStage, [number, number]> = {
  reading: [0, 0.03],
  parsing: [0.03, 0.1],
  decoding: [0.1, 1],
}

const STAGE_LABEL: Record<LoadStage, string> = {
  reading: 'Reading file',
  parsing: 'Parsing packets',
  decoding: 'Decoding BGP messages',
}

/** The capture load, at the start of `stage`. */
export function loadProgress(stage: LoadStage): LoadProgress {
  return { stage, fraction: STAGE_SPAN[stage][0], label: STAGE_LABEL[stage] }
}

/**
 * The DuckDB load, as `fraction` and a label.
 *
 * `total` is zero until the capture has been flattened into rows — emptying
 * the tables and building the rows is a few seconds on a large capture with
 * nothing to count yet, and saying so beats a label that looks frozen.
 */
export function databaseProgress(done: number, total: number): { fraction: number; label: string } {
  if (total <= 0) return { fraction: 0, label: 'Loading into DuckDB — preparing rows' }
  const fraction = Math.min(1, Math.max(0, done / total))
  return {
    fraction,
    label: `Loading into DuckDB — ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} rows`,
  }
}
