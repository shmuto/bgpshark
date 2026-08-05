/**
 * EVPN NLRI (RFC 7432), the address family behind every VXLAN fabric.
 *
 * EVPN does not carry prefixes. Its NLRI is a tagged union — a route type, a
 * length, and a body whose shape depends on the type — so the length-prefixed
 * prefix reader every other family uses cannot read it at all. Fed EVPN, that
 * reader takes the route type for a prefix length and walks off into the body.
 *
 * Types 2 (MAC/IP Advertisement) and 3 (Inclusive Multicast Ethernet Tag) are
 * decoded in full: between them they answer the two questions a fabric raises
 * most often — where a MAC was learned, and which VTEPs are in a VNI. The
 * other types are recognised and their Route Distinguisher read, so a capture
 * containing them still shows what kind of routes are moving rather than
 * failing to parse.
 */
import { BinaryReader } from '../pcap/reader'
import { formatIpv6 } from '../pcap/ipv6'

export const EvpnRouteType = {
  ETHERNET_AUTO_DISCOVERY: 1,
  MAC_IP_ADVERTISEMENT: 2,
  INCLUSIVE_MULTICAST: 3,
  ETHERNET_SEGMENT: 4,
  IP_PREFIX: 5,
} as const

export const EVPN_ROUTE_TYPE_NAMES: Record<number, string> = {
  1: 'Ethernet Auto-Discovery',
  2: 'MAC/IP Advertisement',
  3: 'Inclusive Multicast Ethernet Tag',
  4: 'Ethernet Segment',
  5: 'IP Prefix',
}

export interface EvpnRoute {
  routeType: number
  routeTypeName: string
  /** Route Distinguisher, formatted the way an operator writes it. */
  rd: string
  /** Ethernet Segment Identifier; absent on the types that carry none. */
  esi?: string
  ethernetTag?: number
  macAddress?: string
  ipAddress?: string
  /**
   * The MPLS Label field read as a 20-bit label. Under VXLAN (RFC 8365) that
   * is where the VNI lands, which is what the fabric is actually keyed on.
   */
  label?: number
  /** Second label of a MAC/IP route, present when it carries an L3 VNI. */
  label2?: number
  /** Type 3 and 4 name the router originating the route. */
  originatingRouterIp?: string
  /** Type 5 carries a real prefix, plus a gateway address. */
  ipPrefixLength?: number
  gatewayIp?: string
  /** Set when the body could not be read; the route type and RD still stand. */
  truncated?: boolean
}

/** A Route Distinguisher as operators write it (RFC 4364 §4.2). */
function readRouteDistinguisher(reader: BinaryReader): string {
  const type = reader.readUint16()
  switch (type) {
    case 0: {
      const administrator = reader.readUint16()
      const assigned = reader.readUint32()
      return `${administrator}:${assigned}`
    }
    case 1: {
      const administrator = reader.readIpv4Address()
      const assigned = reader.readUint16()
      return `${administrator}:${assigned}`
    }
    case 2: {
      const administrator = reader.readUint32()
      const assigned = reader.readUint16()
      return `${administrator}:${assigned}`
    }
    default: {
      const bytes = reader.readBytes(6)
      return `(type ${type}) ${toHex(bytes, ':')}`
    }
  }
}

function toHex(bytes: Uint8Array, separator = ''): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(separator)
}

/**
 * An all-zero ESI means the segment is single-homed, which is worth saying in
 * words — it is the common case and the one that rules out multi-homing.
 */
function readEsi(reader: BinaryReader): string {
  const bytes = reader.readBytes(10)
  return bytes.every((b) => b === 0) ? '0 (single-homed)' : toHex(bytes, ':')
}

function readMac(reader: BinaryReader): string {
  return toHex(reader.readBytes(6), ':')
}

/**
 * The 3-byte MPLS Label field as its 20-bit label. VXLAN fabrics put the VNI
 * here (RFC 8365), so this is the number an operator recognises.
 */
function readLabel(reader: BinaryReader): number {
  const bytes = reader.readBytes(3)
  return ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) >> 4
}

/**
 * An address whose length arrives as a bit count — 32 for IPv4, 128 for IPv6.
 * Zero means the field is absent, which for a MAC/IP route means MAC-only.
 */
function readAddressByBitLength(reader: BinaryReader, bits: number): string | undefined {
  if (bits === 0) return undefined
  if (bits === 32) return reader.readIpv4Address()
  if (bits === 128) return formatIpv6(reader.readBytes(16))

  // Neither width: read what the length claims so the caller stays aligned.
  reader.skip(Math.ceil(bits / 8))
  return `(${bits}-bit address)`
}

/**
 * Read one EVPN NLRI entry. The caller has already established that the block
 * belongs to EVPN; `endPos` bounds the whole NLRI block.
 */
