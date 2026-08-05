import { BinaryReader } from './reader'
import { BgpFlowDetector } from './bgp-detect'
import { parseIpv6Header, type Ipv6Result } from './ipv6'
import type {
  PcapGlobalHeader,
  RawPacket,
  GenericPacket,
  PcapParseResult,
  TcpFlags,
} from './types'
import { LinkLayerType, EtherType, IpProtocol } from './types'

const ICMP_PROTOCOL = 1

interface ParsedPacketResult {
  bgpPacket: RawPacket | null
  genericPacket: GenericPacket | null
}

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
  const allPackets: GenericPacket[] = []
  const interfaces: InterfaceInfo[] = []
  const bgpDetector = new BgpFlowDetector()

  try {
    const reader = new BinaryReader(buffer, true)

    let isLittleEndian = true
    let currentSection = false
    let packetIndex = 0

    while (reader.remaining() >= 8) {
      const blockStart = reader.offset
      const blockType = reader.readUint32()
      const blockTotalLength = reader.readUint32()

      // Block framing is the only thing holding a pcapng together. A length
      // that cannot be true means we no longer know where any later block
      // starts, so this is the one condition that ends the file early.
      if (
        blockTotalLength < 12 ||
        blockTotalLength % 4 !== 0 ||
        blockStart + blockTotalLength > reader.length
      ) {
        warnings.push(
          `Invalid block length ${blockTotalLength} at offset ${blockStart}: ` +
            `parsing stopped at byte ${blockStart} of ${reader.length}, ` +
            `${reader.length - blockStart} remaining bytes skipped`
        )
        break
      }

      const blockEnd = blockStart + blockTotalLength
      const blockDataLength = blockTotalLength - 12 // Subtract type, length, trailing length

      try {
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

            // A packet block that has to be dropped still spends its frame
            // number, so the frames that survive keep the numbering the capture
            // had and a warning can name the frame that went missing.
            packetIndex++

            if (interfaceId >= interfaces.length) {
              warnings.push(`Unknown interface ID ${interfaceId} at offset ${blockStart}; block skipped`)
              break
            }

            const iface = interfaces[interfaceId]

            // The block states its own total length, so the packet data is bounded
            // by the block rather than by the file. A captured length that does not
            // fit is corruption confined to this block: drop it and carry on at the
            // next block boundary instead of abandoning everything after it.
            const availableLength = blockDataLength - 20
            if (capturedLength > availableLength) {
              warnings.push(
                `Packet ${packetIndex}: captured length ${capturedLength} exceeds the ` +
                  `${availableLength} bytes its block holds at offset ${blockStart}; block skipped`
              )
              break
            }

            const packetData = reader.readBytes(capturedLength)

            // Calculate timestamp
            const timestamp = calculateTimestamp(timestampHigh, timestampLow, iface.tsResol)

            // Parse packet
            const result = parsePacketData(
              packetData,
              iface.linkType,
              timestamp,
              capturedLength,
              originalLength,
              packetIndex,
              warnings,
              bgpDetector
            )

            if (result.bgpPacket) {
              packets.push(result.bgpPacket)
            }
            if (result.genericPacket) {
              allPackets.push(result.genericPacket)
            }
            break
          }

          case BLOCK_TYPE.SIMPLE_PACKET: {
            // Simple Packet Block (no timestamp, uses interface 0)
            const originalLength = reader.readUint32()
            const iface = interfaces[0]
            if (!iface) {
              warnings.push(`Simple Packet Block without interface at offset ${blockStart}; block skipped`)
              break
            }

            // A Simple Packet Block has no captured length of its own; what was
            // stored is whatever fits in the block.
            const packetLength = Math.min(originalLength, blockDataLength - 4)
            const packetData = reader.readBytes(packetLength)

            packetIndex++

            const result = parsePacketData(
              packetData,
              iface.linkType,
              new Date(0), // No timestamp in Simple Packet Block
              packetLength,
              originalLength,
              packetIndex,
              warnings,
              bgpDetector
            )

            if (result.bgpPacket) {
              packets.push(result.bgpPacket)
            }
            if (result.genericPacket) {
              allPackets.push(result.genericPacket)
            }
            break
          }

          default:
            break // Unknown block types are simply stepped over
        }
      } catch (e) {
        warnings.push(
          `Block at offset ${blockStart}: ${e instanceof Error ? e.message : String(e)}; block skipped`
        )
      }

      // Every handler reads inside the block it was given, so resynchronising is
      // just jumping to where the block said it ends. A block that was skipped or
      // threw costs its own contents and nothing beyond them.
      reader.seek(blockEnd)
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

    return { globalHeader, packets, allPackets, warnings, errors }
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
    allPackets: [],
    warnings,
    errors,
  }
}

