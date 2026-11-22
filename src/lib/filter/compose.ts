/**
 * Building filter text from a field and a value, for the places that add a
 * condition without the reader typing it: the + Filter popover, and the
 * "filter on this value" buttons in the packet detail.
 */
import { parseQuery } from './parser'

/** `field op value`, with the value quoted when the grammar needs it to be. */
export function formatCondition(field: string, operator: string, value: string): string {
  const needsQuotes = value === '' || /[\s"'(),]/.test(value)
  const text = needsQuotes ? `"${value.replace(/["\\]/g, '\\$&')}"` : value
  return `${field} ${operator} ${text}`
}

/**
 * The current query narrowed by one more condition.
 *
 * `and` binds tighter than `or`, so `a or b` followed by ` and c` would mean
 * `a or (b and c)`. A query with an `or` at its top level is parenthesised
 * first, so the new condition narrows the whole of it. A query that does not
 * parse is left as it is and the condition replaces nothing — appending to it
 * would bury the new condition in an error.
 */
export function appendCondition(query: string, condition: string): string {
  const current = query.trim()
  if (!current) return condition
  const parsed = parseQuery(current)
  if (parsed.errors.length > 0) return `${current} and ${condition}`
  const base = parsed.expression?.type === 'or' ? `(${current})` : current
  return `${base} and ${condition}`
}
