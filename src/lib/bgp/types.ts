import type { EvpnRoute } from './evpn'

/**
 * BGP Message Types (RFC 4271)
 */
export const BgpMessageType = {
  OPEN: 1,
  UPDATE: 2,
  NOTIFICATION: 3,
  KEEPALIVE: 4,
  ROUTE_REFRESH: 5,
} as const

export type BgpMessageTypeValue = (typeof BgpMessageType)[keyof typeof BgpMessageType]

export type BgpMessageTypeName = 'OPEN' | 'UPDATE' | 'NOTIFICATION' | 'KEEPALIVE' | 'ROUTE_REFRESH'

/**
 * BGP Message header (19 bytes)
 */
export interface BgpMessageHeader {
  marker: Uint8Array // 16 bytes, all 0xFF
  length: number // 2 bytes
  type: number // 1 byte
}

/**
 * BGP Packet with metadata
 */
export interface BgpPacket {
  frameIndex: number // 1-based index in pcap file
  timestamp: Date
  srcIp: string
  dstIp: string
  srcPort: number
  dstPort: number
  messages: BgpMessage[] // Multiple BGP messages can be in one TCP segment
  rawData: Uint8Array
  parseWarnings: string[]
}

/**
 * Helper to get the primary message (first message in packet)
 */
export function getPrimaryMessage(packet: BgpPacket): BgpMessage {
  return packet.messages[0]
}

/**
 * Union of all BGP message types
 */
export type BgpMessage =
  | BgpOpenMessage
  | BgpUpdateMessage
  | BgpNotificationMessage
  | BgpKeepaliveMessage
  | BgpRouteRefreshMessage

/**
 * BGP OPEN Message (RFC 4271 Section 4.2)
 */
export interface BgpOpenMessage {
  type: 'OPEN'
  version: number
  myAs: number // 2-byte AS (4-byte AS from capability)
  holdTime: number
  bgpIdentifier: string // Router ID in dotted-decimal
  optParamLength: number
  capabilities: BgpCapability[]
  fourByteAs?: number // From 4-byte AS capability
}

/**
 * BGP UPDATE Message (RFC 4271 Section 4.3)
 */
export interface BgpUpdateMessage {
  type: 'UPDATE'
  withdrawnRoutesLength: number
  withdrawnRoutes: BgpPrefix[]
  totalPathAttrLength: number
  pathAttributes: BgpPathAttribute[]
  nlri: BgpPrefix[]
}

/**
 * BGP Prefix (NLRI or Withdrawn)
 */
export interface BgpPrefix {
  prefix: string
  length: number
  /**
   * EVPN routes are not prefixes — they are a tagged union keyed by route
   * type. The structured route lives here; `prefix` carries a readable
   * one-liner so screens that list routes as text still have something to
   * show, and `length` stays 0 because there is no mask to speak of.
   */
  evpn?: EvpnRoute
}

/**
 * BGP Path Attribute
 */
export interface BgpPathAttribute {
  flags: {
    optional: boolean
    transitive: boolean
    partial: boolean
    extendedLength: boolean
  }
  typeCode: number
  typeName: string
  length: number
  rawValue: Uint8Array
  parsed?: ParsedPathAttribute
}

/**
 * Parsed Path Attribute types
 */
export type ParsedPathAttribute =
  | OriginAttribute
  | AsPathAttribute
  | NextHopAttribute
  | MedAttribute
  | LocalPrefAttribute
  | AtomicAggregateAttribute
  | AggregatorAttribute
  | CommunitiesAttribute
  | LargeCommunitiesAttribute
  | MpReachNlriAttribute
  | MpUnreachNlriAttribute
  | UnknownAttribute

export interface OriginAttribute {
  type: 'ORIGIN'
  value: 'IGP' | 'EGP' | 'INCOMPLETE'
}

export interface AsPathAttribute {
  type: 'AS_PATH'
  segments: AsPathSegment[]
}

export interface AsPathSegment {
  type: 'AS_SET' | 'AS_SEQUENCE' | 'AS_CONFED_SEQUENCE' | 'AS_CONFED_SET'
  asNumbers: number[]
}

export interface NextHopAttribute {
  type: 'NEXT_HOP'
  address: string
}

export interface MedAttribute {
  type: 'MULTI_EXIT_DISC'
  value: number
}

