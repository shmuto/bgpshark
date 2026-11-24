/**
 * How far a capture load has got, as one number and the words that explain it.
 *
 * A large capture takes long enough to load that a spinner stops meaning
 * "working" and starts meaning "stuck" — which is exactly what an 18MB capture
 * looked like when it took two minutes, and why this exists. A gauge answers
 * the question a spinner cannot: is it still moving?
 *
 * There are two gauges, because the load is in two parts. The first is what
 * stands between the user and the packet list: reading, parsing and decoding.
 * Those are synchronous — the page cannot repaint until each returns — so all
 * a stage can do is announce that it has started, and the bar steps through
 * them. Each owns a slice sized by how long it takes: parsing a 100MB capture
 * is well under a second, decoding it several seconds.
 *
 * The second is the DuckDB insert, which used to be most of the first gauge —
 * over half of a 50MB load, two thirds on a dense one — and now runs after the
 * list is on screen. It goes in chunks and can say how many packets are in, so
 * its gauge, the `database` stage, spans the whole bar on its own.
 */

import { getMessages, type Locale } from '../i18n/locale'

/** The stages before the packet list can show, then the DuckDB insert after it. */
export type LoadStage = 'reading' | 'parsing' | 'decoding' | 'database'

export interface LoadProgress {
  stage: LoadStage
  /** The whole load, 0 to 1. */
  fraction: number
  /** What is happening, in words, e.g. "Loading into DuckDB — 42,000 of 160,000 packets". */
  label: string
  done?: number
  total?: number
}

/**
 * Where each stage's slice of its bar starts and ends. The first three share
 * the load gauge; `database` has a gauge of its own.
 */
const STAGE_SPAN: Record<LoadStage, [number, number]> = {
  reading: [0, 0.05],
  parsing: [0.05, 0.2],
  decoding: [0.2, 1],
  database: [0, 1],
}

export function formatLoadProgressLabel(
  stage: LoadStage,
  done?: number,
  total?: number,
  locale: Locale = 'en'
): string {
  const t = getMessages(locale).progress
  const stageLabel: Record<LoadStage, string> = {
    reading: t.reading,
    parsing: t.parsing,
    decoding: t.decoding,
    database: t.database,
  }
  // Before the database can count packets it has to empty and recreate its
  // tables, a moment with nothing to count. Saying so beats a bare label.
  const counted =
    total && total > 0
      ? t.countedPackets(done ?? 0, total)
      : stage === 'database'
        ? t.preparing
        : ''
  return `${stageLabel[stage]}${counted}`
}

/**
 * Progress at a point inside a stage.
 *
 * `done` and `total` are the stage's own units — packets, for the database — and
 * are left out when the stage cannot measure itself, which places the bar at
 * the start of the stage's slice.
 */
export function loadProgress(
  stage: LoadStage,
  done?: number,
  total?: number,
  locale: Locale = 'en'
): LoadProgress {
  const [start, end] = STAGE_SPAN[stage]
  const within = total && total > 0 ? Math.min(1, Math.max(0, (done ?? 0) / total)) : 0
  return {
    stage,
    fraction: start + (end - start) * within,
    label: formatLoadProgressLabel(stage, done, total, locale),
    done,
    total,
  }
}
