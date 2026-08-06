/**
 * Compile a described BGP session into the frames of a capture.
 *
 * A scenario names two peers and a sequence of things that happen between them
 * — the TCP handshake, the OPEN exchange, some UPDATEs, a NOTIFICATION, a
 * reset. This turns that into pcap frames with a consistent TCP conversation
 * underneath: sequence and acknowledgement numbers that follow from what was
 * actually sent, so the result reads as one session rather than a pile of
 * packets that happen to share an address pair.
 *
 * Two decisions are made here rather than left to the caller, because both are
 * consequences of the scenario rather than choices within it:
 *
 * - **How UPDATEs are encoded.** AS number width and Path Identifiers are
 *   negotiated in the OPENs, so they are derived from the two peers'
 *   capabilities exactly as `BgpSessionTracker` derives them when reading. A
 *   capture where the OPENs say one thing and the UPDATEs do another is a
 *   capture no session could have produced.
 * - **Where segment boundaries fall.** Messages sent in one step are packed
 *   into a byte stream and cut at the MSS, which is what TCP does. Lowering
 *   `mss` is therefore how you build a capture whose BGP messages span
 *   segments — the case the parser's reassembly exists for.
 */
import { encodeMessage, type BgpMessageSpec, type CapabilitySpec, type EncodeOptions, type OpenSpec } from './bgp-encode'
import { buildTcpFrame, maxSegmentSize } from './frame'
import { Afi, CapabilityCode, Safi } from '../bgp/constants'
import { afiSafiKey } from '../bgp/session'
import { LinkLayerType } from '../pcap/types'
import { parsePrefix } from '../net/prefix'
import { writePcap, type ExportableFrame } from '../pcap/writer'

export type Side = 'a' | 'b'

export interface ScenarioPeer {
  ip: string
  /**
   * Defaults to 179 for `b` (which listens) and an ephemeral port for `a`
   * (which connects). Set both to build the two halves of a collision.
   */
  port?: number
  mac?: string
  as: number
  routerId: string
  holdTime?: number
  /** Defaults to what a current speaker sends: MP-BGP IPv4 unicast, route refresh, 4-byte AS. */
  capabilities?: CapabilitySpec[]
}

export type ScenarioStep =
  /** SYN, SYN-ACK, ACK. */
  | { kind: 'handshake'; gap?: number }
  /** The OPEN this peer's configuration describes. */
  | { kind: 'open'; from: Side; gap?: number }
  | { kind: 'keepalive'; from: Side; gap?: number }
  /** Any messages at all, packed into as few segments as the MSS allows. */
  | { kind: 'send'; from: Side; messages: BgpMessageSpec[]; gap?: number }
  /** FIN, ACK, FIN, ACK. */
  | { kind: 'close'; from: Side; gap?: number }
  | { kind: 'reset'; from: Side; gap?: number }
  /** Advance the clock without sending anything — a hold timer running out. */
  | { kind: 'delay'; gap: number }

export interface Scenario {
  name?: string
  a: ScenarioPeer
  b: ScenarioPeer
  steps: ScenarioStep[]
  linkType?: number
  /** VLAN IDs outermost first. Two of them make a QinQ capture. */
  vlanIds?: number[]
  startTime?: Date
  /** Milliseconds between frames when a step does not say. */
  gap?: number
  /** Path MTU, which decides where segment boundaries fall. Default 1500. */
  mtu?: number
}

export interface BuiltCapture {
  /** A complete classic pcap file. */
  bytes: Uint8Array
  frames: ExportableFrame[]
  linkType: number
  /** Anything the scenario asked for that could not be honoured exactly. */
  warnings: string[]
}

const DEFAULT_BGP_PORT = 179
const DEFAULT_EPHEMERAL_PORT = 51000
const DEFAULT_GAP_MS = 100
const DEFAULT_MTU = 1500
const DEFAULT_HOLD_TIME = 90

/** Fixed so that building the same scenario twice produces the same bytes. */
const INITIAL_SEQUENCE: Record<Side, number> = { a: 1000, b: 2_000_000 }

function defaultCapabilities(peer: ScenarioPeer): CapabilitySpec[] {
  return [
    { type: 'MULTIPROTOCOL', afi: familyAfi(peer.ip), safi: Safi.UNICAST },
    { type: 'ROUTE_REFRESH' },
    { type: 'FOUR_OCTET_AS', asNumber: peer.as },
  ]
}

