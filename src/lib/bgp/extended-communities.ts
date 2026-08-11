/**
 * Extended communities (RFC 4360), and the EVPN ones that ride in them.
 *
 * These are eight opaque bytes until you know the type, and what they say is
 * often the answer to the question being asked. A Route Target decides which
 * VRF a route lands in — "the MAC is advertised but not learned" is usually a
 * Route Target that does not match. MAC Mobility carries the sequence number
 * that settles which of two advertisements of the same MAC wins.
 *
 * Anything unrecognised keeps its type, subtype and bytes rather than being
 * dropped: a community this parser does not know is still evidence.
 */
import { BinaryReader } from '../pcap/reader'

/** High-order octet: who the value belongs to and whether it crosses an AS. */
const ExtCommType = {
  TWO_OCTET_AS: 0x00,
  IPV4_ADDRESS: 0x01,
  FOUR_OCTET_AS: 0x02,
  OPAQUE: 0x03,
  EVPN: 0x06,
} as const

/** Sub-type, within the types that carry an administrator and a number. */
const ExtCommSubtype = {
  ROUTE_TARGET: 0x02,
  ROUTE_ORIGIN: 0x03,
} as const

const EvpnSubtype = {
  MAC_MOBILITY: 0x00,
  ESI_LABEL: 0x01,
  ES_IMPORT_ROUTE_TARGET: 0x02,
  ROUTER_MAC: 0x03,
} as const

/** RFC 9012 §4.1; 8 is the one a VXLAN fabric uses. */
const TUNNEL_TYPE_NAMES: Record<number, string> = {
  1: 'L2TPv3',
  2: 'GRE',
  7: 'IP-in-IP',
  8: 'VXLAN',
  9: 'NVGRE',
  10: 'MPLS',
  11: 'MPLS-in-GRE',
  12: 'VXLAN-GPE',
  13: 'MPLS-in-UDP',
  15: 'Geneve',
}

export interface ExtendedCommunity {
  /** What the community is, for reading: `Route Target`, `MAC Mobility`, … */
  kind: string
  /** The value as an operator writes it: `65001:100`, `seq 3`, a MAC, … */
  value: string
  /** True when this parser did not recognise the type; `value` is then hex. */
  unknown?: boolean
  /** Non-transitive communities do not leave the AS, which is worth seeing. */
  transitive: boolean
  typeCode: number
  subtype: number
}

function toHex(bytes: Uint8Array, separator = ''): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(separator)
}

/**
 * The administrator:number form shared by Route Targets and Route Origins.
 * Which half is which depends on the type octet, not on the subtype.
 */
function formatAdministratorValue(typeCode: number, value: Uint8Array): string {
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
  switch (typeCode & 0x3f) {
    case ExtCommType.TWO_OCTET_AS:
      return `${view.getUint16(0)}:${view.getUint32(2)}`
    case ExtCommType.IPV4_ADDRESS:
      return `${value[0]}.${value[1]}.${value[2]}.${value[3]}:${view.getUint16(4)}`
    case ExtCommType.FOUR_OCTET_AS:
      return `${view.getUint32(0)}:${view.getUint16(4)}`
    default:
      return toHex(value, ':')
  }
}

function parseOne(typeCode: number, subtype: number, value: Uint8Array): ExtendedCommunity {
  // Bit 0x40 marks a community that must not leave the AS.
  const transitive = (typeCode & 0x40) === 0
  const base: Pick<ExtendedCommunity, 'transitive' | 'typeCode' | 'subtype'> = {
    transitive,
    typeCode,
    subtype,
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)

  if ((typeCode & 0x3f) === ExtCommType.EVPN) {
    switch (subtype) {
      case EvpnSubtype.MAC_MOBILITY: {
        // Flags(1) reserved(1) sequence(4). The flag says the MAC is static,
        // which is what makes a move a conflict rather than a move.
        const sticky = (value[0] & 0x01) !== 0
        const sequence = view.getUint32(2)
        return { ...base, kind: 'MAC Mobility', value: `seq ${sequence}${sticky ? ' (sticky)' : ''}` }
      }
      case EvpnSubtype.ESI_LABEL: {
        const singleActive = (value[0] & 0x01) !== 0
        const label = ((value[3] << 16) | (value[4] << 8) | value[5]) >> 4
        return {
          ...base,
          kind: 'ESI Label',
          value: `${label}${singleActive ? ' (single-active)' : ' (all-active)'}`,
        }
      }
      case EvpnSubtype.ES_IMPORT_ROUTE_TARGET:
        return { ...base, kind: 'ES-Import Route Target', value: toHex(value, ':') }
      case EvpnSubtype.ROUTER_MAC:
        return { ...base, kind: "Router's MAC", value: toHex(value, ':') }
    }
  }

  if ((typeCode & 0x3f) === ExtCommType.OPAQUE && subtype === 0x0c) {
    const tunnelType = view.getUint16(4)
    return {
      ...base,
      kind: 'Encapsulation',
      value: TUNNEL_TYPE_NAMES[tunnelType] ?? `tunnel type ${tunnelType}`,
    }
  }

  if (subtype === ExtCommSubtype.ROUTE_TARGET) {
    return { ...base, kind: 'Route Target', value: formatAdministratorValue(typeCode, value) }
  }
  if (subtype === ExtCommSubtype.ROUTE_ORIGIN) {
    return { ...base, kind: 'Route Origin', value: formatAdministratorValue(typeCode, value) }
  }

  return {
    ...base,
    kind: `Type 0x${typeCode.toString(16).padStart(2, '0')}/0x${subtype.toString(16).padStart(2, '0')}`,
    value: toHex(value, ':'),
    unknown: true,
  }
}

/** Read every extended community in an attribute; each one is eight bytes. */
export function parseExtendedCommunities(reader: BinaryReader, length: number): ExtendedCommunity[] {
  const communities: ExtendedCommunity[] = []
  const endPos = reader.getPosition() + length

  while (reader.getPosition() + 8 <= endPos) {
    const typeCode = reader.readUint8()
    const subtype = reader.readUint8()
    communities.push(parseOne(typeCode, subtype, reader.readBytes(6)))
  }

  if (reader.getPosition() < endPos) reader.seek(endPos)

  return communities
}

/** `Route Target 65001:100`, for one-line contexts. */
export function formatExtendedCommunity(community: ExtendedCommunity): string {
  return `${community.kind} ${community.value}`
}
