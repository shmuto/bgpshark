/**
 * Prefix arithmetic shared by the analysis screens.
 *
 * A BGP prefix only means something together with its mask length — 10.0.12.0/24
 * and 10.0.12.0/23 are different routes — so everything here works on the
 * `{ prefix, length }` pair the parser produces rather than on the address string
 * alone.
 *
 * Comparisons are numeric rather than textual. That is what lets a search for
 * 10.0.0.0/8 find 10.0.12.0/24, and it is also the only way IPv6 works at all:
 * the parser emits uncompressed addresses (`2001:db8:0:0:0:0:0:1`) while a user
 * types the compressed form (`2001:db8::1`), and those two strings only look
 * equal once they are numbers.
 */
import type { BgpPrefix } from '../bgp/types'

type Family = 4 | 6

const FAMILY_BITS: Record<Family, number> = { 4: 32, 6: 128 }

export interface ParsedPrefix {
  /** Network address, host bits cleared. */
  bits: bigint
  length: number
  family: Family
  /** False when the input was a bare address, so callers can tell `10.0.0.0` from `10.0.0.0/32`. */
  hasMask: boolean
}

/** `10.0.12.0/24` — the form a route should always be shown and keyed by. */
export function formatPrefix(prefix: BgpPrefix): string {
  // An EVPN route is not a prefix and has no mask; its own description is
  // already the whole identity, and a trailing /0 would only read as a bug.
  if (prefix.evpn) return prefix.prefix
  return `${prefix.prefix}/${prefix.length}`
}

/** Clears the bits below the mask, so 10.0.0.5/8 and 10.0.0.0/8 compare equal. */
function applyMask(bits: bigint, length: number, family: Family): bigint {
  const shift = BigInt(FAMILY_BITS[family] - length)
  return (bits >> shift) << shift
}

function parseIpv4(text: string): { bits: bigint; family: Family } | null {
  // Read as a plain number and converted once: one BigInt per address rather
  // than a shift and an OR per octet, which made this a visible cost when
  // every route in a capture is parsed.
  const bits = ipv4Bits(text)
  return bits < 0 ? null : { bits: BigInt(bits), family: 4 }
}

function parseIpv6(text: string): { bits: bigint; family: Family } | null {
  const halves = text.split('::')
  if (halves.length > 2) return null

  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []

  let groups: string[]
  if (halves.length === 2) {
    // `::` must stand for at least one group of zeroes.
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  } else {
    if (head.length !== 8) return null
    groups = head
  }

  let bits = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    bits = (bits << 16n) | BigInt(parseInt(group, 16))
  }
  return { bits, family: 6 }
}

function parseAddress(text: string): { bits: bigint; family: Family } | null {
  return text.includes(':') ? parseIpv6(text) : parseIpv4(text)
}

/**
 * Parses user input: `10.0.0.0/8`, a bare `10.0.13.1`, or an IPv6 equivalent.
 * Returns null for anything that is not an address, which is how callers tell a
 * prefix search from a free-text one.
 */
export function parsePrefix(text: string): ParsedPrefix | null {
  const parts = text.trim().split('/')
  if (parts.length > 2) return null

  const address = parseAddress(parts[0])
  if (!address) return null

  const maxLength = FAMILY_BITS[address.family]
  let length = maxLength
  let hasMask = false

  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1])) return null
    length = Number(parts[1])
    if (length > maxLength) return null
    hasMask = true
  }

  return { bits: applyMask(address.bits, length, address.family), length, family: address.family, hasMask }
}

/**
 * Parses a prefix the BGP parser produced. Returns null for the families it
 * cannot render as an address (it emits `(AFI 25)` and similar placeholders),
 * so those routes are simply never matched by an address search.
 */
export function parseBgpPrefix(prefix: BgpPrefix): ParsedPrefix | null {
  const address = parseAddress(prefix.prefix)
  if (!address) return null
  if (prefix.length > FAMILY_BITS[address.family]) return null

  return {
    bits: applyMask(address.bits, prefix.length, address.family),
    length: prefix.length,
    family: address.family,
    hasMask: true,
  }
}

/** True when `outer` covers `inner`. A prefix covers itself. */
export function contains(outer: ParsedPrefix, inner: ParsedPrefix): boolean {
  if (outer.family !== inner.family) return false
  if (outer.length > inner.length) return false

  const shift = BigInt(FAMILY_BITS[outer.family] - outer.length)
  return outer.bits >> shift === inner.bits >> shift
}

