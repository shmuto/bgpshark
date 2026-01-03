import { BinaryReader } from '../pcap/reader'
import { getAfiName, getSafiName } from './constants'
import type {
  BgpUpdateMessage,
  BgpPrefix,
  BgpPathAttribute,
  ParsedPathAttribute,
  AsPathSegment,
} from './types'

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

export function parseUpdateMessage(data: Uint8Array, warnings: string[]): BgpUpdateMessage {
  const reader = new BinaryReader(data, false) // BGP uses network byte order (big-endian)

  // Withdrawn Routes Length (2 bytes)
  const withdrawnRoutesLength = reader.readUint16()

  // Parse withdrawn routes
  const withdrawnRoutes = parsePrefixes(reader, withdrawnRoutesLength, warnings)

  // Total Path Attribute Length (2 bytes)
  const totalPathAttrLength = reader.readUint16()

  // Parse path attributes
  const pathAttrEnd = reader.getPosition() + totalPathAttrLength
  const pathAttributes: BgpPathAttribute[] = []

  while (reader.getPosition() < pathAttrEnd) {
    try {
      const attr = parsePathAttribute(reader, warnings)
      pathAttributes.push(attr)
    } catch (e) {
      warnings.push(`Failed to parse path attribute: ${e instanceof Error ? e.message : 'Unknown error'}`)
      break
    }
  }

  // Parse NLRI (remaining bytes)
  const nlriLength = data.length - reader.getPosition()
  const nlri = parsePrefixes(reader, nlriLength, warnings)

  return {
    type: 'UPDATE',
    withdrawnRoutesLength,
    withdrawnRoutes,
    totalPathAttrLength,
    pathAttributes,
    nlri,
  }
}

function parsePrefixes(reader: BinaryReader, length: number, _warnings: string[]): BgpPrefix[] {
  const prefixes: BgpPrefix[] = []
  const endPos = reader.getPosition() + length

  while (reader.getPosition() < endPos) {
    const prefixLength = reader.readUint8()
    const prefixBytes = Math.ceil(prefixLength / 8)

    const octets = reader.readBytes(prefixBytes)
    const prefix = formatIpv4Prefix(octets, prefixLength)

    prefixes.push({ prefix, length: prefixLength })
  }

  return prefixes
}

function formatIpv4Prefix(octets: Uint8Array, _prefixLength: number): string {
  const fullOctets = new Uint8Array(4)
  fullOctets.set(octets)
  return `${fullOctets[0]}.${fullOctets[1]}.${fullOctets[2]}.${fullOctets[3]}`
}

function parsePathAttribute(reader: BinaryReader, warnings: string[]): BgpPathAttribute {
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
    parsed = parsePathAttributeValue(typeCode, rawValue, warnings)
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
  warnings: string[]
): ParsedPathAttribute | undefined {
  const reader = new BinaryReader(data, false) // BGP uses network byte order (big-endian)

  switch (typeCode) {
    case 1: // ORIGIN
      const originValue = reader.readUint8()
      const origins = ['IGP', 'EGP', 'INCOMPLETE'] as const
      return {
        type: 'ORIGIN',
        value: origins[originValue] ?? 'INCOMPLETE',
      }

    case 2: // AS_PATH
    case 17: // AS4_PATH
      return parseAsPath(reader, typeCode === 17)

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
    case 18: // AS4_AGGREGATOR
      const is4byte = typeCode === 18
      return {
        type: 'AGGREGATOR',
        asNumber: is4byte ? reader.readUint32() : reader.readUint16(),
        address: reader.readIpv4Address(),
      }

    case 8: // COMMUNITIES
      return parseCommunities(reader, data.length)

    case 14: // MP_REACH_NLRI
      return parseMpReachNlri(reader, data.length, warnings)

    case 15: // MP_UNREACH_NLRI
      return parseMpUnreachNlri(reader, data.length, warnings)

    case 32: // LARGE_COMMUNITIES
      return parseLargeCommunities(reader, data.length)

    default:
      return { type: 'UNKNOWN' }
  }
}

