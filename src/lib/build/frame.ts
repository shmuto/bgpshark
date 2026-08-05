/**
 * Wrap a TCP payload in the headers a capture actually contains: TCP, then
 * IPv4 or IPv6, then Ethernet or Linux SLL.
 *
 * The headers are built properly rather than approximately — real checksums, a
 * real pseudo-header, minimum-size Ethernet padding — because a built capture
 * is worth having only if the tools that read captures accept it. BGPShark's
 * own parser ignores every field written here except the addresses, ports and
 * flags, so a shortcut would go unnoticed right up until the file was opened in
 * Wireshark or fed to a router.
 */
import { ByteWriter, addressBytes, internetChecksum } from './bytes'
import { EtherType, IpProtocol, LinkLayerType, type TcpFlags } from '../pcap/types'
import { parsePrefix } from '../net/prefix'

/** Ethernet's minimum frame size excluding the FCS, which captures omit. */
const ETHERNET_MIN_FRAME = 60

const IPV4_HEADER_LENGTH = 20
const IPV6_HEADER_LENGTH = 40
const TCP_HEADER_LENGTH = 20

export interface TcpFrameSpec {
  linkType: number
  srcMac: string
  dstMac: string
  /** VLAN IDs outermost first; two of them make a QinQ frame. Ethernet only. */
  vlanIds?: number[]
  srcIp: string
  dstIp: string
  srcPort: number
  dstPort: number
  seq: number
  ack: number
  flags: Partial<TcpFlags>
  window?: number
  ttl?: number
  ipId?: number
  payload?: Uint8Array
}

/** One complete frame, link layer and all, as it would sit in a pcap record. */
export function buildTcpFrame(spec: TcpFrameSpec): Uint8Array {
  const family = addressFamily(spec.srcIp)
  if (addressFamily(spec.dstIp) !== family) {
    throw new Error(`Cannot send from ${spec.srcIp} to ${spec.dstIp}: different address families`)
  }

  const payload = spec.payload ?? new Uint8Array(0)
  const srcIpBytes = addressBytes(spec.srcIp, family)
  const dstIpBytes = addressBytes(spec.dstIp, family)

  const tcp = buildTcpSegment(spec, srcIpBytes, dstIpBytes, family, payload)
  const ip =
    family === 4
      ? buildIpv4Header(spec, srcIpBytes, dstIpBytes, tcp.length)
      : buildIpv6Header(spec, srcIpBytes, dstIpBytes, tcp.length)

  const etherType = family === 4 ? EtherType.IPV4 : EtherType.IPV6
  const frame = new ByteWriter()

  if (spec.linkType === LinkLayerType.SLL) {
    writeSllHeader(frame, spec.srcMac, etherType)
  } else {
    writeEthernetHeader(frame, spec, etherType)
  }

  frame.bytes(ip).bytes(tcp)

  const bytes = frame.toBytes()
  if (spec.linkType !== LinkLayerType.SLL && bytes.length < ETHERNET_MIN_FRAME) {
    // A bare ACK is shorter than Ethernet's minimum, so the NIC pads it. Real
    // captures show that padding; leaving it out would make every handshake
    // frame a byte count no capture has ever contained.
    const padded = new Uint8Array(ETHERNET_MIN_FRAME)
    padded.set(bytes)
    return padded
  }

  return bytes
}

function addressFamily(text: string): 4 | 6 {
  const parsed = parsePrefix(text)
  if (!parsed || parsed.hasMask) {
    throw new Error(`Not an IP address: "${text}"`)
  }
  return parsed.family
}

// ---------------------------------------------------------------------------
// Link layer
// ---------------------------------------------------------------------------

function writeEthernetHeader(writer: ByteWriter, spec: TcpFrameSpec, etherType: number): void {
  writer.bytes(macBytes(spec.dstMac))
  writer.bytes(macBytes(spec.srcMac))

  const vlanIds = spec.vlanIds ?? []
  for (let i = 0; i < vlanIds.length; i++) {
    // Each tag announces itself and hands the next one the EtherType slot: an
    // outer 802.1ad tag followed by an inner 802.1Q tag is a QinQ frame.
    writer.u16(i === 0 && vlanIds.length > 1 ? EtherType.QINQ : EtherType.VLAN)
    writer.u16(vlanIds[i] & 0x0fff)
  }

  writer.u16(etherType)
}

function writeSllHeader(writer: ByteWriter, srcMac: string, etherType: number): void {
  writer.u16(0) // Packet type: sent to us
  writer.u16(1) // ARPHRD_ETHER
  writer.u16(6) // Link-layer address length
  writer.bytes(macBytes(srcMac)).zeros(2) // Address, padded to 8 bytes
  writer.u16(etherType)
}

