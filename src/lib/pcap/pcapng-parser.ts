import { BinaryReader } from './reader'
import type {
  PcapGlobalHeader,
  RawPacket,
  PcapParseResult,
  TcpFlags,
} from './types'
import { LinkLayerType, EtherType, IpProtocol } from './types'

const BGP_PORT = 179

// pcapng block types
const BLOCK_TYPE = {
  SECTION_HEADER: 0x0a0d0d0a,
  INTERFACE_DESCRIPTION: 0x00000001,
  ENHANCED_PACKET: 0x00000006,
  SIMPLE_PACKET: 0x00000003,
} as const

// pcapng magic (Section Header Block)
const PCAPNG_MAGIC = 0x1a2b3c4d

interface InterfaceInfo {
  linkType: number
  snapLen: number
  tsResol: number // timestamp resolution
}

/**
 * Check if buffer is pcapng format
 */
export function isPcapng(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false
  const view = new DataView(buffer)
  // Check for Section Header Block type
  const blockType = view.getUint32(0, true)
  if (blockType !== BLOCK_TYPE.SECTION_HEADER) return false
  // Check byte order magic at offset 8
  const magic = view.getUint32(8, true)
  return magic === PCAPNG_MAGIC || magic === 0x4d3c2b1a
}

/**
 * Parse pcapng file buffer
 */
export function parsePcapng(buffer: ArrayBuffer): PcapParseResult {
  const warnings: string[] = []
  const errors: string[] = []
  const packets: RawPacket[] = []
  const interfaces: InterfaceInfo[] = []

  try {
    const reader = new BinaryReader(buffer, true)

    let isLittleEndian = true
    let currentSection = false

    while (reader.remaining() >= 8) {
      const blockType = reader.readUint32()
      const blockTotalLength = reader.readUint32()

      if (blockTotalLength < 12 || blockTotalLength > reader.remaining() + 8) {
        warnings.push(`Invalid block length ${blockTotalLength} at offset ${reader.offset - 8}`)
        break
      }

      const blockDataLength = blockTotalLength - 12 // Subtract type, length, trailing length

      switch (blockType) {
        case BLOCK_TYPE.SECTION_HEADER: {
          // Byte Order Magic
          const magic = reader.readUint32()
          if (magic === PCAPNG_MAGIC) {
            isLittleEndian = true
          } else if (magic === 0x4d3c2b1a) {
            isLittleEndian = false
          } else {
            errors.push('Invalid pcapng byte order magic')
            return createEmptyResult(errors, warnings)
          }
          reader.setLittleEndian(isLittleEndian)

          // Skip major/minor version (4 bytes) and section length (8 bytes)
          reader.skip(12)
          // Skip options
          const optionsLength = blockDataLength - 16
          if (optionsLength > 0) {
            reader.skip(optionsLength)
          }

          currentSection = true
          interfaces.length = 0 // Reset interfaces for new section
          break
        }

        case BLOCK_TYPE.INTERFACE_DESCRIPTION: {
          if (!currentSection) {
            warnings.push('Interface Description Block before Section Header')
          }
          const linkType = reader.readUint16()
          reader.skip(2) // Reserved
          const snapLen = reader.readUint32()

          // Parse options for timestamp resolution
          let tsResol = 6 // Default: microseconds (10^-6)
          const optionsLength = blockDataLength - 8
          if (optionsLength > 0) {
            const optionsEnd = reader.offset + optionsLength
            while (reader.offset < optionsEnd && reader.remaining() >= 4) {
              const optCode = reader.readUint16()
              const optLen = reader.readUint16()
              if (optCode === 0) break // end_of_opt
              if (optCode === 9 && optLen >= 1) {
                // if_tsresol
                tsResol = reader.readUint8()
                reader.skip(optLen - 1 + ((4 - (optLen % 4)) % 4))
              } else {
                const padLen = (4 - (optLen % 4)) % 4
                reader.skip(optLen + padLen)
              }
            }
            // Skip any remaining options
            if (reader.offset < optionsEnd) {
              reader.skip(optionsEnd - reader.offset)
            }
          }

          interfaces.push({ linkType, snapLen, tsResol })
          break
        }

        case BLOCK_TYPE.ENHANCED_PACKET: {
          const interfaceId = reader.readUint32()
          const timestampHigh = reader.readUint32()
          const timestampLow = reader.readUint32()
          const capturedLength = reader.readUint32()
          const originalLength = reader.readUint32()

          if (interfaceId >= interfaces.length) {
            warnings.push(`Unknown interface ID ${interfaceId}`)
            reader.skip(blockDataLength - 20)
            break
          }

          const iface = interfaces[interfaceId]
          const actualCapturedLength = Math.min(capturedLength, iface.snapLen)

          if (reader.remaining() < actualCapturedLength) {
            warnings.push('Truncated packet data')
            break
          }

          const packetData = reader.readBytes(actualCapturedLength)

          // Skip padding and options
          const paddedLength = (actualCapturedLength + 3) & ~3
          const skipBytes = paddedLength - actualCapturedLength + (blockDataLength - 20 - paddedLength)
          if (skipBytes > 0) {
            reader.skip(skipBytes)
          }

          // Calculate timestamp
          const timestamp = calculateTimestamp(timestampHigh, timestampLow, iface.tsResol)

          // Parse packet
          const rawPacket = parsePacketData(
            packetData,
            iface.linkType,
            timestamp,
            capturedLength,
            originalLength,
            warnings
          )

          if (rawPacket) {
            packets.push(rawPacket)
          }
          break
        }

        case BLOCK_TYPE.SIMPLE_PACKET: {
          // Simple Packet Block (no timestamp, uses interface 0)
          const originalLength = reader.readUint32()
          const iface = interfaces[0]
          if (!iface) {
            warnings.push('Simple Packet Block without interface')
            reader.skip(blockDataLength - 4)
            break
          }

          const packetLength = Math.min(originalLength, iface.snapLen)
          const packetData = reader.readBytes(packetLength)

          // Skip padding
          const paddedLength = (packetLength + 3) & ~3
          reader.skip(paddedLength - packetLength)

          const rawPacket = parsePacketData(
            packetData,
            iface.linkType,
            new Date(0), // No timestamp in Simple Packet Block
            packetLength,
            originalLength,
            warnings
          )

          if (rawPacket) {
            packets.push(rawPacket)
          }
          break
        }

        default:
          // Skip unknown blocks
          reader.skip(blockDataLength)
          break
      }

      // Skip trailing block length
      reader.skip(4)
    }

    if (interfaces.length === 0) {
      errors.push('No interfaces found in pcapng file')
      return createEmptyResult(errors, warnings)
    }

    // Create a fake global header for compatibility
    const globalHeader: PcapGlobalHeader = {
      magicNumber: PCAPNG_MAGIC,
      versionMajor: 1,
      versionMinor: 0,
      snapLen: interfaces[0].snapLen,
      linkType: interfaces[0].linkType,
      isLittleEndian,
      isNanosecond: false,
    }

    return { globalHeader, packets, warnings, errors }
  } catch (e) {
    errors.push(`Fatal error: ${e instanceof Error ? e.message : String(e)}`)
    return createEmptyResult(errors, warnings)
  }
}

