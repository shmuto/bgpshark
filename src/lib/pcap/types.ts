/**
 * Link Layer Types (DLT values)
 * @see https://www.tcpdump.org/linktypes.html
 */
export const LinkLayerType = {
  ETHERNET: 1,
  SLL: 113, // Linux cooked capture
} as const

export type LinkLayerTypeValue = (typeof LinkLayerType)[keyof typeof LinkLayerType]

/**
 * Pcap magic numbers for endianness and timestamp precision detection
 */
export const PcapMagic = {
  LITTLE_ENDIAN_MICROSECONDS: 0xa1b2c3d4,
  BIG_ENDIAN_MICROSECONDS: 0xd4c3b2a1,
  LITTLE_ENDIAN_NANOSECONDS: 0xa1b23c4d,
  BIG_ENDIAN_NANOSECONDS: 0x4d3cb2a1,
} as const

/**
 * Ethernet EtherType values
 */
export const EtherType = {
  IPV4: 0x0800,
  IPV6: 0x86dd,
  VLAN: 0x8100, // 802.1Q
  QINQ: 0x88a8, // 802.1ad
} as const

/**
 * IP Protocol numbers
 */
export const IpProtocol = {
  TCP: 6,
  UDP: 17,
} as const

/**
 * Pcap global header (24 bytes)
 */
export interface PcapGlobalHeader {
  magicNumber: number
  versionMajor: number
  versionMinor: number
  snapLen: number
  linkType: number
  isLittleEndian: boolean
  isNanosecond: boolean
}

/**
 * Pcap packet header (16 bytes)
 */
export interface PcapPacketHeader {
  timestampSeconds: number
  timestampMicroseconds: number
  capturedLength: number
  originalLength: number
}

/**
 * TCP flags
 */
export interface TcpFlags {
  fin: boolean
  syn: boolean
  rst: boolean
  psh: boolean
  ack: boolean
  urg: boolean
}

/**
 * Raw packet extracted from pcap (BGP traffic on port 179)
 */
export interface RawPacket {
  frameIndex: number // 1-based index in pcap file
  timestamp: Date
  capturedLength: number
  originalLength: number
  srcIp: string
  dstIp: string
  srcPort: number
  dstPort: number
  tcpPayload: Uint8Array
  tcpFlags: TcpFlags
}

/**
 * Generic packet for non-BGP traffic (L4 level info)
 */
export interface GenericPacket {
  frameIndex: number // 1-based index in pcap file
  timestamp: Date
  capturedLength: number
  originalLength: number
  /**
   * The frame exactly as it was captured, so a filtered set of packets can be
   * written back out as a pcap. This is a view into the source file rather
   * than a copy, so holding it costs nothing beyond the view itself.
   */
  frameBytes: Uint8Array
  srcIp: string
  dstIp: string
  protocol: 'TCP' | 'UDP' | 'ICMP' | 'OTHER'
  protocolNumber: number
  srcPort?: number
  dstPort?: number
  tcpFlags?: TcpFlags
  payloadLength: number
}

/**
 * Parse result from pcap parser
 */
export interface PcapParseResult {
  globalHeader: PcapGlobalHeader
  packets: RawPacket[]
  allPackets: GenericPacket[]
  warnings: string[]
  errors: string[]
}
