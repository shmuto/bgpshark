import { BinaryReader } from '../pcap/reader'
import { getAfiName, getSafiName } from './constants'
import { DEFAULT_DECODING, afiSafiKey, type UpdateDecoding } from './session'
import { formatEvpnRoute, parseEvpnNlri } from './evpn'
import { parseExtendedCommunities } from './extended-communities'
import type {
  BgpUpdateMessage,
  BgpPrefix,
  BgpPathAttribute,
  ParsedPathAttribute,
  AsPathSegment,
} from './types'

const AS_PATH_TYPE_CODE = 2
const AS4_PATH_TYPE_CODE = 17

// Path Attribute Type Codes
const PATH_ATTR_TYPES: Record<number, string> = {
  1: 'ORIGIN',
  2: 'AS_PATH',
  3: 'NEXT_HOP',
  4: 'MULTI_EXIT_DISC',
  5: 'LOCAL_PREF',
  6: 'ATOMIC_AGGREGATE',
  7: 'AGGREGATOR',
  8: 'COMMUNITIES',
  9: 'ORIGINATOR_ID',
  10: 'CLUSTER_LIST',
  14: 'MP_REACH_NLRI',
  15: 'MP_UNREACH_NLRI',
  16: 'EXTENDED_COMMUNITIES',
  17: 'AS4_PATH',
  18: 'AS4_AGGREGATOR',
  32: 'LARGE_COMMUNITIES',
}

export function parseUpdateMessage(
  data: Uint8Array,
  warnings: string[],
  decoding: UpdateDecoding = DEFAULT_DECODING
): BgpUpdateMessage {
  const reader = new BinaryReader(data, false) // BGP uses network byte order (big-endian)

  // The classic fields carry IPv4 unicast only; anything else travels in
  // MP_REACH/MP_UNREACH, which name their own address family.
  const ipv4Unicast = { afi: 1, addPath: decoding.addPath.has(afiSafiKey(1, 1)) }

  // Withdrawn Routes Length (2 bytes)
  const withdrawnRoutesLength = reader.readUint16()

  // Parse withdrawn routes
  const withdrawnRoutes = parsePrefixes(reader, withdrawnRoutesLength, warnings, ipv4Unicast)

  // Total Path Attribute Length (2 bytes)
  const totalPathAttrLength = reader.readUint16()

  // Parse path attributes
  const pathAttrEnd = reader.getPosition() + totalPathAttrLength
  const pathAttributes: BgpPathAttribute[] = []

  while (reader.getPosition() < pathAttrEnd) {
    try {
      const attr = parsePathAttribute(reader, warnings, decoding)
      pathAttributes.push(attr)
    } catch (e) {
      warnings.push(`Failed to parse path attribute: ${e instanceof Error ? e.message : 'Unknown error'}`)
      break
    }
  }

  // Parse NLRI (remaining bytes)
  const nlriLength = data.length - reader.getPosition()
  const nlri = parsePrefixes(reader, nlriLength, warnings, ipv4Unicast)

  return {
    type: 'UPDATE',
    withdrawnRoutesLength,
    withdrawnRoutes,
    totalPathAttrLength,
    pathAttributes: reconcileAs4Path(pathAttributes),
    nlri,
  }
}

/** Longest prefix each family can have; anything above it is corruption. */
const MAX_PREFIX_LENGTH: Record<number, number> = { 1: 32, 2: 128 }

/**
 * An unknown family is read as IPv4, so it takes IPv4's limit — a longer
 * "prefix" would be more bytes than an IPv4 address can hold, and formatting
 * it as one throws rather than warning.
 */
function maxPrefixLength(afi: number): number {
  return MAX_PREFIX_LENGTH[afi] ?? 32
}

/** SAFI 70: EVPN, whose NLRI is a tagged union rather than a list of prefixes. */
const SAFI_EVPN = 70