/**
 * The address family a peer's *transport* uses, which is the family it will be
 * exchanging routes for unless the scenario says otherwise. A v6 peering that
 * advertised only the IPv4 unicast capability would be a strange default.
 */
function familyAfi(ip: string): number {
  return parsePrefix(ip)?.family === 6 ? Afi.IPV6 : Afi.IPV4
}

function defaultMac(side: Side): string {
  // Locally administered, so these can never collide with a real vendor OUI.
  return side === 'a' ? '02:00:00:00:00:01' : '02:00:00:00:00:02'
}

// ---------------------------------------------------------------------------
// Capability negotiation
// ---------------------------------------------------------------------------

/** The OPEN a peer's configuration describes. */
export function openFor(peer: ScenarioPeer): OpenSpec {
  return {
    type: 'OPEN',
    myAs: peer.as,
    holdTime: peer.holdTime ?? DEFAULT_HOLD_TIME,
    bgpIdentifier: peer.routerId,
    capabilities: peer.capabilities ?? defaultCapabilities(peer),
  }
}

/**
 * What the two ends have in common, which is what governs how UPDATEs on this
 * session are written. Both capabilities are negotiated, so both ends must
 * advertise one for it to apply — the same rule `BgpSessionTracker` applies in
 * the other direction.
 */
function negotiate(a: ScenarioPeer, b: ScenarioPeer): EncodeOptions {
  const capsA = a.capabilities ?? defaultCapabilities(a)
  const capsB = b.capabilities ?? defaultCapabilities(b)

  const fourByteAs = advertisesFourByteAs(capsA) && advertisesFourByteAs(capsB)

  // Path Identifiers go on the wire only where the sender said it would send
  // them and the receiver said it could take them.
  const receiverFamilies = addPathFamilies(capsB)
  const addPath = new Set<string>()
  for (const [key, sendReceive] of addPathFamilies(capsA)) {
    const peer = receiverFamilies.get(key)
    const senderSends = sendReceive === 'send' || sendReceive === 'both'
    const peerReceives = peer === 'receive' || peer === 'both'
    if (senderSends && peerReceives) addPath.add(key)
  }

  return { fourByteAs, addPath }
}

function advertisesFourByteAs(caps: CapabilitySpec[]): boolean {
  return caps.some(
    (c) =>
      c.type === 'FOUR_OCTET_AS' || (c.type === 'RAW' && c.code === CapabilityCode.FOUR_OCTET_AS)
  )
}

type AddPathDirection = 'receive' | 'send' | 'both'

