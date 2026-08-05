/**
 * Presenting AS paths so prepending reads as prepending.
 *
 * Traffic engineering prepends the same AS three, five, ten times, and spelling
 * each repeat out separately turns the interesting part — how many times —
 * into something the reader has to count. Collapsing runs keeps the path short
 * and puts the number where it can be read.
 */

export interface AsPathHop {
  asn: string
  /** How many times this AS appears consecutively. 1 for an ordinary hop. */
  repeat: number
}

/** Collapse consecutive repeats of the same AS into one hop with a count. */
export function collapsePrepends(path: readonly string[]): AsPathHop[] {
  const hops: AsPathHop[] = []
  for (const asn of path) {
    const last = hops[hops.length - 1]
    if (last && last.asn === asn) {
      last.repeat++
    } else {
      hops.push({ asn, repeat: 1 })
    }
  }
  return hops
}

/**
 * A space-separated AS path with runs collapsed, for places showing the path
 * as plain text rather than as chips.
 */
export function formatAsPath(asPath: string): string {
  const parts = asPath.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '-'

  return collapsePrepends(parts)
    .map((hop) => (hop.repeat > 1 ? `${hop.asn}×${hop.repeat}` : hop.asn))
    .join(' ')
}