/** EVPN routes ride through the prefix pipeline carrying their decoded form. */
function evpnPrefixes(reader: BinaryReader, length: number, warnings: string[]): BgpPrefix[] {
  return parseEvpnNlri(reader, length, warnings).map((route) => ({
    prefix: formatEvpnRoute(route),
    length: 0,
    evpn: route,
  }))
}

/**
 * Read a run of NLRI entries.
 *
 * `addPath` says each entry is preceded by a 4-byte Path Identifier
 * (RFC 7911), which is negotiated in the OPEN and invisible in the UPDATE —
 * read the wrong way, a Path Identifier's leading bytes look like prefix
 * lengths and the run decodes into routes nobody announced.
 *
 * Both the prefix length and the run's own bounds are checked, because a run
 * that has gone wrong should say so rather than keep manufacturing prefixes:
 * without the length check, a mis-decoded run happily yields 0.0.0.0/0.
 */
function parsePrefixes(
  reader: BinaryReader,
  length: number,
  warnings: string[],
  options: { afi?: number; addPath?: boolean } = {}
): BgpPrefix[] {
  const { afi = 1, addPath = false } = options
  const prefixes: BgpPrefix[] = []
  const endPos = reader.getPosition() + length
  const limit = maxPrefixLength(afi)

  while (reader.getPosition() < endPos) {
    if (addPath) {
      if (endPos - reader.getPosition() < 4) {
        warnings.push(
          `NLRI ends mid Path Identifier (${endPos - reader.getPosition()} byte(s) left); ` +
            `${prefixes.length} prefix(es) read before this`
        )
        reader.seek(endPos)
        break
      }
      reader.skip(4)
    }

    const prefixLength = reader.readUint8()
    if (prefixLength > limit) {
      warnings.push(
        `NLRI prefix length ${prefixLength} exceeds the maximum ${limit} for this address family` +
          (addPath ? '' : ' (a session using ADD-PATH would decode this way if its OPEN was not captured)') +
          `; skipping the rest of this NLRI block`
      )
      reader.seek(endPos)
      break
    }

    const prefixBytes = Math.ceil(prefixLength / 8)
    if (reader.getPosition() + prefixBytes > endPos) {
      warnings.push(
        `NLRI prefix of length ${prefixLength} runs past the end of its block; ` +
          `skipping the rest of this NLRI block`
      )
      reader.seek(endPos)
      break
    }

    const octets = reader.readBytes(prefixBytes)
    const prefix = afi === 2 ? formatIpv6Prefix(octets, prefixLength) : formatIpv4Prefix(octets, prefixLength)

    prefixes.push({ prefix, length: prefixLength })
  }

  return prefixes
}

function formatIpv4Prefix(octets: Uint8Array, _prefixLength: number): string {
  const fullOctets = new Uint8Array(4)
  fullOctets.set(octets)
  return `${fullOctets[0]}.${fullOctets[1]}.${fullOctets[2]}.${fullOctets[3]}`
}

/**
 * Exported because a NOTIFICATION's data field can be an attribute too: RFC
 * 4271 §6.3 says an UPDATE Message Error carries the one that caused it, and
 * decoding that by any other reader would be a second implementation of this.
 *
 * `decoding` defaults because a NOTIFICATION's copy of an attribute arrives
 * without the session context an UPDATE has — and the attributes that context
 * governs, AS_PATH width and ADD-PATH identifiers, are not what a bad-attribute
 * error is usually about.
 */