function readEvpnRoute(reader: BinaryReader, warnings: string[]): EvpnRoute | null {
  const routeType = reader.readUint8()
  const length = reader.readUint8()
  const routeTypeName = EVPN_ROUTE_TYPE_NAMES[routeType] ?? `Unknown type ${routeType}`

  if (reader.remaining() < length) {
    warnings.push(
      `EVPN ${routeTypeName} route claims ${length} bytes but only ${reader.remaining()} remain`
    )
    return null
  }

  // Each route is read inside its own declared length, so a body this parser
  // reads differently from the sender — a vendor extension, a newer RFC —
  // costs that route only, and the next one still starts in the right place.
  const body = reader.readBytes(length)
  const route: EvpnRoute = { routeType, routeTypeName, rd: '' }

  try {
    const value = new BinaryReader(body, false)
    route.rd = readRouteDistinguisher(value)

    switch (routeType) {
      case EvpnRouteType.ETHERNET_AUTO_DISCOVERY:
        route.esi = readEsi(value)
        route.ethernetTag = value.readUint32()
        route.label = readLabel(value)
        break

      case EvpnRouteType.MAC_IP_ADVERTISEMENT: {
        route.esi = readEsi(value)
        route.ethernetTag = value.readUint32()
        const macBits = value.readUint8()
        route.macAddress = macBits === 48 ? readMac(value) : toHex(value.readBytes(Math.ceil(macBits / 8)), ':')
        route.ipAddress = readAddressByBitLength(value, value.readUint8())
        route.label = readLabel(value)
        // A second label appears when the route also carries an L3 VNI.
        if (value.remaining() >= 3) route.label2 = readLabel(value)
        break
      }

      case EvpnRouteType.INCLUSIVE_MULTICAST:
        route.ethernetTag = value.readUint32()
        route.originatingRouterIp = readAddressByBitLength(value, value.readUint8())
        break

      case EvpnRouteType.ETHERNET_SEGMENT:
        route.esi = readEsi(value)
        route.originatingRouterIp = readAddressByBitLength(value, value.readUint8())
        break

      case EvpnRouteType.IP_PREFIX: {
        route.esi = readEsi(value)
        route.ethernetTag = value.readUint32()
        route.ipPrefixLength = value.readUint8()
        // The prefix and gateway are both 4 or both 16 bytes; which one is
        // decided by how much the route carries, not by a field.
        const addressBytes = value.remaining() >= 32 ? 16 : 4
        route.ipAddress =
          addressBytes === 4 ? value.readIpv4Address() : formatIpv6(value.readBytes(16))
        route.gatewayIp =
          addressBytes === 4 ? value.readIpv4Address() : formatIpv6(value.readBytes(16))
        route.label = readLabel(value)
        break
      }
    }
  } catch {
    // The route type and whatever was read before the trouble are still worth
    // showing — a capture full of EVPN should not go blank over one field.
    route.truncated = true
    warnings.push(`EVPN ${routeTypeName} route body could not be fully read`)
  }

  return route
}

/** Read every EVPN NLRI entry in a block of `length` bytes. */
export function parseEvpnNlri(
  reader: BinaryReader,
  length: number,
  warnings: string[]
): EvpnRoute[] {
  const routes: EvpnRoute[] = []
  const endPos = reader.getPosition() + length

  while (reader.getPosition() + 2 <= endPos) {
    const route = readEvpnRoute(reader, warnings)
    if (!route) break
    routes.push(route)
  }

  // Whatever is left is a route this parser could not frame; skipping to the
  // block's end keeps the attributes after it readable.
  if (reader.getPosition() < endPos) reader.seek(endPos)

  return routes
}

/**
 * One line naming an EVPN route, for the screens that list routes as text.
 *
 * Leads with what identifies the route to the person reading it: a MAC/IP
 * route is remembered by its MAC, a multicast route by the VTEP it came from.
 */
export function formatEvpnRoute(route: EvpnRoute): string {
  const parts: string[] = [`[${route.routeType}]`]

  switch (route.routeType) {
    case EvpnRouteType.MAC_IP_ADVERTISEMENT:
      if (route.macAddress) parts.push(route.macAddress)
      if (route.ipAddress) parts.push(route.ipAddress)
      break
    case EvpnRouteType.INCLUSIVE_MULTICAST:
      parts.push('IMET')
      if (route.originatingRouterIp) parts.push(route.originatingRouterIp)
      break
    case EvpnRouteType.ETHERNET_SEGMENT:
      parts.push('ES')
      if (route.esi) parts.push(route.esi)
      break
    case EvpnRouteType.ETHERNET_AUTO_DISCOVERY:
      parts.push('A-D')
      if (route.esi) parts.push(route.esi)
      break
    case EvpnRouteType.IP_PREFIX:
      if (route.ipAddress) parts.push(`${route.ipAddress}/${route.ipPrefixLength ?? 0}`)
      break
    default:
      parts.push(route.routeTypeName)
  }

  parts.push(`RD ${route.rd}`)
  if (route.label !== undefined) parts.push(`VNI ${route.label}`)

  return parts.join(' ')
}

/**
 * The shortest thing that still identifies an EVPN route, for a table column.
 *
 * A MAC/IP route is remembered by its MAC and a multicast route by the VTEP it
 * came from; the RD and VNI belong in the detail view, where there is room.
 */
export function formatEvpnShort(route: EvpnRoute): string {
  switch (route.routeType) {
    case EvpnRouteType.MAC_IP_ADVERTISEMENT:
      return `[2] ${route.macAddress ?? route.rd}`
    case EvpnRouteType.INCLUSIVE_MULTICAST:
      return `[3] IMET ${route.originatingRouterIp ?? route.rd}`
    case EvpnRouteType.ETHERNET_SEGMENT:
      return `[4] ES ${route.esi ?? route.rd}`
    case EvpnRouteType.ETHERNET_AUTO_DISCOVERY:
      return `[1] A-D ${route.esi ?? route.rd}`
    case EvpnRouteType.IP_PREFIX:
      return `[5] ${route.ipAddress ?? route.rd}/${route.ipPrefixLength ?? 0}`
    default:
      return `[${route.routeType}] ${route.rd}`
  }
}
