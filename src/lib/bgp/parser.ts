import { BinaryReader } from '../pcap/reader'
import type { RawPacket } from '../pcap/types'
import {
  type BgpPacket,
  type BgpMessage,
  type BgpMessageHeader,
  type BgpParseResult,
  BgpMessageType,
} from './types'
import { parseOpenMessage } from './open'
import { parseNotificationMessage } from './notification'
import { parseUpdateMessage } from './update'
import { getAfiName, getSafiName } from './constants'
const updateParseWarnings: string[] = []

const BGP_HEADER_LENGTH = 19
const BGP_MIN_MESSAGE_LENGTH = 19
const BGP_MAX_MESSAGE_LENGTH = 4096

/**
 * Parse BGP messages from raw TCP packets
 */
export function parseBgpFromPackets(rawPackets: RawPacket[]): BgpParseResult {
  const packets: BgpPacket[] = []
  const warnings: string[] = []

  for (let i = 0; i < rawPackets.length; i++) {
    const raw = rawPackets[i]
    const packetWarnings: string[] = []

    try {
      const messages = parseBgpMessages(raw.tcpPayload, packetWarnings, i + 1)

      for (const message of messages) {
        packets.push({
          frameIndex: raw.frameIndex,
          timestamp: raw.timestamp,
          srcIp: raw.srcIp,
          dstIp: raw.dstIp,
          srcPort: raw.srcPort,
          dstPort: raw.dstPort,
          message,
          rawData: raw.tcpPayload,
          parseWarnings: [...packetWarnings],
        })
      }

      warnings.push(...packetWarnings)
    } catch (e) {
      warnings.push(
        `Packet ${i + 1}: BGP parse error - ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  return { packets, warnings }
}

/**
 * Parse multiple BGP messages from a TCP payload
 */
function parseBgpMessages(
  payload: Uint8Array,
  warnings: string[],
  packetIndex: number
): BgpMessage[] {
  const messages: BgpMessage[] = []
  const reader = new BinaryReader(payload, false) // BGP uses network byte order (big-endian)

  while (reader.remaining() >= BGP_HEADER_LENGTH) {
    const startOffset = reader.offset

    // Validate marker
    const marker = reader.peek(16)
    if (!validateMarker(marker)) {
      // Could be a fragmented message or corrupt data
      warnings.push(
        `Packet ${packetIndex}: Invalid BGP marker at offset ${startOffset}. ` +
          `Possible TCP segment fragmentation or corrupt data.`
      )
      break
    }

    // Peek at length to check if we have complete message
    const length = reader.peekUint16At(16)

    if (length < BGP_MIN_MESSAGE_LENGTH || length > BGP_MAX_MESSAGE_LENGTH) {
      warnings.push(
        `Packet ${packetIndex}: Invalid BGP message length ${length} at offset ${startOffset}`
      )
      break
    }

    if (reader.remaining() < length) {
      // Message spans multiple TCP segments
      warnings.push(
        `Packet ${packetIndex}: BGP message spans multiple TCP segments ` +
          `(need ${length} bytes, have ${reader.remaining()}). Partial message skipped.`
      )
      break
    }

    // Read the complete message
    const header = parseBgpHeader(reader)
    const messageBodyLength = header.length - BGP_HEADER_LENGTH
    const messageReader = reader.subReader(messageBodyLength)

    try {
      const message = parseBgpMessageBody(header.type, messageReader)
      if (message) {
        messages.push(message)
      }
    } catch (e) {
      warnings.push(
        `Packet ${packetIndex}: Error parsing BGP message type ${header.type}: ` +
          `${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  return messages
}

/**
 * Validate BGP marker (16 bytes of 0xFF)
 */
function validateMarker(marker: Uint8Array): boolean {
  if (marker.length < 16) {
    return false
  }
  for (let i = 0; i < 16; i++) {
    if (marker[i] !== 0xff) {
      return false
    }
  }
  return true
}

/**
 * Parse BGP message header
 */
function parseBgpHeader(reader: BinaryReader): BgpMessageHeader {
  const marker = reader.readBytes(16)
  const length = reader.readUint16()
  const type = reader.readUint8()

  return { marker, length, type }
}

/**
 * Parse BGP message body based on type
 */
function parseBgpMessageBody(type: number, reader: BinaryReader): BgpMessage | null {
  switch (type) {
    case BgpMessageType.OPEN:
      return parseOpenMessage(reader)

    case BgpMessageType.UPDATE: {
      // parseUpdateMessage expects raw bytes, not a BinaryReader
      const updateData = reader.readBytes(reader.remaining())
      updateParseWarnings.length = 0 // Clear previous warnings
      return parseUpdateMessage(updateData, updateParseWarnings)
    }

    case BgpMessageType.NOTIFICATION:
      return parseNotificationMessage(reader)

    case BgpMessageType.KEEPALIVE:
      return { type: 'KEEPALIVE' }

    case BgpMessageType.ROUTE_REFRESH:
      return parseRouteRefreshMessage(reader)

    default:
      return null
  }
}

/**
 * Parse ROUTE-REFRESH message
 */
function parseRouteRefreshMessage(reader: BinaryReader): BgpMessage {
  const afi = reader.readUint16()
  reader.skip(1) // Reserved
  const safi = reader.readUint8()

  return {
    type: 'ROUTE_REFRESH',
    afi,
    safi,
    afiName: getAfiName(afi),
    safiName: getSafiName(safi),
  }
}
