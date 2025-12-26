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
 * Raw packet extracted from pcap
 */
export interface RawPacket {
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
 * Parse result from pcap parser
 */
export interface PcapParseResult {
  globalHeader: PcapGlobalHeader
  packets: RawPacket[]
  warnings: string[]
  errors: string[]
}
