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
 * Sub-second gaps keep their milliseconds because a session reset exchanges
 * its whole burst inside one second; longer ones lose that precision in
 * favour of being readable at a glance.
 */
export function formatDelta(milliseconds: number): string {
  const ms = Math.abs(milliseconds)
  const sign = milliseconds < 0 ? '-' : '+'

  if (ms < 1000) return `${sign}${(ms / 1000).toFixed(3)}s`
  if (ms < 60_000) return `${sign}${(ms / 1000).toFixed(1)}s`

  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${sign}${minutes}m${seconds.toString().padStart(2, '0')}s`

  const hours = Math.floor(minutes / 60)
  return `${sign}${hours}h${(minutes % 60).toString().padStart(2, '0')}m`
}