export function parsePathAttribute(
  reader: BinaryReader,
  warnings: string[],
  decoding: UpdateDecoding = DEFAULT_DECODING
): BgpPathAttribute {
  const flagsByte = reader.readUint8()
  const flags = {
    optional: (flagsByte & 0x80) !== 0,
    transitive: (flagsByte & 0x40) !== 0,
    partial: (flagsByte & 0x20) !== 0,
    extendedLength: (flagsByte & 0x10) !== 0,
  }

  const typeCode = reader.readUint8()
  const typeName = PATH_ATTR_TYPES[typeCode] ?? `UNKNOWN(${typeCode})`

  const length = flags.extendedLength ? reader.readUint16() : reader.readUint8()

  const rawValue = reader.readBytes(length)

  // Try to parse the attribute value
  let parsed: ParsedPathAttribute | undefined

  try {
    parsed = parsePathAttributeValue(typeCode, rawValue, warnings, decoding)
  } catch (e) {
    warnings.push(`Failed to parse ${typeName}: ${e instanceof Error ? e.message : 'Unknown error'}`)
  }

  return {
    flags,
    typeCode,
    typeName,
    length,
    rawValue,
    parsed,
  }
}

function parsePathAttributeValue(
  typeCode: number,
  data: Uint8Array,
  warnings: string[],
  decoding: UpdateDecoding
): ParsedPathAttribute | undefined {
  const reader = new BinaryReader(data, false) // BGP uses network byte order (big-endian)

  switch (typeCode) {
    case 1: { // ORIGIN
      const originValue = reader.readUint8()
      const origins = ['IGP', 'EGP', 'INCOMPLETE'] as const
      return {
        type: 'ORIGIN',
        value: origins[originValue] ?? 'INCOMPLETE',
      }
    }

    case 2: // AS_PATH
    case 17: { // AS4_PATH
      // AS4_PATH is 4-byte by definition. AS_PATH follows what the session
      // negotiated; without an observed OPEN it is read off the structure.
      if (typeCode === AS4_PATH_TYPE_CODE) return parseAsPath(reader, true)

      if (decoding.fourByteAs !== null) return parseAsPath(reader, decoding.fourByteAs)

      const { asSize, ambiguous } = detectAsSize(data)
      if (ambiguous) {
        warnings.push(
          'AS_PATH fits both 2-byte and 4-byte AS numbers and no OPEN was captured for this ' +
            'session, so the AS numbers shown are the 4-byte reading and may be wrong'
        )
      }
      return parseAsPath(reader, asSize === 4)
    }

    case 3: // NEXT_HOP
      return {
        type: 'NEXT_HOP',
        address: reader.readIpv4Address(),
      }

    case 4: // MULTI_EXIT_DISC
      return {
        type: 'MULTI_EXIT_DISC',
        value: reader.readUint32(),
      }

    case 5: // LOCAL_PREF
      return {
        type: 'LOCAL_PREF',
        value: reader.readUint32(),
      }

    case 6: // ATOMIC_AGGREGATE
      return { type: 'ATOMIC_AGGREGATE' }

    case 7: // AGGREGATOR
    case 18: { // AS4_AGGREGATOR
      const is4byte = typeCode === 18
      return {
        type: 'AGGREGATOR',
        asNumber: is4byte ? reader.readUint32() : reader.readUint16(),
        address: reader.readIpv4Address(),
      }
    }

    case 8: // COMMUNITIES
      return parseCommunities(reader, data.length)

    case 16: // EXTENDED_COMMUNITIES
      return { type: 'EXTENDED_COMMUNITIES', communities: parseExtendedCommunities(reader, data.length) }

    case 14: // MP_REACH_NLRI
      return parseMpReachNlri(reader, data.length, warnings, decoding)

    case 15: // MP_UNREACH_NLRI
      return parseMpUnreachNlri(reader, data.length, warnings, decoding)

    case 32: // LARGE_COMMUNITIES
      return parseLargeCommunities(reader, data.length)

    default:
      return { type: 'UNKNOWN' }
  }
}

/**
 * Does this attribute body decode cleanly as AS_PATH with `asSize`-byte AS
 * numbers — every segment well-formed, consuming the body exactly?
 *
 * This replaces guessing the AS size from how the byte count divides. That
 * guess is wrong in both directions once an AS_PATH has more than one segment
 * (an aggregated path carrying an AS_SET, say): a two-byte path can land
 * exactly on the four-byte arithmetic and decode into AS numbers that were
 * never on the wire, silently. Walking the segments answers the question the
 * arithmetic was standing in for.
 */