function parseAsPath(reader: BinaryReader, is4byte: boolean): ParsedPathAttribute {
  const segments: AsPathSegment[] = []

  // Auto-detect AS size if not explicitly 4-byte (AS4_PATH)
  // Look at first segment to determine if 2-byte or 4-byte AS
  if (!is4byte && reader.hasMore()) {
    const savedPos = reader.getPosition()
    const segType = reader.readUint8()
    const segLength = reader.readUint8()

    if (segType >= 1 && segType <= 4 && segLength > 0) {
      const remainingBytes = reader.remaining()
      // Check if data fits 4-byte ASes better than 2-byte ASes
      if (remainingBytes === segLength * 4) {
        is4byte = true
      } else if (remainingBytes === segLength * 2) {
        is4byte = false
      } else if (remainingBytes > segLength * 2) {
        // Multiple segments - try to detect based on total structure
        // Modern BGP typically uses 4-byte AS
        is4byte = remainingBytes % 4 === 0 && remainingBytes >= segLength * 4
      }
    }
    reader.seek(savedPos)
  }

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

function parseMpReachNlri(reader: BinaryReader, _length: number, warnings: string[]): ParsedPathAttribute {
  const afi = reader.readUint16()
  const safi = reader.readUint8()
  const nextHopLength = reader.readUint8()

  // Parse next hop (varies by AFI)
  let nextHop = ''
  if (afi === 1 && nextHopLength === 4) {
    // IPv4
    nextHop = reader.readIpv4Address()
  } else if (afi === 2 && nextHopLength >= 16) {
    // IPv6
    nextHop = reader.readIpv6Address()
    if (nextHopLength === 32) {
      // Link-local address follows
      reader.skip(16)
    }
  } else {
    reader.skip(nextHopLength)
    nextHop = `(${nextHopLength} bytes)`
  }

  // Reserved byte
  reader.readUint8()

  // Parse NLRI
  const nlri: BgpPrefix[] = []
  while (reader.hasMore()) {
    try {
      const prefix = parsePrefix(reader, afi)
      nlri.push(prefix)
    } catch (e) {
      warnings.push(`Failed to parse MP_REACH NLRI: ${e instanceof Error ? e.message : 'Unknown error'}`)
      break
    }
  }

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

function parseMpUnreachNlri(reader: BinaryReader, _length: number, warnings: string[]): ParsedPathAttribute {
  const afi = reader.readUint16()
  const safi = reader.readUint8()

  const withdrawnRoutes: BgpPrefix[] = []
  while (reader.hasMore()) {
    try {
      const prefix = parsePrefix(reader, afi)
      withdrawnRoutes.push(prefix)
    } catch (e) {
      warnings.push(`Failed to parse MP_UNREACH NLRI: ${e instanceof Error ? e.message : 'Unknown error'}`)
      break
    }
  }

  return {
    type: 'MP_UNREACH_NLRI',
    afi,
    afiName: getAfiName(afi),
    safi,
    safiName: getSafiName(safi),
    withdrawnRoutes,
  }
}

function parsePrefix(reader: BinaryReader, afi: number): BgpPrefix {
  const prefixLength = reader.readUint8()

  if (afi === 1) {
    // IPv4
    const prefixBytes = Math.ceil(prefixLength / 8)
    const octets = reader.readBytes(prefixBytes)
    return {
      prefix: formatIpv4Prefix(octets, prefixLength),
      length: prefixLength,
    }
  } else if (afi === 2) {
    // IPv6
    const prefixBytes = Math.ceil(prefixLength / 8)
    const octets = reader.readBytes(prefixBytes)
    return {
      prefix: formatIpv6Prefix(octets, prefixLength),
      length: prefixLength,
    }
  } else {
    const prefixBytes = Math.ceil(prefixLength / 8)
    reader.skip(prefixBytes)
    return { prefix: `(AFI ${afi})`, length: prefixLength }
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
