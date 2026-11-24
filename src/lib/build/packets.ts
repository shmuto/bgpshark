/**
 * Captures that are not a BGP session: a list of packets, each stated outright.
 *
 * A `Scenario` is the right tool for a session because it keeps TCP honest —
 * sequence numbers follow from what was sent, the handshake comes first. That
 * is the wrong tool for the traffic a capture contains *besides* the session:
 * the ICMP that proves the path is up, the UDP that a SPAN port also caught, a
 * TCP connection on another port that is not BGP, a stray RST from a firewall
 * with sequence numbers that match nothing. Those are a packet each, written
 * the way you would read them off a capture, and merged in with
 * `mergeCaptures`.
 *
 * Nothing here tracks connection state. A TCP packet carries exactly the
 * sequence number and flags it is given, which is the point: it is how a
 * capture gets a segment no well-behaved stack would send.
 */
import { buildIcmpFrame, buildRawIpFrame, buildTcpFrame, buildUdpFrame, type IpFrameSpec } from './frame'
import type { BuiltCapture, Side } from './scenario'
import { LinkLayerType, type TcpFlags } from '../pcap/types'
import { writePcap, type ExportableFrame } from '../pcap/writer'

type Common = {
  src: string
  dst: string
  /**
   * Milliseconds after the capture starts. Without it, a packet comes `gap`
   * after the one before it.
   */
  at?: number
  /** Milliseconds after the previous packet, when `at` is not given. */
  gap?: number
  srcMac?: string
  dstMac?: string
  /** Per packet, overriding the list's own. */
  vlanIds?: number[]
  ttl?: number
  ipId?: number
  /**
   * The peer this packet belongs to, if it is part of a session — so that
   * `keepSide` keeps or drops it with the rest of that side's frames.
   */
  from?: Side
}

export type PacketSpec = Common &
  (
    | {
        protocol: 'tcp'
        srcPort: number
        dstPort: number
        seq?: number
        ack?: number
        /** `'SYN'`, `'RST,ACK'`, … or the flags themselves. */
        flags?: string | Partial<TcpFlags>
        window?: number
        payload?: Uint8Array
      }
    | { protocol: 'udp'; srcPort: number; dstPort: number; payload?: Uint8Array }
    /** ICMPv6 when the addresses are IPv6. Defaults to an echo request. */
    | { protocol: 'icmp'; type?: number; code?: number; body?: Uint8Array }
    /** Any other IP protocol number, payload verbatim. */
    | { protocol: number; payload?: Uint8Array }
  )

export interface PacketList {
  packets: PacketSpec[]
  linkType?: number
  /** VLAN IDs outermost first, for every packet that does not set its own. */
  vlanIds?: number[]
  startTime?: Date
  /** Milliseconds between packets that set neither `at` nor `gap`. Default 100. */
  gap?: number
}

const DEFAULT_GAP_MS = 100
const DEFAULT_START = new Date('2026-01-01T00:00:00Z')
const ECHO_REQUEST = { 4: 8, 6: 128 } as const
/** Echo request and reply, both families: the types whose body starts with an identifier and sequence. */
const ECHO_TYPES = new Set([0, 8, 128, 129])

// Locally administered, like the scenario builder's, but a different pair so
// that merged frames from the two builders can still be told apart.
const DEFAULT_SRC_MAC = '02:00:00:00:01:01'
const DEFAULT_DST_MAC = '02:00:00:00:01:02'

/** `'SYN,ACK'` → `{ syn: true, ack: true }`. */
export function tcpFlags(text: string): Partial<TcpFlags> {
  const flags: Partial<TcpFlags> = {}
  for (const name of text.split(/[\s,|+]+/).filter(Boolean)) {
    const key = name.toLowerCase() as keyof TcpFlags
    if (!['fin', 'syn', 'rst', 'psh', 'ack', 'urg'].includes(key)) {
      throw new Error(`Unknown TCP flag "${name}"`)
    }
    flags[key] = true
  }
  return flags
}

/**
 * An echo's identifier and sequence number, when the packet did not give a
 * body: without them an echo is four bytes short of the smallest one a stack
 * sends, and Wireshark marks it malformed.
 */
function echoBody(sequence: number): Uint8Array {
  return Uint8Array.of(0, 1, (sequence >> 8) & 0xff, sequence & 0xff)
}

function buildFrame(packet: PacketSpec, ip: IpFrameSpec, echoSequence: number): Uint8Array {
  switch (packet.protocol) {
    case 'tcp':
      return buildTcpFrame({
        ...ip,
        srcPort: packet.srcPort,
        dstPort: packet.dstPort,
        seq: packet.seq ?? 0,
        ack: packet.ack ?? 0,
        flags: typeof packet.flags === 'string' ? tcpFlags(packet.flags) : (packet.flags ?? { ack: true }),
        window: packet.window,
        payload: packet.payload,
      })
    case 'udp':
      return buildUdpFrame({ ...ip, srcPort: packet.srcPort, dstPort: packet.dstPort, payload: packet.payload })
    case 'icmp': {
      const type = packet.type ?? ECHO_REQUEST[ip.srcIp.includes(':') ? 6 : 4]
      const body = packet.body ?? (ECHO_TYPES.has(type) ? echoBody(echoSequence) : undefined)
      return buildIcmpFrame({ ...ip, type, code: packet.code, body })
    }
    default:
      return buildRawIpFrame({ ...ip, protocol: packet.protocol, payload: packet.payload })
  }
}

/** Build a capture of exactly these packets. */
export function buildPackets(list: PacketList): BuiltCapture {
  const linkType = list.linkType ?? LinkLayerType.ETHERNET
  const start = (list.startTime ?? DEFAULT_START).getTime()
  const frames: ExportableFrame[] = []
  const senders: Array<Side | undefined> = []

  let time = start
  let echoes = 0
  for (const packet of list.packets) {
    // A request and its reply share a sequence number, so count requests only.
    if (packet.protocol === 'icmp' && (packet.type === undefined || packet.type === 8 || packet.type === 128)) {
      echoes++
    }
    time = packet.at !== undefined ? start + packet.at : time + (packet.gap ?? list.gap ?? DEFAULT_GAP_MS)
    const frameBytes = buildFrame(packet, {
      linkType,
      srcMac: packet.srcMac ?? DEFAULT_SRC_MAC,
      dstMac: packet.dstMac ?? DEFAULT_DST_MAC,
      vlanIds: packet.vlanIds ?? list.vlanIds,
      srcIp: packet.src,
      dstIp: packet.dst,
      ttl: packet.ttl,
      ipId: packet.ipId,
    }, Math.max(echoes, 1))
    frames.push({ timestamp: new Date(time), frameBytes, originalLength: frameBytes.length })
    senders.push(packet.from)
  }

  return { bytes: writePcap(frames, linkType), frames, senders, linkType, warnings: [] }
}