function asPathFits(body: Uint8Array, asSize: 2 | 4): boolean {
  let offset = 0
  while (offset < body.length) {
    if (offset + 2 > body.length) return false
    const segType = body[offset]
    const segLength = body[offset + 1]
    if (segType < 1 || segType > 4 || segLength === 0) return false
    offset += 2 + segLength * asSize
  }
  return offset === body.length
}

/**
 * Decide the AS size for an AS_PATH whose session was never observed.
 *
 * A single-segment path can only fit one way, so the common case is decided.
 * A multi-segment path — an aggregated route carrying an AS_SET, typically —
 * can fit both ways, and then there is nothing in the attribute to separate
 * them: the same bytes are two AS numbers or one, depending on an agreement
 * made in an OPEN this capture does not contain. Four bytes is the better
 * guess (every current session negotiates RFC 6793) but it stays a guess, and
 * the caller says so rather than presenting either reading as fact.
 */
function detectAsSize(body: Uint8Array): { asSize: 2 | 4; ambiguous: boolean } {
  const fitsFour = asPathFits(body, 4)
  const fitsTwo = asPathFits(body, 2)

  if (fitsFour && fitsTwo) return { asSize: 4, ambiguous: true }
  if (fitsTwo) return { asSize: 2, ambiguous: false }
  return { asSize: 4, ambiguous: false }
}

function parseAsPath(reader: BinaryReader, is4byte: boolean): ParsedPathAttribute {
  const segments: AsPathSegment[] = []

  const typeNames: Record<number, AsPathSegment['type']> = {
    1: 'AS_SET',
    2: 'AS_SEQUENCE',
    3: 'AS_CONFED_SEQUENCE',
    4: 'AS_CONFED_SET',
  }

  while (reader.hasMore()) {
    const segType = reader.readUint8()
    const segLength = reader.readUint8()

    const asNumbers: number[] = []
    for (let i = 0; i < segLength; i++) {
      asNumbers.push(is4byte ? reader.readUint32() : reader.readUint16())
    }

    segments.push({
      type: typeNames[segType] ?? 'AS_SEQUENCE',
      asNumbers,
    })
  }

  return { type: 'AS_PATH', segments }
}

function parseCommunities(reader: BinaryReader, length: number): ParsedPathAttribute {
  const communities: string[] = []
  const count = length / 4

  for (let i = 0; i < count; i++) {
    const value = reader.readUint32()
    const high = (value >> 16) & 0xffff
    const low = value & 0xffff

    // Well-known communities
    if (value === 0xffffff01) {
      communities.push('NO_EXPORT')
    } else if (value === 0xffffff02) {
      communities.push('NO_ADVERTISE')
    } else if (value === 0xffffff03) {
      communities.push('NO_EXPORT_SUBCONFED')
    } else if (value === 0xffffff04) {
      communities.push('NOPEER')
    } else {
      communities.push(`${high}:${low}`)
    }
  }

  return { type: 'COMMUNITIES', communities }
}

function parseLargeCommunities(reader: BinaryReader, length: number): ParsedPathAttribute {
  const communities: Array<{ globalAdmin: number; localData1: number; localData2: number }> = []
  const count = length / 12

  for (let i = 0; i < count; i++) {
    communities.push({
      globalAdmin: reader.readUint32(),
      localData1: reader.readUint32(),
      localData2: reader.readUint32(),
    })
  }

  return { type: 'LARGE_COMMUNITIES', communities }
}