function getProtocolName(protocol: number): GenericPacket['protocol'] {
  switch (protocol) {
    case IpProtocol.TCP:
      return 'TCP'
    case IpProtocol.UDP:
      return 'UDP'
    case ICMP_PROTOCOL:
      return 'ICMP'
    default:
      return 'OTHER'
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

/** Same fields as {@link parseIpv6Header}, so callers need not know the family. */
function parseIpv4Header(reader: BinaryReader): Ipv6Result | null {
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

  return { srcIp, dstIp, protocol, payloadLength: totalLength - ihl }
}

function parsePacketData(
  data: Uint8Array,
  linkType: number,
  timestamp: Date,
  capturedLength: number,
  originalLength: number,
  frameIndex: number,
  warnings: string[],
  bgpDetector: BgpFlowDetector
): ParsedPacketResult {
  const result: ParsedPacketResult = { bgpPacket: null, genericPacket: null }
  const reader = new BinaryReader(data, false)

  // Parse link layer
  let etherType: number

  if (linkType === LinkLayerType.ETHERNET) {
    if (reader.remaining() < 14) return result
    reader.skip(12) // MACs
    reader.setLittleEndian(false)
    etherType = reader.readUint16()

    // Handle VLAN
    while (etherType === EtherType.VLAN || etherType === EtherType.QINQ) {
      if (reader.remaining() < 4) return result
      reader.skip(2)
      etherType = reader.readUint16()
    }
  } else if (linkType === LinkLayerType.SLL) {
    if (reader.remaining() < 16) return result
    reader.skip(14)
    reader.setLittleEndian(false)
    etherType = reader.readUint16()
  } else {
    return result
  }

  if (etherType !== EtherType.IPV4 && etherType !== EtherType.IPV6) return result

  // Both families yield the same fields, so everything below is family-agnostic.
  const ip =
    etherType === EtherType.IPV6
      ? parseIpv6Header(reader, warnings, frameIndex)
      : parseIpv4Header(reader)
  if (!ip) return result

  const { srcIp, dstIp, protocol, payloadLength: ipPayloadLength } = ip

  if (protocol === IpProtocol.TCP) {
    // Parse TCP
    if (reader.remaining() < 20) return result

    const srcPort = reader.readUint16()
    const dstPort = reader.readUint16()

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

    const payloadLength = ipPayloadLength - dataOffset
    const actualPayload = Math.max(0, Math.min(payloadLength, reader.remaining()))

    // Add to generic packets
    result.genericPacket = {
      frameIndex,
      timestamp,
      capturedLength,
      originalLength,
      srcIp,
      dstIp,
      frameBytes: data,
      protocol: 'TCP',
      protocolNumber: IpProtocol.TCP,
      srcPort,
      dstPort,
      tcpFlags: flags,
      payloadLength: actualPayload,
    }

    // BGP on port 179, or a flow the detector recognized by its message
    // marker (non-standard ports; see bgp-detect.ts).
    if (actualPayload > 0) {
      const tcpPayload = reader.readBytes(actualPayload)
      if (bgpDetector.isBgp(srcIp, srcPort, dstIp, dstPort, tcpPayload, warnings)) {
        result.bgpPacket = {
          frameIndex,
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
    }
  } else if (protocol === IpProtocol.UDP) {
    // Parse UDP
    if (reader.remaining() < 8) return result

    const srcPort = reader.readUint16()
    const dstPort = reader.readUint16()
    const udpLength = reader.readUint16()
    reader.skip(2) // Checksum

    result.genericPacket = {
      frameIndex,
      timestamp,
      capturedLength,
      originalLength,
      srcIp,
      dstIp,
      frameBytes: data,
      protocol: 'UDP',
      protocolNumber: IpProtocol.UDP,
      srcPort,
      dstPort,
      payloadLength: udpLength - 8,
    }
  } else {
    // Other protocols (ICMP, etc.)
    result.genericPacket = {
      frameIndex,
      timestamp,
      capturedLength,
      originalLength,
      srcIp,
      dstIp,
      frameBytes: data,
      protocol: getProtocolName(protocol),
      protocolNumber: protocol,
      payloadLength: ipPayloadLength,
    }
  }

  return result
}
