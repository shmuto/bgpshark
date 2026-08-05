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