function parseMpReachNlri(
  reader: BinaryReader,
  _length: number,
  warnings: string[],
  decoding: UpdateDecoding
): ParsedPathAttribute {
  const afi = reader.readUint16()
  const safi = reader.readUint8()
  const nextHopLength = reader.readUint8()

  // The next hop's width says what it is, and the AFI does not: EVPN and the
  // VPN families all carry a plain IPv4 or IPv6 address here (the VTEP, for a
  // fabric), and VPN next hops arrive with an 8-byte zero RD in front.
  let nextHop = ''
  if (nextHopLength === 4) {
    nextHop = reader.readIpv4Address()
  } else if (nextHopLength === 12) {
    reader.skip(8) // RD, always zero on a next hop
    nextHop = reader.readIpv4Address()
  } else if (nextHopLength === 16) {
    nextHop = reader.readIpv6Address()
  } else if (nextHopLength === 24) {
    reader.skip(8) // RD, as above
    nextHop = reader.readIpv6Address()
  } else if (nextHopLength === 32) {
    // Global address followed by a link-local one; the global is the useful half.
    nextHop = reader.readIpv6Address()
    reader.skip(16)
  } else {
    reader.skip(nextHopLength)
    nextHop = `(${nextHopLength} bytes)`
  }

  // Reserved byte
  reader.readUint8()

  // Parse NLRI
  const nlri: BgpPrefix[] = []
  // The rest of the attribute is one NLRI block. EVPN frames its entries by
  // route type rather than by prefix length, so it needs its own reader.
  nlri.push(
    ...(safi === SAFI_EVPN
      ? evpnPrefixes(reader, reader.remaining(), warnings)
      : parsePrefixes(reader, reader.remaining(), warnings, {
          afi,
          addPath: decoding.addPath.has(afiSafiKey(afi, safi)),
        }))
  )

  return {
    type: 'MP_REACH_NLRI',
    afi,
    afiName: getAfiName(afi),
    safi,
    safiName: getSafiName(safi),
    nextHop,
    nlri,
  }
}

function parseMpUnreachNlri(
  reader: BinaryReader,
  _length: number,
  warnings: string[],
  decoding: UpdateDecoding
): ParsedPathAttribute {
  const afi = reader.readUint16()
  const safi = reader.readUint8()

  const withdrawnRoutes =
    safi === SAFI_EVPN
      ? evpnPrefixes(reader, reader.remaining(), warnings)
      : parsePrefixes(reader, reader.remaining(), warnings, {
          afi,
          addPath: decoding.addPath.has(afiSafiKey(afi, safi)),
        })

  return {
    type: 'MP_UNREACH_NLRI',
    afi,
    afiName: getAfiName(afi),
    safi,
    safiName: getSafiName(safi),
    withdrawnRoutes,
  }
}


function formatIpv6Prefix(octets: Uint8Array, _prefixLength: number): string {
  const fullOctets = new Uint8Array(16)
  fullOctets.set(octets)

  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) {
    const value = (fullOctets[i] << 8) | fullOctets[i + 1]
    groups.push(value.toString(16))
  }

  // Simple IPv6 formatting (no zero compression)
  return groups.join(':')
}

/**
 * Detect an End-of-RIB marker (RFC 4724 §2).
 *
 * For IPv4 unicast the marker is the smallest possible UPDATE: no withdrawn
 * routes and no path attributes at all. For any other AFI/SAFI it is an UPDATE
 * whose only path attribute is an MP_UNREACH_NLRI that withdraws nothing.
 * Returns a display label ("IPv4 Unicast", "IPv6 Unicast", …) or null.
 *
 * This is worth surfacing because EoR is the landmark of a converged initial
 * advertisement — the thing to look for after a session (re-)establishes,
 * especially around graceful restart.
 */
export function endOfRibMarker(update: BgpUpdateMessage): string | null {
  if (update.withdrawnRoutes.length > 0 || update.nlri.length > 0) return null

  if (update.pathAttributes.length === 0) {
    return 'IPv4 Unicast'
  }

  if (update.pathAttributes.length === 1) {
    const parsed = update.pathAttributes[0].parsed
    if (parsed?.type === 'MP_UNREACH_NLRI' && parsed.withdrawnRoutes.length === 0) {
      return `${parsed.afiName} ${parsed.safiName}`
    }
  }

  return null
}

