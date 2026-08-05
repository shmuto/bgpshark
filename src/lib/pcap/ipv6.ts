/**
 * IPv6 network-layer parsing, shared by the pcap and pcapng parsers.
 *
 * BGP over IPv6 is ordinary v6 peering traffic, so the only thing standing
 * between a v6 capture and the rest of the pipeline is the header itself: once
 * the addresses are strings and the upper-layer protocol number is known, a v6
 * packet is indistinguishable from a v4 one downstream.
 */
import type { BinaryReader } from './reader'

/** The part of the header that is always present, before any extension headers. */
const IPV6_HEADER_LENGTH = 40

/**
 * Extension headers we know how to step over. Anything else ends the walk and
 * is reported as the packet's protocol, so ESP or ICMPv6 traffic still shows up
 * in the packet list instead of disappearing.
 */
const HOP_BY_HOP = 0
const ROUTING = 43
const FRAGMENT = 44
const DESTINATION_OPTIONS = 60

/** A chain longer than this is malformed or hostile; stop rather than walk it. */
const MAX_EXTENSION_HEADERS = 8

export interface Ipv6Result {
  srcIp: string
  dstIp: string
  /** Upper-layer protocol number, i.e. the next header the walk stopped on. */
  protocol: number
  /** Bytes after the last extension header, comparable to IPv4's total minus header. */
  payloadLength: number
}

/**
 * Canonical text form (RFC 5952): lowercase, leading zeroes dropped, and the
 * longest run of zero hextets replaced by `::`. Addresses reach the UI, the
 * filters and DuckDB as plain strings, so they have to be written the one way a
 * user would type them or the same peer appears under two names.
 */
export function formatIpv6(bytes: Uint8Array): string {
  const hextets: number[] = []
  for (let i = 0; i < 16; i += 2) {
    hextets.push((bytes[i] << 8) | bytes[i + 1])
  }

  // Longest zero run wins, earliest on a tie.
  let bestStart = -1
  let bestLength = 0
  let runStart = -1
  for (let i = 0; i <= hextets.length; i++) {
    if (i < hextets.length && hextets[i] === 0) {
      if (runStart < 0) runStart = i
      continue
    }
    if (runStart >= 0) {
      if (i - runStart > bestLength) {
        bestStart = runStart
        bestLength = i - runStart
      }
      runStart = -1
    }
  }

  const text = (group: number[]) => group.map((h) => h.toString(16)).join(':')

  // A single zero hextet is written out; `::` may only stand for two or more.
  if (bestLength < 2) return text(hextets)

  return `${text(hextets.slice(0, bestStart))}::${text(hextets.slice(bestStart + bestLength))}`
}

/**
 * Reads the fixed header and walks the extension-header chain until it reaches
 * something that is not an extension header — normally TCP.
 *
 * Returns null when the packet cannot be interpreted, which includes non-first
 * fragments: without reassembly there is no transport header to find in them.
 */
export function parseIpv6Header(
  reader: BinaryReader,
  warnings: string[],
  packetIndex: number
): Ipv6Result | null {
  if (reader.remaining() < IPV6_HEADER_LENGTH) {
    warnings.push(`Packet ${packetIndex}: IPv6 header too short`)
    return null
  }

  reader.setLittleEndian(false)

  const versionClassFlow = reader.readUint32()
  if (versionClassFlow >>> 28 !== 6) {
    return null // EtherType said IPv6 but the header disagrees
  }

  const payloadLength = reader.readUint16()
  let nextHeader = reader.readUint8()
  reader.skip(1) // Hop limit

  const srcIp = formatIpv6(reader.readBytes(16))
  const dstIp = formatIpv6(reader.readBytes(16))

  // Extension headers sit between the fixed header and the transport header and
  // each one announces the next, so the payload length has to shrink by every
  // header consumed for the transport payload size to come out right.
  let remainingPayload = payloadLength

  for (let walked = 0; ; walked++) {
    if (walked >= MAX_EXTENSION_HEADERS) {
      warnings.push(`Packet ${packetIndex}: IPv6 extension header chain too long`)
      return null
    }

    if (nextHeader === FRAGMENT) {
      // Fragment header is a fixed 8 bytes: next header, reserved, offset and
      // flags, identification.
      if (reader.remaining() < 8) {
        warnings.push(`Packet ${packetIndex}: truncated IPv6 fragment header`)
        return null
      }
      const next = reader.readUint8()
      reader.skip(1)
      const offsetAndFlags = reader.readUint16()
      reader.skip(4)
      remainingPayload -= 8

      const fragmentOffset = (offsetAndFlags >> 3) * 8
      if (fragmentOffset !== 0) {
        warnings.push(
          `Packet ${packetIndex}: IPv6 fragment at offset ${fragmentOffset} skipped (reassembly is not supported)`
        )
        return null
      }

      nextHeader = next
      continue
    }

    if (nextHeader === HOP_BY_HOP || nextHeader === ROUTING || nextHeader === DESTINATION_OPTIONS) {
      if (reader.remaining() < 2) {
        warnings.push(`Packet ${packetIndex}: truncated IPv6 extension header`)
        return null
      }
      const next = reader.readUint8()
      // Length counts 8-octet units and excludes the first 8 octets.
      const extensionLength = (reader.readUint8() + 1) * 8
      if (reader.remaining() < extensionLength - 2) {
        warnings.push(`Packet ${packetIndex}: truncated IPv6 extension header`)
        return null
      }
      reader.skip(extensionLength - 2)
      remainingPayload -= extensionLength

      nextHeader = next
      continue
    }

    break
  }

  return {
    srcIp,
    dstIp,
    protocol: nextHeader,
    payloadLength: Math.max(0, remainingPayload),
  }
}