function addPathFamilies(caps: CapabilitySpec[]): Map<string, AddPathDirection> {
  const families = new Map<string, AddPathDirection>()
  for (const capability of caps) {
    if (capability.type !== 'ADD_PATH') continue
    for (const family of capability.addressFamilies) {
      families.set(afiSafiKey(family.afi, family.safi), family.sendReceive)
    }
  }
  return families
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

interface SideState {
  ip: string
  port: number
  mac: string
  /** Next sequence number this side will put on the wire. */
  seq: number
  /** What this side has received, i.e. what it will acknowledge. */
  ack: number
}

class ScenarioCompiler {
  private readonly frames: ExportableFrame[] = []
  readonly warnings: string[] = []

  private readonly state: Record<Side, SideState>
  private readonly linkType: number
  private readonly vlanIds: number[]
  private readonly mss: number
  private readonly options: EncodeOptions
  private readonly defaultGap: number
  private time: number
  private ipId = 1

  constructor(private readonly scenario: Scenario) {
    const { a, b } = scenario

    this.linkType = scenario.linkType ?? LinkLayerType.ETHERNET
    this.vlanIds = scenario.vlanIds ?? []
    this.defaultGap = scenario.gap ?? DEFAULT_GAP_MS
    this.time = (scenario.startTime ?? new Date('2026-01-01T00:00:00Z')).getTime()
    this.options = negotiate(a, b)

    const family = parsePrefix(a.ip)?.family === 6 ? 6 : 4
    this.mss = maxSegmentSize(scenario.mtu ?? DEFAULT_MTU, family)

    this.state = {
      a: {
        ip: a.ip,
        port: a.port ?? DEFAULT_EPHEMERAL_PORT,
        mac: a.mac ?? defaultMac('a'),
        seq: INITIAL_SEQUENCE.a,
        ack: 0,
      },
      b: {
        ip: b.ip,
        port: b.port ?? DEFAULT_BGP_PORT,
        mac: b.mac ?? defaultMac('b'),
        seq: INITIAL_SEQUENCE.b,
        ack: 0,
      },
    }
  }

  compile(): BuiltCapture {
    for (const step of this.scenario.steps) {
      this.advance(step.kind === 'delay' ? step.gap : (step.gap ?? this.defaultGap))
      this.run(step)
    }

    return {
      bytes: writePcap(this.frames, this.linkType),
      frames: this.frames,
      linkType: this.linkType,
      warnings: this.warnings,
    }
  }

  private run(step: ScenarioStep): void {
    switch (step.kind) {
      case 'handshake':
        this.handshake()
        break
      case 'open':
        this.send(step.from, [openFor(this.scenario[step.from])])
        break
      case 'keepalive':
        this.send(step.from, [{ type: 'KEEPALIVE' }])
        break
      case 'send':
        this.send(step.from, step.messages)
        break
      case 'close':
        this.close(step.from)
        break
      case 'reset':
        this.emit(step.from, { rst: true, ack: true })
        break
      case 'delay':
        break
    }
  }

  private advance(ms: number): void {
    this.time += ms
  }

  private other(side: Side): Side {
    return side === 'a' ? 'b' : 'a'
  }

  /**
   * Put one segment on the wire from `side`, and tell the other end about it.
   *
   * SYN and FIN each take up a sequence number of their own even though they
   * carry no data, which is what makes a handshake's numbers come out right.
   */
  private emit(
    side: Side,
    flags: { syn?: boolean; ack?: boolean; fin?: boolean; rst?: boolean; psh?: boolean },
    payload?: Uint8Array
  ): void {
    const from = this.state[side]
    const to = this.state[this.other(side)]

    const frameBytes = buildTcpFrame({
      linkType: this.linkType,
      vlanIds: this.vlanIds,
      srcMac: from.mac,
      dstMac: to.mac,
      srcIp: from.ip,
      dstIp: to.ip,
      srcPort: from.port,
      dstPort: to.port,
      seq: from.seq,
      ack: flags.ack ? from.ack : 0,
      flags,
      ipId: this.ipId++,
      payload,
    })

    this.frames.push({
      timestamp: new Date(this.time),
      frameBytes,
      originalLength: frameBytes.length,
    })

    const consumed = (payload?.length ?? 0) + (flags.syn ? 1 : 0) + (flags.fin ? 1 : 0)
    from.seq += consumed
    to.ack = from.seq
  }

  private handshake(): void {
    this.emit('a', { syn: true })
    this.advance(1)
    this.emit('b', { syn: true, ack: true })
    this.advance(1)
    this.emit('a', { ack: true })
  }

  private close(side: Side): void {
    const peer = this.other(side)

    this.emit(side, { fin: true, ack: true })
    this.advance(1)
    this.emit(peer, { ack: true })
    this.advance(1)
    this.emit(peer, { fin: true, ack: true })
    this.advance(1)
    this.emit(side, { ack: true })
  }

  /**
   * Send messages as a byte stream cut at the MSS — so several small messages
   * share a segment, and one large message spans several.
   */
  private send(side: Side, messages: BgpMessageSpec[]): void {
    const encoded = messages.map((message) => encodeMessage(message, this.options))
    const total = encoded.reduce((sum, bytes) => sum + bytes.length, 0)
    if (total === 0) return

    const stream = new Uint8Array(total)
    let offset = 0
    for (const bytes of encoded) {
      stream.set(bytes, offset)
      offset += bytes.length
    }

    for (let start = 0; start < stream.length; start += this.mss) {
      const end = Math.min(start + this.mss, stream.length)
      if (start > 0) this.advance(1)
      // PSH on the last segment of the write, as a stack that has nothing more
      // to send would set it.
      this.emit(side, { psh: end === stream.length, ack: true }, stream.subarray(start, end))
    }
  }
}

/** Build the capture a scenario describes. */
export function buildScenario(scenario: Scenario): BuiltCapture {
  return new ScenarioCompiler(scenario).compile()
}