/**
 * Announced / withdrawn prefix totals across both the classic IPv4 fields and
 * the MP_REACH/MP_UNREACH attributes, so summaries agree with what the route
 * analysis screen counts.
 */
export function countUpdatePrefixes(update: BgpUpdateMessage): {
  announced: number
  withdrawn: number
} {
  let announced = update.nlri.length
  let withdrawn = update.withdrawnRoutes.length
  for (const attr of update.pathAttributes) {
    if (attr.parsed?.type === 'MP_REACH_NLRI') announced += attr.parsed.nlri.length
    if (attr.parsed?.type === 'MP_UNREACH_NLRI') withdrawn += attr.parsed.withdrawnRoutes.length
  }
  return { announced, withdrawn }
}

/**
 * Rebuild AS_PATH from AS4_PATH where the two disagree (RFC 6793 §4.2.3).
 *
 * A 4-byte AS number crossing a speaker that only understands 2-byte ones is
 * replaced in AS_PATH by AS_TRANS (23456), with the real numbers carried
 * alongside in AS4_PATH. Reading AS_PATH alone therefore reports 23456 as the
 * neighbour — everywhere: the route history, the AS path column, an `asn =`
 * filter. The reconstruction takes the tail of AS_PATH from AS4_PATH, keeping
 * the leading hops that only AS_PATH knows about.
 *
 * Both attributes are left in place; the detail view showing what actually
 * arrived is worth more than a tidy list.
 */
function reconcileAs4Path(attributes: BgpPathAttribute[]): BgpPathAttribute[] {
  const asPathIndex = attributes.findIndex((a) => a.typeCode === AS_PATH_TYPE_CODE)
  const as4Path = attributes.find((a) => a.typeCode === AS4_PATH_TYPE_CODE)
  if (asPathIndex < 0 || !as4Path) return attributes

  const asPath = attributes[asPathIndex].parsed
  if (asPath?.type !== 'AS_PATH' || as4Path.parsed?.type !== 'AS_PATH') return attributes

  const merged = mergeAsPathSegments(asPath.segments, as4Path.parsed.segments)
  if (!merged) return attributes

  const rebuilt = [...attributes]
  rebuilt[asPathIndex] = {
    ...attributes[asPathIndex],
    parsed: { type: 'AS_PATH', segments: merged },
  }
  return rebuilt
}

/** Count of AS numbers in a path, with an AS_SET counting as one hop (RFC 4271). */
function asPathHopCount(segments: AsPathSegment[]): number {
  return segments.reduce(
    (total, segment) =>
      total + (segment.type === 'AS_SET' || segment.type === 'AS_CONFED_SET' ? 1 : segment.asNumbers.length),
    0
  )
}

/**
 * Replace the last `AS4_PATH`-worth of hops in `asPath` with `as4Path`.
 * Returns null when AS4_PATH is the longer of the two, which RFC 6793 says to
 * treat as AS_PATH being authoritative.
 */
function mergeAsPathSegments(
  asPath: AsPathSegment[],
  as4Path: AsPathSegment[]
): AsPathSegment[] | null {
  const keep = asPathHopCount(asPath) - asPathHopCount(as4Path)
  if (keep < 0) return null

  const head: AsPathSegment[] = []
  let remaining = keep
  for (const segment of asPath) {
    if (remaining <= 0) break
    const hops = segment.type === 'AS_SET' || segment.type === 'AS_CONFED_SET' ? 1 : segment.asNumbers.length
    if (hops <= remaining) {
      head.push(segment)
      remaining -= hops
    } else {
      head.push({ ...segment, asNumbers: segment.asNumbers.slice(0, remaining) })
      remaining = 0
    }
  }

  return [...head, ...as4Path]
}