/**
 * A prefix search prepared once, for testing it against many routes.
 *
 * Same answer as `contains`: a query with a mask selects the routes inside it,
 * a bare address the routes that cover it. The in-memory filter asks this for
 * every route of every packet on each keystroke, and parsing both sides into
 * BigInts each time made one pass over a 50MB capture take about a second. An
 * IPv4 query — the common case — is compared on 32-bit integers instead, with
 * the route's dotted quad read straight off its characters; anything else
 * takes the general path.
 */
export function compilePrefixQuery(query: ParsedPrefix): (route: BgpPrefix) => boolean {
  if (query.family !== 4) {
    return (route) => {
      const parsed = parseBgpPrefix(route)
      if (!parsed) return false
      return query.hasMask ? contains(query, parsed) : contains(parsed, query)
    }
  }

  const queryBits = Number(query.bits)
  const queryLength = query.length
  if (query.hasMask) {
    const mask = ipv4Mask(queryLength)
    const network = (queryBits & mask) >>> 0
    return (route) => {
      if (route.length < queryLength || route.length > 32) return false
      const bits = ipv4Bits(route.prefix)
      return bits >= 0 && ((bits & mask) >>> 0) === network
    }
  }
  return (route) => {
    if (route.length > queryLength) return false
    const bits = ipv4Bits(route.prefix)
    if (bits < 0) return false
    const mask = ipv4Mask(route.length)
    return ((bits & mask) >>> 0) === ((queryBits & mask) >>> 0)
  }
}

function ipv4Mask(length: number): number {
  return length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0
}

/**
 * A dotted-quad address as an unsigned 32-bit number, or -1 when the text is
 * not one — an IPv6 address, an EVPN route's description. Accepts exactly what
 * `parseIpv4` does: four parts of one to three digits, each at most 255.
 */
function ipv4Bits(text: string): number {
  let bits = 0
  let octet = 0
  let digits = 0
  let parts = 0
  for (let i = 0; i <= text.length; i++) {
    const code = i < text.length ? text.charCodeAt(i) : 46 // '.' closes the last part
    if (code >= 48 && code <= 57) {
      if (++digits > 3) return -1
      octet = octet * 10 + (code - 48)
    } else if (code === 46) {
      if (digits === 0 || octet > 255 || ++parts > 4) return -1
      bits = bits * 256 + octet
      octet = 0
      digits = 0
    } else {
      return -1
    }
  }
  return parts === 4 ? bits : -1
}

/** True for the same network address *and* the same mask length. */
export function equals(a: ParsedPrefix, b: ParsedPrefix): boolean {
  return a.family === b.family && a.length === b.length && a.bits === b.bits
}

/**
 * The network bits written out as text, tagged with the address family:
 * `10.0.0.0/8` becomes `4:00001010`.
 *
 * This exists so containment can be asked the same way in two places. In
 * JavaScript `contains()` is the natural test, but the same question has to be
 * answered in SQL, and DuckDB has no address type here — an IPv6 address does
 * not fit in a SQL integer either. On this key, "inside" is just "starts with",
 * which both languages agree on, and which an index on the column can serve.
 *
 * The family tag keeps an IPv4 prefix from ever matching an IPv6 one that
 * happens to begin with the same bits.
 */
export function bitKey(prefix: ParsedPrefix): string {
  if (prefix.length === 0) return `${prefix.family}:`

  const shift = BigInt(FAMILY_BITS[prefix.family] - prefix.length)
  // toString(2) drops leading zeroes, so pad back out to the mask length.
  const bits = (prefix.bits >> shift).toString(2).padStart(prefix.length, '0')
  return `${prefix.family}:${bits}`
}

/** Bit key for a prefix the BGP parser produced, or null if it is not an address. */
export function bgpPrefixBitKey(prefix: BgpPrefix): string | null {
  const parsed = parseBgpPrefix(prefix)
  return parsed ? bitKey(parsed) : null
}

/**
 * Bit key for a plain address, covering every bit of it. A prefix's key is a
 * string prefix of this exactly when the prefix covers the address.
 */
export function addressBitKey(text: string): string | null {
  const parsed = parsePrefix(text)
  return parsed ? bitKey(parsed) : null
}
