/**
 * Encode BGP messages to their wire form.
 *
 * This is the mirror of `lib/bgp/*` — whatever the parsers there read, the
 * encoders here write, and the round-trip tests hold the two together. Where
 * the parsers take bytes and produce a description, these take a description
 * and produce bytes, so the input types are the *spec* types below rather than
 * the parsed types: a spec says `{ type: 'ORIGIN', value: 'IGP' }` and leaves
 * lengths, flags and attribute ordering to the encoder, because those are
 * derived facts and a builder that made you supply them would mostly be a way
 * to get them wrong.
 *
 * Two things about an UPDATE's encoding are not visible in the UPDATE itself —
 * the width of an AS number in AS_PATH, and whether NLRI carries a Path
 * Identifier. Both are settled in the OPEN exchange (see `lib/bgp/session.ts`),
 * so both arrive here as `EncodeOptions`, the same agreement seen from the
 * writing side.
 */
import { ByteWriter, addressBytes, parsePrefixText, writePrefix } from './bytes'
import { Afi, CapabilityCode, Safi } from '../bgp/constants'
import { afiSafiKey } from '../bgp/session'
import { BgpMessageType } from '../bgp/types'

const BGP_HEADER_LENGTH = 19
export const BGP_MAX_MESSAGE_LENGTH = 4096

/** RFC 6793's stand-in for a 4-byte AS in a 2-byte field. */
export const AS_TRANS = 23456

/** How the session this message belongs to agreed its UPDATEs would be read. */
export interface EncodeOptions {
  /** AS_PATH and AGGREGATOR carry 4-byte AS numbers (RFC 6793). Default true. */
  fourByteAs?: boolean
  /** `afi/safi` keys whose NLRI is preceded by a Path Identifier (RFC 7911). */
  addPath?: ReadonlySet<string>
}

interface ResolvedOptions {
  fourByteAs: boolean
  addPath: ReadonlySet<string>
}

function resolve(options: EncodeOptions | undefined): ResolvedOptions {
  return {
    fourByteAs: options?.fourByteAs ?? true,
    addPath: options?.addPath ?? new Set(),
  }
}

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

/** A prefix as text (`10.0.0.0/24`), or one carrying an ADD-PATH identifier. */
export type PrefixSpec = string | { prefix: string; pathId?: number }

export type CapabilitySpec =
  | { type: 'MULTIPROTOCOL'; afi: number; safi: number }
  | { type: 'ROUTE_REFRESH' }
  | { type: 'ENHANCED_ROUTE_REFRESH' }
  | { type: 'FOUR_OCTET_AS'; asNumber: number }
  | {
      type: 'GRACEFUL_RESTART'
      restartFlags?: number
      restartTime: number
      addressFamilies?: Array<{ afi: number; safi: number; flags?: number }>
    }
  | {
      type: 'ADD_PATH'
      addressFamilies: Array<{ afi: number; safi: number; sendReceive: 'receive' | 'send' | 'both' }>
    }
  /** Anything with no first-class spec — a capability code and its value. */
  | { type: 'RAW'; code: number; value?: Uint8Array }

export interface OpenSpec {
  type: 'OPEN'
  /** Always 4 in practice; settable so a version-mismatch NOTIFICATION has a cause. */
  version?: number
  /**
   * The AS this speaker claims. Above 65535 it is written as AS_TRANS with the
   * real number carried in the 4-byte AS capability, which is what RFC 6793
   * requires and what a real speaker sends.
   */
  myAs: number
  holdTime: number
  bgpIdentifier: string
  capabilities?: CapabilitySpec[]
}

