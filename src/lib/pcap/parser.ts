import { BinaryReader } from './reader'
import {
  type PcapGlobalHeader,
  type PcapPacketHeader,
  type RawPacket,
  type PcapParseResult,
  type TcpFlags,
  PcapMagic,
  LinkLayerType,
  EtherType,
  IpProtocol,
} from './types'

const BGP_PORT = 179

/**
 * Parse pcap file buffer
 */
export function parsePcap(buffer: ArrayBuffer): PcapParseResult {
  const warnings: string[] = []
  const errors: string[] = []
  const packets: RawPacket[] = []

  try {
    const reader = new BinaryReader(buffer, true)

    // Parse global header
    const globalHeader = parseGlobalHeader(reader)
    if (!globalHeader) {
      errors.push('Invalid pcap file: unrecognized magic number')
      return { globalHeader: createEmptyGlobalHeader(), packets, warnings, errors }
    }

    // Set endianness based on magic number
    reader.setLittleEndian(globalHeader.isLittleEndian)

    // Check supported link types
    if (
      globalHeader.linkType !== LinkLayerType.ETHERNET &&
      globalHeader.linkType !== LinkLayerType.SLL
    ) {
      errors.push(
        `Unsupported link layer type: ${globalHeader.linkType}. ` +
          `Only Ethernet (1) and SLL (113) are supported.`
      )
      return { globalHeader, packets, warnings, errors }
    }

    // Parse packets
    let packetIndex = 0
    while (reader.remaining() >= 16) {
      packetIndex++

      try {
        const packetHeader = parsePacketHeader(reader, globalHeader.isNanosecond)

        if (reader.remaining() < packetHeader.capturedLength) {
          warnings.push(`Packet ${packetIndex}: truncated (missing ${packetHeader.capturedLength - reader.remaining()} bytes)`)
          break
        }

        const packetData = reader.readBytes(packetHeader.capturedLength)
        const packetReader = new BinaryReader(packetData, globalHeader.isLittleEndian)

        // Parse link layer and extract IP payload
        const linkResult =
          globalHeader.linkType === LinkLayerType.SLL
            ? parseSllFrame(packetReader, warnings, packetIndex)
            : parseEthernetFrame(packetReader, warnings, packetIndex)

        if (!linkResult) {
          continue // Skip non-IP packets
        }

        // Parse IP header
        const ipResult = parseIpv4Header(packetReader, warnings, packetIndex)
        if (!ipResult) {
          continue // Skip non-IPv4 or malformed
        }

        // Only process TCP
        if (ipResult.protocol !== IpProtocol.TCP) {
          continue
        }

        // Parse TCP header
        const tcpResult = parseTcpHeader(packetReader, ipResult.payloadLength, warnings, packetIndex)
        if (!tcpResult) {
          continue
        }

        // Filter for BGP port 179
        if (tcpResult.srcPort !== BGP_PORT && tcpResult.dstPort !== BGP_PORT) {
          continue
        }

        // Skip packets with no payload (SYN, ACK only, etc.)
        if (tcpResult.payload.length === 0) {
          continue
        }

        packets.push({
          timestamp: new Date(
            packetHeader.timestampSeconds * 1000 +
              Math.floor(packetHeader.timestampMicroseconds / 1000)
          ),
          capturedLength: packetHeader.capturedLength,
          originalLength: packetHeader.originalLength,
          srcIp: ipResult.srcIp,
          dstIp: ipResult.dstIp,
          srcPort: tcpResult.srcPort,
          dstPort: tcpResult.dstPort,
          tcpPayload: tcpResult.payload,
          tcpFlags: tcpResult.flags,
        })
      } catch (e) {
        warnings.push(`Packet ${packetIndex}: parse error - ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return { globalHeader, packets, warnings, errors }
  } catch (e) {
    errors.push(`Fatal error: ${e instanceof Error ? e.message : String(e)}`)
    return { globalHeader: createEmptyGlobalHeader(), packets, warnings, errors }
  }
}

function createEmptyGlobalHeader(): PcapGlobalHeader {
  return {
    magicNumber: 0,
    versionMajor: 0,
    versionMinor: 0,
    snapLen: 0,
    linkType: 0,
    isLittleEndian: true,
    isNanosecond: false,
  }
}

function parseGlobalHeader(reader: BinaryReader): PcapGlobalHeader | null {
  if (reader.remaining() < 24) {
    return null
  }

  // Read magic number as big-endian first to detect byte order
  reader.setLittleEndian(false)
  const magicBE = reader.readUint32()
  reader.seek(0)

  let isLittleEndian: boolean
  let isNanosecond: boolean

  // When we read as big-endian and get BIG_ENDIAN value, the file is little-endian
  // (because the bytes are stored in little-endian order)
  switch (magicBE) {
    case PcapMagic.BIG_ENDIAN_MICROSECONDS:
      // File bytes: d4 c3 b2 a1 -> read as BE gives 0xd4c3b2a1 -> file is LE
      isLittleEndian = true
      isNanosecond = false
      break
    case PcapMagic.LITTLE_ENDIAN_MICROSECONDS:
      // File bytes: a1 b2 c3 d4 -> read as BE gives 0xa1b2c3d4 -> file is BE
      isLittleEndian = false
      isNanosecond = false
      break
    case PcapMagic.BIG_ENDIAN_NANOSECONDS:
      isLittleEndian = true
      isNanosecond = true
      break
    case PcapMagic.LITTLE_ENDIAN_NANOSECONDS:
      isLittleEndian = false
      isNanosecond = true
      break
    default:
      return null
  }

  reader.setLittleEndian(isLittleEndian)
  const magicNumber = reader.readUint32()
  const versionMajor = reader.readUint16()
  const versionMinor = reader.readUint16()
  reader.skip(8) // Reserved (thiszone, sigfigs)
  const snapLen = reader.readUint32()
  const linkType = reader.readUint32()

  return {
    magicNumber,
    versionMajor,
    versionMinor,
    snapLen,
    linkType,
    isLittleEndian,
    isNanosecond,
  }
}

function parsePacketHeader(reader: BinaryReader, isNanosecond: boolean): PcapPacketHeader {
  const timestampSeconds = reader.readUint32()
  let timestampMicroseconds = reader.readUint32()

  // Convert nanoseconds to microseconds if needed
  if (isNanosecond) {
    timestampMicroseconds = Math.floor(timestampMicroseconds / 1000)
  }

  const capturedLength = reader.readUint32()
  const originalLength = reader.readUint32()

  return {
    timestampSeconds,
    timestampMicroseconds,
    capturedLength,
    originalLength,
  }
}

interface LinkLayerResult {
  etherType: number
}

function parseEthernetFrame(
  reader: BinaryReader,
  warnings: string[],
  packetIndex: number
): LinkLayerResult | null {
  if (reader.remaining() < 14) {
    warnings.push(`Packet ${packetIndex}: Ethernet frame too short`)
    return null
  }

  // Skip destination and source MAC addresses (12 bytes)
  reader.skip(12)

  // Read EtherType (big-endian)
  reader.setLittleEndian(false)
  let etherType = reader.readUint16()

  // Handle VLAN tags (802.1Q)
  while (etherType === EtherType.VLAN || etherType === EtherType.QINQ) {
    if (reader.remaining() < 4) {
      warnings.push(`Packet ${packetIndex}: truncated VLAN tag`)
      return null
    }
    reader.skip(2) // Skip TCI (VLAN ID + Priority)
    etherType = reader.readUint16()
  }

  // Only handle IPv4
  if (etherType !== EtherType.IPV4) {
    return null
  }

  return { etherType }
}

function parseSllFrame(
  reader: BinaryReader,
  warnings: string[],
  packetIndex: number
): LinkLayerResult | null {
  // Linux cooked capture header is 16 bytes
  if (reader.remaining() < 16) {
    warnings.push(`Packet ${packetIndex}: SLL frame too short`)
    return null
  }

  // SLL header format:
  // 2 bytes: packet type
  // 2 bytes: ARPHRD type
  // 2 bytes: link-layer address length
  // 8 bytes: link-layer address
  // 2 bytes: protocol type (EtherType)
  reader.skip(14)

  reader.setLittleEndian(false)
  const etherType = reader.readUint16()

  // Only handle IPv4
  if (etherType !== EtherType.IPV4) {
    return null
  }

  return { etherType }
}

interface Ipv4Result {
  srcIp: string
  dstIp: string
  protocol: number
  payloadLength: number
}

function parseIpv4Header(
  reader: BinaryReader,
  warnings: string[],
  packetIndex: number
): Ipv4Result | null {
  if (reader.remaining() < 20) {
    warnings.push(`Packet ${packetIndex}: IPv4 header too short`)
    return null
  }

  reader.setLittleEndian(false)

  const versionIhl = reader.readUint8()
  const version = (versionIhl >> 4) & 0x0f
  const ihl = versionIhl & 0x0f

  if (version !== 4) {
    return null // Not IPv4
  }

  const headerLength = ihl * 4
  if (headerLength < 20 || reader.remaining() < headerLength - 1) {
    warnings.push(`Packet ${packetIndex}: invalid IPv4 header length`)
    return null
  }

  reader.skip(1) // DSCP/ECN
  const totalLength = reader.readUint16()
  reader.skip(4) // ID, Flags, Fragment Offset
  reader.skip(1) // TTL
  const protocol = reader.readUint8()
  reader.skip(2) // Header Checksum

  const srcIp = reader.readIpv4Address()
  const dstIp = reader.readIpv4Address()

  // Skip IP options if present
  const optionsLength = headerLength - 20
  if (optionsLength > 0) {
    reader.skip(optionsLength)
  }

  const payloadLength = totalLength - headerLength

  return { srcIp, dstIp, protocol, payloadLength }
}

interface TcpResult {
  srcPort: number
  dstPort: number
  flags: TcpFlags
  payload: Uint8Array
}

function parseTcpHeader(
  reader: BinaryReader,
  ipPayloadLength: number,
  warnings: string[],
  packetIndex: number
): TcpResult | null {
  if (reader.remaining() < 20) {
    warnings.push(`Packet ${packetIndex}: TCP header too short`)
    return null
  }

  reader.setLittleEndian(false)

  const srcPort = reader.readUint16()
  const dstPort = reader.readUint16()
  reader.skip(4) // Sequence Number
  reader.skip(4) // Acknowledgment Number

  const dataOffsetFlags = reader.readUint16()
  const dataOffset = ((dataOffsetFlags >> 12) & 0x0f) * 4
  const flagsByte = dataOffsetFlags & 0x3f

  const flags: TcpFlags = {
    fin: (flagsByte & 0x01) !== 0,
    syn: (flagsByte & 0x02) !== 0,
    rst: (flagsByte & 0x04) !== 0,
    psh: (flagsByte & 0x08) !== 0,
    ack: (flagsByte & 0x10) !== 0,
    urg: (flagsByte & 0x20) !== 0,
  }

  reader.skip(2) // Window Size
  reader.skip(2) // Checksum
  reader.skip(2) // Urgent Pointer

  // Skip TCP options if present
  const optionsLength = dataOffset - 20
  if (optionsLength > 0) {
    if (reader.remaining() < optionsLength) {
      warnings.push(`Packet ${packetIndex}: truncated TCP options`)
      return null
    }
    reader.skip(optionsLength)
  }

  // Calculate payload length
  const payloadLength = ipPayloadLength - dataOffset
  if (payloadLength < 0) {
    warnings.push(`Packet ${packetIndex}: invalid TCP payload length`)
    return null
  }

  const actualPayloadLength = Math.min(payloadLength, reader.remaining())
  const payload = actualPayloadLength > 0 ? reader.readBytes(actualPayloadLength) : new Uint8Array(0)

  return { srcPort, dstPort, flags, payload }
}