function macBytes(text: string): Uint8Array {
  const parts = text.split(':')
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-f]{1,2}$/i.test(p))) {
    throw new Error(`Not a MAC address: "${text}"`)
  }
  return Uint8Array.from(parts, (part) => parseInt(part, 16))
}

// ---------------------------------------------------------------------------
// Network layer
// ---------------------------------------------------------------------------

function buildIpv4Header(
  spec: TcpFrameSpec,
  srcIp: Uint8Array,
  dstIp: Uint8Array,
  payloadLength: number
): Uint8Array {
  const writer = new ByteWriter()

  writer.u8(0x45) // Version 4, header length 5 words
  writer.u8(0) // DSCP / ECN
  writer.u16(IPV4_HEADER_LENGTH + payloadLength)
  writer.u16(spec.ipId ?? 0)
  writer.u16(0x4000) // Don't Fragment
  writer.u8(spec.ttl ?? 64)
  writer.u8(IpProtocol.TCP)
  const checksumOffset = writer.placeholderU16()
  writer.bytes(srcIp).bytes(dstIp)

  const header = writer.toBytes()
  writer.patchU16(checksumOffset, internetChecksum(header))

  return writer.toBytes()
}

function buildIpv6Header(
  spec: TcpFrameSpec,
  srcIp: Uint8Array,
  dstIp: Uint8Array,
  payloadLength: number
): Uint8Array {
  const writer = new ByteWriter()

  writer.u32(0x60000000) // Version 6, no traffic class or flow label
  writer.u16(payloadLength)
  writer.u8(IpProtocol.TCP) // Next header
  writer.u8(spec.ttl ?? 64) // Hop limit
  writer.bytes(srcIp).bytes(dstIp)

  return writer.toBytes()
}

/** IPv6 has no header checksum, so `IPV6_HEADER_LENGTH` is only used for sizing. */
export function ipHeaderLength(family: 4 | 6): number {
  return family === 4 ? IPV4_HEADER_LENGTH : IPV6_HEADER_LENGTH
}

// ---------------------------------------------------------------------------
// Transport layer
// ---------------------------------------------------------------------------

function buildTcpSegment(
  spec: TcpFrameSpec,
  srcIp: Uint8Array,
  dstIp: Uint8Array,
  family: 4 | 6,
  payload: Uint8Array
): Uint8Array {
  const writer = new ByteWriter()

  writer.u16(spec.srcPort)
  writer.u16(spec.dstPort)
  writer.u32(spec.seq)
  writer.u32(spec.ack)
  writer.u16((5 << 12) | flagBits(spec.flags)) // 5-word header, no options
  writer.u16(spec.window ?? 16384)
  const checksumOffset = writer.placeholderU16()
  writer.u16(0) // Urgent pointer
  writer.bytes(payload)

  const segment = writer.toBytes()
  writer.patchU16(
    checksumOffset,
    internetChecksum(pseudoHeader(srcIp, dstIp, family, segment.length), segment)
  )

  return writer.toBytes()
}

function flagBits(flags: Partial<TcpFlags>): number {
  return (
    (flags.fin ? 0x01 : 0) |
    (flags.syn ? 0x02 : 0) |
    (flags.rst ? 0x04 : 0) |
    (flags.psh ? 0x08 : 0) |
    (flags.ack ? 0x10 : 0) |
    (flags.urg ? 0x20 : 0)
  )
}

/**
 * The addresses and length TCP's checksum covers but its header does not carry
 * — which is why the checksum has to be computed after the IP addresses are
 * known, and why it differs between the two families.
 */
function pseudoHeader(
  srcIp: Uint8Array,
  dstIp: Uint8Array,
  family: 4 | 6,
  tcpLength: number
): Uint8Array {
  const writer = new ByteWriter()
  writer.bytes(srcIp).bytes(dstIp)

  if (family === 4) {
    writer.u8(0).u8(IpProtocol.TCP).u16(tcpLength)
  } else {
    writer.u32(tcpLength).zeros(3).u8(IpProtocol.TCP)
  }

  return writer.toBytes()
}

/**
 * The largest TCP payload that fits an MTU, so a burst of UPDATEs is segmented
 * the way a real session segments it rather than emitted as one impossible
 * frame.
 */
export function maxSegmentSize(mtu: number, family: 4 | 6): number {
  return mtu - ipHeaderLength(family) - TCP_HEADER_LENGTH
}