function createEmptyResult(errors: string[], warnings: string[]): PcapParseResult {
  return {
    globalHeader: {
      magicNumber: 0,
      versionMajor: 0,
      versionMinor: 0,
      snapLen: 0,
      linkType: 0,
      isLittleEndian: true,
      isNanosecond: false,
    },
    packets: [],
    warnings,
    errors,
  }
}

function calculateTimestamp(high: number, low: number, tsResol: number): Date {
  // Combine high and low into 64-bit timestamp
  const timestamp = high * 0x100000000 + low

  let milliseconds: number
  if (tsResol & 0x80) {
    // Power of 2
    const power = tsResol & 0x7f
    milliseconds = timestamp / Math.pow(2, power) * 1000
  } else {
    // Power of 10
    const power = tsResol
    milliseconds = timestamp / Math.pow(10, power) * 1000
  }

  return new Date(milliseconds)
}

function parsePacketData(
  data: Uint8Array,
  linkType: number,
  timestamp: Date,
  capturedLength: number,
  originalLength: number,
  _warnings: string[]
): RawPacket | null {
  const reader = new BinaryReader(data, false)

  // Parse link layer
  let etherType: number

  if (linkType === LinkLayerType.ETHERNET) {
    if (reader.remaining() < 14) return null
    reader.skip(12) // MACs
    reader.setLittleEndian(false)
    etherType = reader.readUint16()

    // Handle VLAN
    while (etherType === EtherType.VLAN || etherType === EtherType.QINQ) {
      if (reader.remaining() < 4) return null
      reader.skip(2)
      etherType = reader.readUint16()
    }
  } else if (linkType === LinkLayerType.SLL) {
    if (reader.remaining() < 16) return null
    reader.skip(14)
    reader.setLittleEndian(false)
    etherType = reader.readUint16()
  } else {
    return null
  }

  if (etherType !== EtherType.IPV4) return null

  // Parse IPv4
  if (reader.remaining() < 20) return null
  reader.setLittleEndian(false)

  const versionIhl = reader.readUint8()
  const ihl = (versionIhl & 0x0f) * 4
  if (ihl < 20) return null

  reader.skip(1) // DSCP
  const totalLength = reader.readUint16()
  reader.skip(4) // ID, Flags, Fragment
  reader.skip(1) // TTL
  const protocol = reader.readUint8()
  reader.skip(2) // Checksum
  const srcIp = reader.readIpv4Address()
  const dstIp = reader.readIpv4Address()

  if (ihl > 20) reader.skip(ihl - 20)

  if (protocol !== IpProtocol.TCP) return null

  // Parse TCP
  if (reader.remaining() < 20) return null

  const srcPort = reader.readUint16()
  const dstPort = reader.readUint16()

  if (srcPort !== BGP_PORT && dstPort !== BGP_PORT) return null

  reader.skip(8) // Seq, Ack
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

  reader.skip(6) // Window, Checksum, Urgent

  if (dataOffset > 20) {
    const optLen = dataOffset - 20
    if (reader.remaining() >= optLen) {
      reader.skip(optLen)
    }
  }

  const payloadLength = totalLength - ihl - dataOffset
  if (payloadLength <= 0) return null

  const actualPayload = Math.min(payloadLength, reader.remaining())
  if (actualPayload === 0) return null

  const tcpPayload = reader.readBytes(actualPayload)

  return {
    timestamp,
    capturedLength,
    originalLength,
    srcIp,
    dstIp,
    srcPort,
    dstPort,
    tcpPayload,
    tcpFlags: flags,
  }
}