export interface LocalPrefAttribute {
  type: 'LOCAL_PREF'
  value: number
}

export interface AtomicAggregateAttribute {
  type: 'ATOMIC_AGGREGATE'
}

export interface AggregatorAttribute {
  type: 'AGGREGATOR'
  asNumber: number
  address: string
}

export interface CommunitiesAttribute {
  type: 'COMMUNITIES'
  communities: string[]
}

export interface LargeCommunitiesAttribute {
  type: 'LARGE_COMMUNITIES'
  communities: Array<{
    globalAdmin: number
    localData1: number
    localData2: number
  }>
}

export interface MpReachNlriAttribute {
  type: 'MP_REACH_NLRI'
  afi: number
  afiName: string
  safi: number
  safiName: string
  nextHop: string
  nlri: BgpPrefix[]
}

export interface MpUnreachNlriAttribute {
  type: 'MP_UNREACH_NLRI'
  afi: number
  afiName: string
  safi: number
  safiName: string
  withdrawnRoutes: BgpPrefix[]
}

export interface UnknownAttribute {
  type: 'UNKNOWN'
}

/**
 * BGP NOTIFICATION Message (RFC 4271 Section 4.5)
 */
export interface BgpNotificationMessage {
  type: 'NOTIFICATION'
  errorCode: number
  errorSubcode: number
  errorCodeName: string
  errorSubcodeName: string
  data: Uint8Array
  hint: string
}

/**
 * BGP KEEPALIVE Message (RFC 4271 Section 4.4)
 */
export interface BgpKeepaliveMessage {
  type: 'KEEPALIVE'
}

/**
 * BGP ROUTE-REFRESH Message (RFC 2918)
 */
export interface BgpRouteRefreshMessage {
  type: 'ROUTE_REFRESH'
  afi: number
  safi: number
  afiName: string
  safiName: string
}

/**
 * BGP Capability (RFC 5492)
 */
export interface BgpCapability {
  code: number
  name: string
  length: number
  rawValue: Uint8Array
  parsed?: ParsedCapability
}

/**
 * Parsed capability details
 */
export type ParsedCapability =
  | MultiprotocolCapability
  | FourOctetAsCapability
  | RouteRefreshCapability
  | GracefulRestartCapability
  | AddPathCapability
  | ExtendedNextHopCapability
  | EnhancedRouteRefreshCapability
  | UnknownCapability

/**
 * Multiprotocol Extensions (RFC 4760)
 */
export interface MultiprotocolCapability {
  type: 'MULTIPROTOCOL'
  afi: number
  afiName: string
  safi: number
  safiName: string
}

/**
 * 4-byte AS Number (RFC 6793)
 */
export interface FourOctetAsCapability {
  type: 'FOUR_OCTET_AS'
  asNumber: number
}

/**
 * Route Refresh (RFC 2918)
 */
export interface RouteRefreshCapability {
  type: 'ROUTE_REFRESH'
}

/**
 * Graceful Restart (RFC 4724)
 */
export interface GracefulRestartCapability {
  type: 'GRACEFUL_RESTART'
  restartFlags: number
  restartTime: number
  addressFamilies: Array<{
    afi: number
    afiName: string
    safi: number
    safiName: string
    flags: number
  }>
}

/**
 * ADD-PATH (RFC 7911)
 */
export interface AddPathCapability {
  type: 'ADD_PATH'
  addressFamilies: Array<{
    afi: number
    afiName: string
    safi: number
    safiName: string
    sendReceive: 'receive' | 'send' | 'both'
  }>
}

/**
 * Extended Next Hop Encoding (RFC 8950)
 */
export interface ExtendedNextHopCapability {
  type: 'EXTENDED_NEXT_HOP'
  entries: Array<{
    nlriAfi: number
    nlriAfiName: string
    nlriSafi: number
    nlriSafiName: string
    nexthopAfi: number
    nexthopAfiName: string
  }>
}

/**
 * Enhanced Route Refresh (RFC 7313)
 */
export interface EnhancedRouteRefreshCapability {
  type: 'ENHANCED_ROUTE_REFRESH'
}

/**
 * Unknown/Unsupported Capability
 */
export interface UnknownCapability {
  type: 'UNKNOWN'
}

/**
 * BGP Parse Result
 */
export interface BgpParseResult {
  packets: BgpPacket[]
  warnings: string[]
}