export type PathAttributeSpec =
  | { type: 'ORIGIN'; value: 'IGP' | 'EGP' | 'INCOMPLETE' }
  | { type: 'AS_PATH'; segments: Array<{ type?: AsPathSegmentType; asNumbers: number[] }> }
  | { type: 'AS4_PATH'; segments: Array<{ type?: AsPathSegmentType; asNumbers: number[] }> }
  | { type: 'NEXT_HOP'; address: string }
  | { type: 'MULTI_EXIT_DISC'; value: number }
  | { type: 'LOCAL_PREF'; value: number }
  | { type: 'ATOMIC_AGGREGATE' }
  | { type: 'AGGREGATOR'; asNumber: number; address: string }
  /** `65000:100`, `NO_EXPORT`, … */
  | { type: 'COMMUNITIES'; communities: string[] }
  | { type: 'LARGE_COMMUNITIES'; communities: Array<[number, number, number]> }
  | {
      type: 'MP_REACH_NLRI'
      afi: number
      safi: number
      nextHop: string
      /** Set alongside `nextHop` to send the 32-byte global+link-local form. */
      linkLocalNextHop?: string
      nlri: PrefixSpec[]
    }
  | { type: 'MP_UNREACH_NLRI'; afi: number; safi: number; withdrawnRoutes: PrefixSpec[] }
  /** An attribute the encoder has no opinion about — flags, code and value verbatim. */
  | { type: 'RAW'; flags: number; typeCode: number; value: Uint8Array }

export type AsPathSegmentType = 'AS_SET' | 'AS_SEQUENCE' | 'AS_CONFED_SEQUENCE' | 'AS_CONFED_SET'

export interface UpdateSpec {
  type: 'UPDATE'
  withdrawnRoutes?: PrefixSpec[]
  pathAttributes?: PathAttributeSpec[]
  nlri?: PrefixSpec[]
}

export interface NotificationSpec {
  type: 'NOTIFICATION'
  errorCode: number
  errorSubcode: number
  data?: Uint8Array
}

export interface KeepaliveSpec {
  type: 'KEEPALIVE'
}

export interface RouteRefreshSpec {
  type: 'ROUTE_REFRESH'
  afi: number
  safi: number
}

export type BgpMessageSpec =
  | OpenSpec
  | UpdateSpec
  | NotificationSpec
  | KeepaliveSpec
  | RouteRefreshSpec

// ---------------------------------------------------------------------------
// Message framing
// ---------------------------------------------------------------------------

/**
 * Wrap a message body in the 19-byte BGP header: 16 marker bytes, the total
 * length including the header, and the type.
 */
function frameMessage(type: number, body: Uint8Array): Uint8Array {
  const total = BGP_HEADER_LENGTH + body.length
  if (total > BGP_MAX_MESSAGE_LENGTH) {
    throw new Error(
      `BGP message is ${total} bytes, over the ${BGP_MAX_MESSAGE_LENGTH}-byte maximum ` +
        `(RFC 4271 §4.1). Split the NLRI across more UPDATEs.`
    )
  }

  const writer = new ByteWriter()
  for (let i = 0; i < 16; i++) writer.u8(0xff)
  writer.u16(total)
  writer.u8(type)
  writer.bytes(body)
  return writer.toBytes()
}

/** One BGP message, header and all, ready to go into a TCP payload. */
export function encodeMessage(spec: BgpMessageSpec, options?: EncodeOptions): Uint8Array {
  const resolved = resolve(options)

  switch (spec.type) {
    case 'OPEN':
      return frameMessage(BgpMessageType.OPEN, encodeOpenBody(spec))
    case 'UPDATE':
      return frameMessage(BgpMessageType.UPDATE, encodeUpdateBody(spec, resolved))
    case 'NOTIFICATION':
      return frameMessage(BgpMessageType.NOTIFICATION, encodeNotificationBody(spec))
    case 'KEEPALIVE':
      return frameMessage(BgpMessageType.KEEPALIVE, new Uint8Array(0))
    case 'ROUTE_REFRESH':
      return frameMessage(BgpMessageType.ROUTE_REFRESH, encodeRouteRefreshBody(spec))
  }
}

// ---------------------------------------------------------------------------
// OPEN
// ---------------------------------------------------------------------------

