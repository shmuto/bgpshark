import { BinaryReader } from '../pcap/reader'
import type {
  BgpOpenMessage,
  BgpCapability,
  ParsedCapability,
  MultiprotocolCapability,
  FourOctetAsCapability,
  GracefulRestartCapability,
  AddPathCapability,
  ExtendedNextHopCapability,
} from './types'
import {
  CapabilityCode,
  getCapabilityName,
  getAfiName,
  getSafiName,
} from './constants'

/**
 * Parse BGP OPEN message
 */
export function parseOpenMessage(reader: BinaryReader): BgpOpenMessage {
  const version = reader.readUint8()
  const myAs = reader.readUint16()
  const holdTime = reader.readUint16()
  const bgpIdentifier = reader.readIpv4Address()
  const optParamLength = reader.readUint8()

  const capabilities: BgpCapability[] = []
  let fourByteAs: number | undefined

  if (optParamLength > 0) {
    const optParamsReader = reader.subReader(optParamLength)
    const parsedCaps = parseOptionalParameters(optParamsReader)
    capabilities.push(...parsedCaps)

    // Extract 4-byte AS if present
    for (const cap of capabilities) {
      if (cap.parsed?.type === 'FOUR_OCTET_AS') {
        fourByteAs = cap.parsed.asNumber
        break
      }
    }
  }

  return {
    type: 'OPEN',
    version,
    myAs,
    holdTime,
    bgpIdentifier,
    optParamLength,
    capabilities,
    fourByteAs,
  }
}

/**
 * Parse optional parameters from OPEN message
 */
function parseOptionalParameters(reader: BinaryReader): BgpCapability[] {
  const capabilities: BgpCapability[] = []

  while (reader.remaining() >= 2) {
    const paramType = reader.readUint8()
    const paramLength = reader.readUint8()

    if (reader.remaining() < paramLength) {
      break
    }

    // Parameter Type 2 = Capabilities
    if (paramType === 2) {
      const capsReader = reader.subReader(paramLength)
      while (capsReader.remaining() >= 2) {
        const cap = parseCapability(capsReader)
        if (cap) {
          capabilities.push(cap)
        }
      }
    } else {
      // Skip unknown parameter types
      reader.skip(paramLength)
    }
  }

  return capabilities
}

/**
 * Parse a single capability
 */
function parseCapability(reader: BinaryReader): BgpCapability | null {
  if (reader.remaining() < 2) {
    return null
  }

  const code = reader.readUint8()
  const length = reader.readUint8()

  if (reader.remaining() < length) {
    return null
  }

  const rawValue = reader.readBytes(length)
  const name = getCapabilityName(code)
  const parsed = parseCapabilityValue(code, rawValue)

  return {
    code,
    name,
    length,
    rawValue,
    parsed,
  }
}

/**
 * Parse capability value based on code
 */
function parseCapabilityValue(code: number, value: Uint8Array): ParsedCapability | undefined {
  const reader = new BinaryReader(value, false)

  switch (code) {
    case CapabilityCode.MULTIPROTOCOL:
      return parseMultiprotocol(reader)

    case CapabilityCode.ROUTE_REFRESH:
      return { type: 'ROUTE_REFRESH' }

    case CapabilityCode.FOUR_OCTET_AS:
      return parseFourOctetAs(reader)

    case CapabilityCode.GRACEFUL_RESTART:
      return parseGracefulRestart(reader)

    case CapabilityCode.ADD_PATH:
      return parseAddPath(reader)

    case CapabilityCode.EXTENDED_NEXT_HOP:
      return parseExtendedNextHop(reader)

    case CapabilityCode.ENHANCED_ROUTE_REFRESH:
      return { type: 'ENHANCED_ROUTE_REFRESH' }

    default:
      return { type: 'UNKNOWN' }
  }
}

/**
 * Parse Multiprotocol Extensions capability
 */
function parseMultiprotocol(reader: BinaryReader): MultiprotocolCapability {
  const afi = reader.readUint16()
  reader.skip(1) // Reserved
  const safi = reader.readUint8()

  return {
    type: 'MULTIPROTOCOL',
    afi,
    afiName: getAfiName(afi),
    safi,
    safiName: getSafiName(safi),
  }
}

/**
 * Parse 4-byte AS Number capability
 */
function parseFourOctetAs(reader: BinaryReader): FourOctetAsCapability {
  const asNumber = reader.readUint32()

  return {
    type: 'FOUR_OCTET_AS',
    asNumber,
  }
}

/**
 * Parse Graceful Restart capability
 */
function parseGracefulRestart(reader: BinaryReader): GracefulRestartCapability {
  const flagsAndTime = reader.readUint16()
  const restartFlags = (flagsAndTime >> 12) & 0x0f
  const restartTime = flagsAndTime & 0x0fff

  const addressFamilies: GracefulRestartCapability['addressFamilies'] = []

  while (reader.remaining() >= 4) {
    const afi = reader.readUint16()
    const safi = reader.readUint8()
    const flags = reader.readUint8()

    addressFamilies.push({
      afi,
      afiName: getAfiName(afi),
      safi,
      safiName: getSafiName(safi),
      flags,
    })
  }

  return {
    type: 'GRACEFUL_RESTART',
    restartFlags,
    restartTime,
    addressFamilies,
  }
}

/**
 * Parse ADD-PATH capability
 */
function parseAddPath(reader: BinaryReader): AddPathCapability {
  const addressFamilies: AddPathCapability['addressFamilies'] = []

  while (reader.remaining() >= 4) {
    const afi = reader.readUint16()
    const safi = reader.readUint8()
    const sendReceiveValue = reader.readUint8()

    let sendReceive: 'receive' | 'send' | 'both'
    switch (sendReceiveValue) {
      case 1:
        sendReceive = 'receive'
        break
      case 2:
        sendReceive = 'send'
        break
      case 3:
        sendReceive = 'both'
        break
      default:
        sendReceive = 'receive'
    }

    addressFamilies.push({
      afi,
      afiName: getAfiName(afi),
      safi,
      safiName: getSafiName(safi),
      sendReceive,
    })
  }

  return {
    type: 'ADD_PATH',
    addressFamilies,
  }
}

/**
 * Parse Extended Next Hop Encoding capability
 */
function parseExtendedNextHop(reader: BinaryReader): ExtendedNextHopCapability {
  const entries: ExtendedNextHopCapability['entries'] = []

  while (reader.remaining() >= 6) {
    const nlriAfi = reader.readUint16()
    const nlriSafi = reader.readUint16()
    const nexthopAfi = reader.readUint16()

    entries.push({
      nlriAfi,
      nlriAfiName: getAfiName(nlriAfi),
      nlriSafi,
      nlriSafiName: getSafiName(nlriSafi),
      nexthopAfi,
      nexthopAfiName: getAfiName(nexthopAfi),
    })
  }

  return {
    type: 'EXTENDED_NEXT_HOP',
    entries,
  }
}
