/**
 * One time-of-day format for every screen.
 *
 * Timestamps are shown in UTC because that is what the hex-level detail view
 * and the absolute-time column already use, and because captures are usually
 * read next to router logs, which operators keep in UTC. Milliseconds are not
 * optional: a session reset exchanges its whole OPEN/NOTIFICATION burst inside
 * one second, and second-resolution timestamps make that burst unreadable.
 */
export function formatTimeOfDayUtc(date: Date): string {
  return date.toISOString().slice(11, 23)
}

/**
 * A gap between two events, for the "how long after the last one" question
 * that reading absolute timestamps turns into arithmetic — how long a route
 * was gone, how long after the last keepalive the hold timer fired.
 *
 * Sub-second gaps are the inside of a burst and keep their milliseconds
 * (`+0.012s`), because a session reset exchanges its whole
 * OPEN/NOTIFICATION exchange within one second. A gap of seconds reads as
 * seconds (`+2.0s`); past a minute the decimal stops meaning anything and the
 * question becomes "how long was it quiet", so it reads as `+1m40s` / `+2h05m`.
 *
 * Each tier rounds before its own boundary is checked, so a gap that rounds up
 * into the next unit is shown in that unit rather than as `+60.0s`.
 *
 * Negative gaps are shown rather than hidden: timestamps that go backwards are
 * a property of the capture worth seeing, not a rounding artefact to suppress.
 * A gap that is not a number at all has nothing to say, so it says nothing.
 */
export function formatDelta(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '-'

  const ms = Math.abs(milliseconds)
  const sign = milliseconds < 0 ? '-' : '+'

  const millis = Math.round(ms)
  if (millis < 1000) return `${sign}${(millis / 1000).toFixed(3)}s`

  const tenths = Math.round(ms / 100)
  if (tenths < 600) return `${sign}${(tenths / 10).toFixed(1)}s`

  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${sign}${minutes}m${seconds.toString().padStart(2, '0')}s`

  const hours = Math.floor(minutes / 60)
  return `${sign}${hours}h${(minutes % 60).toString().padStart(2, '0')}m`
}