function encodeOpenBody(spec: OpenSpec): Uint8Array {
  const capabilities = withFourByteAs(spec)
  const writer = new ByteWriter()

  writer.u8(spec.version ?? 4)
  writer.u16(spec.myAs > 0xffff ? AS_TRANS : spec.myAs)
  writer.u16(spec.holdTime)
  writer.bytes(addressBytes(spec.bgpIdentifier, 4))

  if (capabilities.length === 0) {
    writer.u8(0)
    return writer.toBytes()
  }

  // All capabilities travel in a single optional parameter of type 2. One
  // parameter per capability is equally legal and some speakers send that, but
  // this is the common encoding and the one a reader is least surprised by.
  const caps = new ByteWriter()
  for (const capability of capabilities) {
    encodeCapability(caps, capability)
  }
  const capBytes = caps.toBytes()

  writer.u8(capBytes.length + 2) // Optional Parameters Length
  writer.u8(2) // Parameter Type: Capabilities
  writer.u8(capBytes.length)
  writer.bytes(capBytes)

  return writer.toBytes()
}

/**
 * A 4-byte AS number in `myAs` only reaches the wire through the capability, so
 * add it when the spec did not, rather than silently sending AS_TRANS as the
 * speaker's real identity.
 */
function withFourByteAs(spec: OpenSpec): CapabilitySpec[] {
  const capabilities = spec.capabilities ?? []
  if (spec.myAs <= 0xffff) return capabilities
  if (capabilities.some((c) => c.type === 'FOUR_OCTET_AS')) return capabilities
  return [...capabilities, { type: 'FOUR_OCTET_AS', asNumber: spec.myAs }]
}

