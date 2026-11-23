/**
 * One key per pair of addresses, whichever way a packet travels.
 *
 * The alert rules, the session list and the session scope all have to agree on
 * what "the same session" means, and they used to each build their own key.
 * They share this one so a finding raised for `a|b` is the finding listed
 * under session `a|b`.
 */
export function peeringKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** The two addresses of a key built by `peeringKey`, lower first. */
export function peeringAddresses(key: string): [string, string] {
  const [a, b] = key.split('|')
  return [a, b]
}