function encodeCapability(writer: ByteWriter, spec: CapabilitySpec): void {
  const value = new ByteWriter()
  let code: number

  switch (spec.type) {
    case 'MULTIPROTOCOL':
      code = CapabilityCode.MULTIPROTOCOL
      value.u16(spec.afi).u8(0).u8(spec.safi)
      break

    case 'ROUTE_REFRESH':
      code = CapabilityCode.ROUTE_REFRESH
      break

    case 'ENHANCED_ROUTE_REFRESH':
      code = CapabilityCode.ENHANCED_ROUTE_REFRESH
      break

    case 'FOUR_OCTET_AS':
      code = CapabilityCode.FOUR_OCTET_AS
      value.u32(spec.asNumber)
      break

    case 'GRACEFUL_RESTART': {
      code = CapabilityCode.GRACEFUL_RESTART
      // Restart flags occupy the top nibble of the same 16-bit field the
      // restart time uses the low 12 bits of.
      value.u16(((spec.restartFlags ?? 0) << 12) | (spec.restartTime & 0x0fff))
      for (const family of spec.addressFamilies ?? []) {
        value.u16(family.afi).u8(family.safi).u8(family.flags ?? 0)
      }
      break
    }

    case 'ADD_PATH': {
      code = CapabilityCode.ADD_PATH
      const sendReceiveValues = { receive: 1, send: 2, both: 3 } as const
      for (const family of spec.addressFamilies) {
        value.u16(family.afi).u8(family.safi).u8(sendReceiveValues[family.sendReceive])
      }
      break
    }

    case 'RAW':
      code = spec.code
      if (spec.value) value.bytes(spec.value)
      break
  }

  const valueBytes = value.toBytes()
  writer.u8(code).u8(valueBytes.length).bytes(valueBytes)
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

function encodeUpdateBody(spec: UpdateSpec, options: ResolvedOptions): Uint8Array {
  const writer = new ByteWriter()

  // The classic withdrawn/NLRI fields are IPv4 unicast by definition, so their
  // ADD-PATH state is that family's regardless of what else was negotiated.
  const ipv4Unicast = options.addPath.has(afiSafiKey(Afi.IPV4, Safi.UNICAST))

  const withdrawn = encodePrefixes(spec.withdrawnRoutes ?? [], ipv4Unicast)
  writer.u16(withdrawn.length).bytes(withdrawn)

  const attributes = new ByteWriter()
  for (const attribute of spec.pathAttributes ?? []) {
    encodePathAttribute(attributes, attribute, options)
  }
  const attributeBytes = attributes.toBytes()
  writer.u16(attributeBytes.length).bytes(attributeBytes)

  writer.bytes(encodePrefixes(spec.nlri ?? [], ipv4Unicast))

  return writer.toBytes()
}

function encodePrefixes(prefixes: PrefixSpec[], addPath: boolean): Uint8Array {
  const writer = new ByteWriter()

  for (const entry of prefixes) {
    const text = typeof entry === 'string' ? entry : entry.prefix
    if (addPath) {
      writer.u32(typeof entry === 'string' ? 1 : (entry.pathId ?? 1))
    }
    writePrefix(writer, parsePrefixText(text))
  }

  return writer.toBytes()
}

/**
 * Attribute flags, keyed by type code (RFC 4271 §5 and the RFCs that add to
 * it). Getting these wrong does not stop this app decoding the attribute, but
 * it does stop a real speaker accepting it, and the point of a generated
 * capture is that it looks like one a router produced.
 */
const ATTRIBUTE_FLAGS: Record<number, number> = {
  1: 0x40, // ORIGIN — well-known transitive
  2: 0x40, // AS_PATH — well-known transitive
  3: 0x40, // NEXT_HOP — well-known transitive
  4: 0x80, // MULTI_EXIT_DISC — optional non-transitive
  5: 0x40, // LOCAL_PREF — well-known transitive
  6: 0x40, // ATOMIC_AGGREGATE — well-known transitive
  7: 0xc0, // AGGREGATOR — optional transitive
  8: 0xc0, // COMMUNITIES — optional transitive
  14: 0x80, // MP_REACH_NLRI — optional non-transitive
  15: 0x80, // MP_UNREACH_NLRI — optional non-transitive
  17: 0xc0, // AS4_PATH — optional transitive
  32: 0xc0, // LARGE_COMMUNITIES — optional transitive
}

const ATTRIBUTE_TYPE_CODES: Record<Exclude<PathAttributeSpec['type'], 'RAW'>, number> = {
  ORIGIN: 1,
  AS_PATH: 2,
  NEXT_HOP: 3,
  MULTI_EXIT_DISC: 4,
  LOCAL_PREF: 5,
  ATOMIC_AGGREGATE: 6,
  AGGREGATOR: 7,
  COMMUNITIES: 8,
  MP_REACH_NLRI: 14,
  MP_UNREACH_NLRI: 15,
  AS4_PATH: 17,
  LARGE_COMMUNITIES: 32,
}

function encodePathAttribute(
  writer: ByteWriter,
  spec: PathAttributeSpec,
  options: ResolvedOptions
): void {
  if (spec.type === 'RAW') {
    writeAttribute(writer, spec.flags, spec.typeCode, spec.value)
    return
  }

  const typeCode = ATTRIBUTE_TYPE_CODES[spec.type]
  writeAttribute(writer, ATTRIBUTE_FLAGS[typeCode], typeCode, encodeAttributeValue(spec, options))
}

/**
 * Write one attribute, choosing the length form. A value over 255 bytes needs
 * the 2-byte length, which is signalled by the Extended Length flag — a full
 * table's worth of NLRI in one MP_REACH reaches that easily.
 */
function writeAttribute(
  writer: ByteWriter,
  flags: number,
  typeCode: number,
  value: Uint8Array
): void {
  const extended = value.length > 0xff
  writer.u8(extended ? flags | 0x10 : flags & ~0x10)
  writer.u8(typeCode)
  if (extended) {
    writer.u16(value.length)
  } else {
    writer.u8(value.length)
  }
  writer.bytes(value)
}

function encodeAttributeValue(
  spec: Exclude<PathAttributeSpec, { type: 'RAW' }>,
  options: ResolvedOptions
): Uint8Array {
  const value = new ByteWriter()

  switch (spec.type) {
    case 'ORIGIN':
      value.u8({ IGP: 0, EGP: 1, INCOMPLETE: 2 }[spec.value])
      break

    case 'AS_PATH':
      writeAsPath(value, spec.segments, options.fourByteAs)
      break

    case 'AS4_PATH':
      // AS4_PATH is 4-byte by definition — that is the whole reason it exists.
      writeAsPath(value, spec.segments, true)
      break

    case 'NEXT_HOP':
      value.bytes(addressBytes(spec.address, 4))
      break

    case 'MULTI_EXIT_DISC':
    case 'LOCAL_PREF':
      value.u32(spec.value)
      break

    case 'ATOMIC_AGGREGATE':
      break

    case 'AGGREGATOR':
      if (options.fourByteAs) {
        value.u32(spec.asNumber)
      } else {
        value.u16(spec.asNumber > 0xffff ? AS_TRANS : spec.asNumber)
      }
      value.bytes(addressBytes(spec.address, 4))
      break

    case 'COMMUNITIES':
      for (const community of spec.communities) {
        value.u32(parseCommunity(community))
      }
      break

    case 'LARGE_COMMUNITIES':
      for (const [globalAdmin, localData1, localData2] of spec.communities) {
        value.u32(globalAdmin).u32(localData1).u32(localData2)
      }
      break

    case 'MP_REACH_NLRI': {
      value.u16(spec.afi).u8(spec.safi)
      const family = spec.afi === Afi.IPV6 ? 6 : 4
      const nextHop = addressBytes(spec.nextHop, family)
      const linkLocal = spec.linkLocalNextHop
        ? addressBytes(spec.linkLocalNextHop, 6)
        : new Uint8Array(0)
      value.u8(nextHop.length + linkLocal.length)
      value.bytes(nextHop).bytes(linkLocal)
      value.u8(0) // Reserved
      value.bytes(encodePrefixes(spec.nlri, options.addPath.has(afiSafiKey(spec.afi, spec.safi))))
      break
    }

    case 'MP_UNREACH_NLRI':
      value.u16(spec.afi).u8(spec.safi)
      value.bytes(
        encodePrefixes(spec.withdrawnRoutes, options.addPath.has(afiSafiKey(spec.afi, spec.safi)))
      )
      break
  }

  return value.toBytes()
}

const AS_PATH_SEGMENT_TYPES: Record<AsPathSegmentType, number> = {
  AS_SET: 1,
  AS_SEQUENCE: 2,
  AS_CONFED_SEQUENCE: 3,
  AS_CONFED_SET: 4,
}

function writeAsPath(
  writer: ByteWriter,
  segments: Array<{ type?: AsPathSegmentType; asNumbers: number[] }>,
  fourByteAs: boolean
): void {
  for (const segment of segments) {
    writer.u8(AS_PATH_SEGMENT_TYPES[segment.type ?? 'AS_SEQUENCE'])
    writer.u8(segment.asNumbers.length)
    for (const asNumber of segment.asNumbers) {
      if (fourByteAs) {
        writer.u32(asNumber)
      } else {
        writer.u16(asNumber > 0xffff ? AS_TRANS : asNumber)
      }
    }
  }
}

const WELL_KNOWN_COMMUNITIES: Record<string, number> = {
  NO_EXPORT: 0xffffff01,
  NO_ADVERTISE: 0xffffff02,
  NO_EXPORT_SUBCONFED: 0xffffff03,
  NOPEER: 0xffffff04,
}

/** `65000:100`, a well-known name, or a bare 32-bit value. */
function parseCommunity(text: string): number {
  const trimmed = text.trim()

  const wellKnown = WELL_KNOWN_COMMUNITIES[trimmed.toUpperCase()]
  if (wellKnown !== undefined) return wellKnown

  const pair = trimmed.match(/^(\d+):(\d+)$/)
  if (pair) {
    const high = Number(pair[1])
    const low = Number(pair[2])
    if (high > 0xffff || low > 0xffff) {
      throw new Error(`Community "${trimmed}" has a part above 65535`)
    }
    return ((high << 16) >>> 0) + low
  }

  if (/^\d+$/.test(trimmed)) return Number(trimmed) >>> 0

  throw new Error(`Not a community: "${text}"`)
}

// ---------------------------------------------------------------------------
// NOTIFICATION / ROUTE-REFRESH
// ---------------------------------------------------------------------------

function encodeNotificationBody(spec: NotificationSpec): Uint8Array {
  const writer = new ByteWriter()
  writer.u8(spec.errorCode).u8(spec.errorSubcode)
  if (spec.data) writer.bytes(spec.data)
  return writer.toBytes()
}

function encodeRouteRefreshBody(spec: RouteRefreshSpec): Uint8Array {
  const writer = new ByteWriter()
  writer.u16(spec.afi).u8(0).u8(spec.safi)
  return writer.toBytes()
}
