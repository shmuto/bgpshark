/**
 * What the dashboard puts in the Alerts panel.
 *
 * Kept out of the page so the grouping keys, thresholds and ordering can be
 * tested without a browser.
 *
 * The panel is read top-down by someone who has a capture and a complaint, so
 * two rules shape everything here: one row per *problem*, not per packet — a
 * peer retrying a rejected OPEN for ten minutes is one problem — and a row for
 * anything the capture shows going wrong, including routes moving while the
 * sessions themselves stay up.
 */
import type {
  BgpPacket,
  BgpNotificationMessage,
  BgpOpenMessage,
  BgpUpdateMessage,
  GracefulRestartCapability,
  MpUnreachNlriAttribute,
} from '../../lib/bgp/types'
import { endOfRibMarker } from '../../lib/bgp/update'
import type { GenericPacket } from '../../lib/pcap'
import { aggregatePrefixStats, type PrefixStats } from '../../lib/bgp/prefix-stats'
import type { DashboardAlert } from './types'
import { formatAsPath } from '../../lib/bgp/as-path-display'

// A pair of peers is considered "flapped" once we see more than one full
// OPEN handshake (2 OPENs = one handshake) between the same two IPs.
const FLAP_OPEN_THRESHOLD = 4

// This many withdrawn prefixes inside a single 10s window counts as a burst.
const WITHDRAWN_BURST_WINDOW_MS = 10_000
const WITHDRAWN_BURST_THRESHOLD = 10

// Route-level findings are per-prefix, and a churning capture has hundreds of
// them. Only the worst few earn a row; the rest are counted in one summary row
// that points at the Routes screen.
const ROUTE_ALERT_LIMIT = 5

function sortedPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function getWithdrawnCount(update: BgpUpdateMessage): number {
  let count = update.withdrawnRoutes.length
  for (const attr of update.pathAttributes) {
    if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
      count += (attr.parsed as MpUnreachNlriAttribute).withdrawnRoutes.length
    }
  }
  return count
}

/** Both directions of one session, the narrowing every peer-level alert wants. */
function sessionFilter(ipA: string, ipB: string): string {
  return `(src=${ipA} and dst=${ipB}) or (src=${ipB} and dst=${ipA})`
}

interface NotificationGroup {
  title: string
  srcIp: string
  dstIp: string
  first: Date
  last: Date
  /** Packet holding `first`, so "View →" opens the start of the story. */
  firstPacketIndex: number
  count: number
}

/**
 * One row per (sender → receiver, error code, subcode).
 *
 * The direction is part of the key because it is part of the event: A telling B
 * its AS is wrong is a different fault from B telling A the same thing, and the
 * row names a direction.
 */
function groupNotifications(packets: BgpPacket[]): DashboardAlert[] {
  const groups = new Map<string, NotificationGroup>()

  packets.forEach((packet, packetIndex) => {
    for (const msg of packet.messages) {
      if (msg.type !== 'NOTIFICATION') continue
      const notif = msg as BgpNotificationMessage
      const key = `${packet.srcIp}|${packet.dstIp}|${notif.errorCode}|${notif.errorSubcode}`
      const group = groups.get(key)
      if (!group) {
        groups.set(key, {
          title: `NOTIFICATION: ${notif.errorCodeName} / ${notif.errorSubcodeName}`,
          srcIp: packet.srcIp,
          dstIp: packet.dstIp,
          first: packet.timestamp,
          last: packet.timestamp,
          firstPacketIndex: packetIndex,
          count: 1,
        })
        continue
      }
      group.count++
      // Captures are usually in time order, but a merged or reordered one is
      // not, and the row promises the earliest occurrence.
      if (packet.timestamp < group.first) {
        group.first = packet.timestamp
        group.firstPacketIndex = packetIndex
      }
      if (packet.timestamp > group.last) group.last = packet.timestamp
    }
  })

  return Array.from(groups.values()).map((group) => ({
    id: `notif-${group.firstPacketIndex}`,
    severity: 'critical' as const,
    title: group.title,
    detail: `${group.srcIp} → ${group.dstIp}`,
    timestamp: group.first,
    filter: sessionFilter(group.srcIp, group.dstIp),
    packetIndex: group.firstPacketIndex,
    count: group.count,
    timeSpan: group.count > 1 ? { start: group.first, end: group.last } : undefined,
  }))
}

/** Distinct AS_PATHs announced for a route, in the order they first appeared. */
function distinctAsPaths(stat: PrefixStats): string[] {
  const paths: string[] = []
  for (const event of stat.history) {
    if (event.action !== 'announce' || event.asPath === undefined) continue
    if (!paths.includes(event.asPath)) paths.push(event.asPath)
  }
  return paths
}

function describeAsPath(path: string): string {
  // Collapsed the same way the routes screen shows it, so a prepend reads as a
  // count in both places rather than as a wall of the same AS number.
  return path === '' ? '(no AS_PATH)' : formatAsPath(path)
}

/**
 * Routes moving while every session stays up — the case the panel used to call
 * "no issues detected" at someone who came in looking for a missing route.
 *
 * Warnings, not criticals: nothing here means a session is broken.
 */
function computeRouteAlerts(stats: PrefixStats[]): DashboardAlert[] {
  const alerts: DashboardAlert[] = []

  // A route that went away at least once. `flap` is already counted per
  // (route, announcing peer) by aggregatePrefixStats, so a widely announced
  // stable route does not score here.
  const flapping = stats
    .filter((stat) => stat.flap >= 1)
    .sort((a, b) => b.flap - a.flap || b.lastSeenMs - a.lastSeenMs)

  for (const stat of flapping.slice(0, ROUTE_ALERT_LIMIT)) {
    const withdraws = stat.history.filter((event) => event.action === 'withdraw')
    // flap >= 1 guarantees a withdraw; the fallback only keeps the types honest.
    const first = withdraws[0] ?? stat.history[0]
    const last = withdraws[withdraws.length - 1] ?? first
    alerts.push({
      id: `route-flap-${stat.key}`,
      severity: 'warning',
      title: `Route flapping: ${stat.key}`,
      detail: `${stat.announced} announcements, ${stat.withdrawn} withdrawals`,
      timestamp: first.timestamp,
      filter: `prefix = ${stat.key}`,
      packetIndex: first.packetIndex,
      count: stat.flap,
      timeSpan: stat.flap > 1 ? { start: first.timestamp, end: last.timestamp } : undefined,
    })
  }

  if (flapping.length > ROUTE_ALERT_LIMIT) {
    const rest = flapping.slice(ROUTE_ALERT_LIMIT)
    const restFlaps = rest.reduce((sum, stat) => sum + stat.flap, 0)
    alerts.push({
      id: 'route-flap-more',
      severity: 'warning',
      title: `${rest.length} more prefixes flapped`,
      detail: `${restFlaps} further withdrawals — sort the Routes screen by Flap to see them all`,
      timestamp: null,
      filter: 'type=UPDATE',
    })
  }

  // More than one AS_PATH for the same route: a reroute, a prepend change, or
  // a leak. Which of those it is only the AS numbers can say, so the row shows
  // the first path and the latest one.
  const repathed = stats
    .map((stat) => ({ stat, paths: distinctAsPaths(stat) }))
    .filter((entry) => entry.paths.length > 1)
    .sort((a, b) => b.paths.length - a.paths.length || b.stat.lastSeenMs - a.stat.lastSeenMs)

  for (const { stat, paths } of repathed.slice(0, ROUTE_ALERT_LIMIT)) {
    // The packet worth opening is the one where the path first differed, not
    // the original announcement.
    const change =
      stat.history.find(
        (event) => event.action === 'announce' && event.asPath !== undefined && event.asPath !== paths[0]
      ) ?? stat.history[0]
    alerts.push({
      id: `route-aspath-${stat.key}`,
      severity: 'warning',
      title: `AS_PATH changed: ${stat.key}`,
      detail: `${describeAsPath(paths[0])} → ${describeAsPath(paths[paths.length - 1])}`,
      timestamp: change.timestamp,
      filter: `prefix = ${stat.key}`,
      packetIndex: change.packetIndex,
      count: paths.length,
    })
  }

  if (repathed.length > ROUTE_ALERT_LIMIT) {
    const rest = repathed.slice(ROUTE_ALERT_LIMIT)
    alerts.push({
      id: 'route-aspath-more',
      severity: 'warning',
      title: `${rest.length} more prefixes changed AS_PATH`,
      detail: 'Open the Routes screen to compare their paths',
      timestamp: null,
      filter: 'type=UPDATE',
    })
  }

  return alerts
}

/**
 * What the two ends of one TCP peering contributed, which is all the
 * establishment rules below need to know.
 */
interface PairFacts {
  ipA: string
  ipB: string
  /** Distinct `src>dst` strings seen at the TCP layer. One means half a story. */
  directions: Set<string>
  /** SYN-ACKs, i.e. times the far end accepted a connection on port 179. */
  accepted: number
  /** Addresses that sent at least one BGP message. */
  bgpSenders: Set<string>
  /** Index into the BGP packet array, for the "View →" link. */
  firstBgpIndex?: number
  firstSeen: Date | null
}

function collectPairFacts(
  packets: BgpPacket[],
  allPackets: GenericPacket[]
): Map<string, PairFacts> {
  const pairs = new Map<string, PairFacts>()

  const factsFor = (src: string, dst: string): PairFacts => {
    const key = sortedPairKey(src, dst)
    let facts = pairs.get(key)
    if (!facts) {
      const [ipA, ipB] = key.split('|')
      facts = {
        ipA,
        ipB,
        directions: new Set(),
        accepted: 0,
        bgpSenders: new Set(),
        firstSeen: null,
      }
      pairs.set(key, facts)
    }
    return facts
  }

  for (const packet of allPackets) {
    if (packet.protocol !== 'TCP') continue
    if (packet.srcPort !== 179 && packet.dstPort !== 179) continue

    const facts = factsFor(packet.srcIp, packet.dstIp)
    facts.directions.add(`${packet.srcIp}>${packet.dstIp}`)
    // A SYN-ACK is the far end saying "something is listening here". It is the
    // fact that separates "nothing answers" from "answered, then said nothing".
    if (packet.tcpFlags?.syn && packet.tcpFlags.ack) facts.accepted++
    if (!facts.firstSeen || packet.timestamp < facts.firstSeen) facts.firstSeen = packet.timestamp
  }

  packets.forEach((packet, packetIndex) => {
    if (packet.messages.length === 0) return
    const facts = factsFor(packet.srcIp, packet.dstIp)
    facts.bgpSenders.add(packet.srcIp)
    if (facts.firstBgpIndex === undefined) facts.firstBgpIndex = packetIndex
  })

  return pairs
}

/**
 * Sessions that never got going, which the rest of this file cannot see.
 *
 * Every other rule here fires on something *present* in the capture — a
 * NOTIFICATION that arrived, a route that went away. These two fire on
 * something absent, which is how a fault at the far end appears when the
 * capture was taken on one router, and is why a capture of a session that
 * never came up used to be summarised as "every session looks healthy".
 */
function computeSessionSetupAlerts(
  packets: BgpPacket[],
  allPackets: GenericPacket[]
): DashboardAlert[] {
  const alerts: DashboardAlert[] = []

  for (const facts of collectPairFacts(packets, allPackets).values()) {
    const { ipA, ipB } = facts

    // Only one direction. Either the capture caught one leg, or the peer's
    // packets are not arriving — an outage, not a capture problem. Nothing in
    // the file distinguishes them, so the row must not claim to.
    if (facts.directions.size === 1) {
      const [only] = facts.directions
      const [from] = only.split('>')
      alerts.push({
        id: `one-direction-${sortedPairKey(ipA, ipB)}`,
        severity: 'critical',
        title: 'Only one direction of this session is in the capture',
        detail:
          `Every frame between ${ipA} and ${ipB} was sent by ${from}. Either the ` +
          `capture caught one direction only, or traffic from the other end is ` +
          `not arriving — a one-way link, a filter applied in one direction. ` +
          `Anything read off this session is half a conversation until you know which.`,
        timestamp: facts.firstSeen,
        filter: sessionFilter(ipA, ipB),
        pairKey: sortedPairKey(ipA, ipB),
        packetIndex: facts.firstBgpIndex,
      })
      // The rule below would fire too, and would be the less useful of the
      // two: with one direction missing, "the peer sent no BGP" is a
      // restatement rather than a finding.
      continue
    }

    // The connection came up and then one end said nothing. Worth stating
    // because of what it rules out: something accepted on port 179, so the
    // port is open, no ACL is dropping the SYN, and MD5 agrees — a one-sided
    // MD5 fails the handshake rather than surviving it.
    if (facts.accepted > 0 && facts.bgpSenders.size === 1) {
      const [speaker] = facts.bgpSenders
      const silent = speaker === ipA ? ipB : ipA
      alerts.push({
        id: `no-reply-${sortedPairKey(ipA, ipB)}`,
        severity: 'critical',
        title: `TCP connects but ${silent} sends no BGP`,
        detail:
          `${facts.accepted} connection(s) accepted on port 179 and ${speaker} sent ` +
          `BGP, but ${silent} sent none — no OPEN, no NOTIFICATION. The port is ` +
          `open and the handshake succeeded, so the fault is after TCP came up: ` +
          `the peer's BGP not willing to talk to this address, or the payload not ` +
          `surviving a path that carries the handshake (a TCP middlebox, a PMTU ` +
          `black hole, control-plane policing).`,
        timestamp: facts.firstSeen,
        filter: sessionFilter(ipA, ipB),
        pairKey: sortedPairKey(ipA, ipB),
        packetIndex: facts.firstBgpIndex,
        count: facts.accepted > 1 ? facts.accepted : undefined,
      })
    }
  }

  return alerts
}

/** How a connection ended, when nothing at the BGP layer accounted for it. */
type TeardownKind = 'RST' | 'FIN'

/**
 * One TCP connection's worth of frames, as delimited by the SYN that opened it.
 *
 * Not by the four-tuple: `s11-silent-teardown` and `s3-holdtimer-flap` each
 * hold three connections and exactly one four-tuple, because the source port is
 * reused — as it is in any real capture taken over a long enough window. Keyed
 * on the tuple, all three collapse into one "connection" that contains every
 * NOTIFICATION in the file, and the rule below would find every teardown
 * explained and stay silent on the very capture it exists for.
 */
/** An OPEN as this file cares about it: who sent it, when, and its GR terms. */
interface OpenOnConnection {
  src: string
  timestamp: Date
  packetIndex: number
  gracefulRestart?: GracefulRestartCapability
}

interface Connection {
  /**
   * Addresses that sent BGP on this connection. Both ends, or there was no
   * session here to tear down — see `computeSilentTeardownAlerts`.
   */
  bgpSenders: Set<string>
  sawNotification: boolean
  kind?: TeardownKind
  /** The RST or FIN frame itself, so `View →` can land on it. */
  endFrame?: GenericPacket
  endedAt?: Date
  /** The address that sent the bare SYN, i.e. the end that dialled. */
  initiator?: string
  opens: OpenOnConnection[]
  /** End-of-RIB markers, which is where a restarting speaker says it is done. */
  endOfRib: { src: string; timestamp: Date }[]
}

function newConnection(): Connection {
  return { bgpSenders: new Set(), sawNotification: false, opens: [], endOfRib: [] }
}

function splitIntoConnections(
  frames: GenericPacket[],
  bgpByFrame: Map<number, BgpPacket>,
  indexByFrame: Map<number, number>
): Connection[] {
  const connections: Connection[] = []
  let current: Connection | null = null

  for (const frame of frames) {
    // A bare SYN opens a connection; a SYN-ACK is the answer to one and must
    // not start a second, or every handshake would be split down the middle.
    if (frame.tcpFlags?.syn && !frame.tcpFlags.ack) {
      current = newConnection()
      current.initiator = frame.srcIp
      connections.push(current)
    }
    // Frames before the first SYN belong to a connection whose start the
    // capture missed. It is still a connection, and its teardown still counts.
    if (!current) {
      current = newConnection()
      connections.push(current)
    }

    const bgp = bgpByFrame.get(frame.frameIndex)
    if (bgp && bgp.messages.length > 0) {
      current.bgpSenders.add(frame.srcIp)
      if (bgp.messages.some((message) => message.type === 'NOTIFICATION')) {
        current.sawNotification = true
      }
      for (const message of bgp.messages) {
        if (message.type === 'OPEN') {
          const capability = (message as BgpOpenMessage).capabilities?.find(
            (entry) => entry.parsed?.type === 'GRACEFUL_RESTART'
          )
          current.opens.push({
            src: bgp.srcIp,
            timestamp: bgp.timestamp,
            packetIndex: indexByFrame.get(frame.frameIndex) ?? 0,
            gracefulRestart: capability?.parsed as GracefulRestartCapability | undefined,
          })
        }
        if (message.type === 'UPDATE' && endOfRibMarker(message as BgpUpdateMessage)) {
          current.endOfRib.push({ src: bgp.srcIp, timestamp: bgp.timestamp })
        }
      }
    }

    // RST outranks FIN: a connection that was closing politely and then got
    // reset ended by the reset, and the reset is the more urgent half to show.
    if (frame.tcpFlags?.rst && current.kind !== 'RST') {
      current.kind = 'RST'
      current.endFrame = frame
      current.endedAt = frame.timestamp
    } else if (frame.tcpFlags?.fin && current.kind === undefined) {
      // Only the first FIN. A graceful close has one from each end, which is
      // one teardown rather than two.
      current.kind = 'FIN'
      current.endFrame = frame
      current.endedAt = frame.timestamp
    }
  }

  return connections
}

/**
 * A session that went down with nothing at the BGP layer recording it.
 *
 * A BGP speaker that meant to go away sends a Cease first, so a connection that
 * carried BGP and then ended in RST or FIN with no NOTIFICATION on it is a
 * teardown nobody explained — a middlebox, an idle timeout, a stack out of
 * sockets. The evidence is already in the capture as an `[AR]` or an `[F]`, but
 * only under **All Packets**, which is why these rows carry the reader there.
 *
 * Both shapes count. A firewall closes an idle session with FIN as readily as
 * it resets it, and treating only RST as suspicious would miss half of
 * `s11-silent-teardown` — which holds one of each precisely so that a rule
 * looking for resets alone fails a test rather than shipping.
 */
/**
 * Every peering's connections, in order.
 *
 * Computed once and read by both the teardown rule and the graceful-restart
 * rule, which have to agree about what a connection is: the second explains
 * exactly the teardowns the first would otherwise report, and two different
 * ideas of where one connection ends and the next begins would leave rows
 * contradicting each other on the same capture.
 */
function connectionsByPeering(
  packets: BgpPacket[],
  allPackets: GenericPacket[]
): Map<string, Connection[]> {
  const bgpByFrame = new Map<number, BgpPacket>()
  const indexByFrame = new Map<number, number>()
  packets.forEach((packet, packetIndex) => {
    bgpByFrame.set(packet.frameIndex, packet)
    indexByFrame.set(packet.frameIndex, packetIndex)
  })

  const framesByPair = new Map<string, GenericPacket[]>()
  for (const frame of allPackets) {
    if (frame.protocol !== 'TCP') continue
    if (frame.srcPort !== 179 && frame.dstPort !== 179) continue
    const key = sortedPairKey(frame.srcIp, frame.dstIp)
    const frames = framesByPair.get(key)
    if (frames) frames.push(frame)
    else framesByPair.set(key, [frame])
  }

  const byPeering = new Map<string, Connection[]>()
  for (const [key, frames] of framesByPair) {
    byPeering.set(key, splitIntoConnections(frames, bgpByFrame, indexByFrame))
  }
  return byPeering
}

/**
 * A restart the two speakers had agreed how to survive.
 *
 * RFC 4724: a speaker advertises how long it expects to be away and, per address
 * family, whether it kept forwarding while it was. When both ends advertised the
 * capability and the session came back, the interesting number is not that it
 * flapped but how long the routes took to return.
 */
interface GracefulRestartEvent {
  /** The end that went away and dialled back in. */
  restarter: string
  /** Its own advertised Restart Time, in seconds. */
  restartTime: number
  /** Whether it claimed forwarding state survived, for any address family. */
  forwardingPreserved: boolean
  wentDownAt?: Date
  cameBackAt: Date
  /** Re-establishment to End-of-RIB, in seconds. Absent when unmeasurable. */
  convergenceSeconds?: number
  packetIndex: number
}

/** The GR capability an address sent on this connection, if it sent one. */
function gracefulRestartOf(connection: Connection, src: string): GracefulRestartCapability | undefined {
  return connection.opens.find((open) => open.src === src)?.gracefulRestart
}

/**
 * Restarts that both ends had agreed to ride out.
 *
 * A connection that ended without a NOTIFICATION, followed by one where both
 * ends re-OPEN advertising Graceful Restart, is a restart rather than a flap —
 * and which of the two it is decides whether anyone needs to be woken up. The
 * teardown itself is the same shape either way, which is why this reads the
 * same connection list as `computeSilentTeardownAlerts` and why that rule skips
 * what this one claims.
 */
function gracefulRestarts(connections: Connection[]): GracefulRestartEvent[] {
  const events: GracefulRestartEvent[] = []

  for (let index = 1; index < connections.length; index++) {
    const previous = connections[index - 1]
    const current = connections[index]

    // The session has to have gone down the way a restart takes it down: no
    // NOTIFICATION, because a speaker that sent a Cease was not restarting, it
    // was leaving. That is the same condition the teardown rule fires on, which
    // is what makes the two interlock exactly.
    if (!previous.kind || previous.sawNotification) continue
    if (previous.bgpSenders.size < 2 || current.bgpSenders.size < 2) continue

    // The end that went away: it dropped the connection, or — in a capture
    // taken from the other side, where its RST never appears — it is the one
    // that dialled back in.
    const restarter = previous.endFrame?.srcIp ?? current.initiator
    if (!restarter) continue

    // Both ends have to have advertised the capability. One end alone means
    // nobody agreed to hold the routes, so nothing was graceful about it.
    const theirs = gracefulRestartOf(current, restarter)
    const peer = [...current.bgpSenders].find((address) => address !== restarter)
    if (!theirs || !peer || !gracefulRestartOf(current, peer)) continue

    const opens = [...current.opens].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    // Both OPENs exchanged is the earliest point the capture can call the
    // session up again, so convergence is measured from there rather than from
    // whichever end spoke first.
    const established = opens[opens.length - 1]
    const endOfRib = current.endOfRib.find(
      (marker) => marker.src === restarter && marker.timestamp >= established.timestamp
    )

    events.push({
      restarter,
      restartTime: theirs.restartTime,
      // RFC 4724 §3: the per-family F bit is the speaker saying it kept
      // forwarding across the restart. Any family counts — the row says
      // whether traffic kept flowing, not for which AFI.
      forwardingPreserved: theirs.addressFamilies.some((family) => (family.flags & 0x80) !== 0),
      wentDownAt: previous.endedAt,
      cameBackAt: established.timestamp,
      convergenceSeconds: endOfRib
        ? (endOfRib.timestamp.getTime() - established.timestamp.getTime()) / 1000
        : undefined,
      packetIndex: established.packetIndex,
    })
  }

  return events
}

function computeSilentTeardownAlerts(byPeering: Map<string, Connection[]>): DashboardAlert[] {
  // Grouped by (peering, kind) and counted within, the same shape the
  // NOTIFICATION rule uses. A session dying every ten minutes for six hours is
  // at most two rows carrying their own counts, not thirty-six rows — and the
  // two kinds stay apart because they point somewhere different: an RST is
  // something actively rejecting the connection, a FIN something deciding it
  // was finished, which is what an idle timeout looks like.
  const alerts: DashboardAlert[] = []

  for (const [pairKey, connections] of byPeering) {
    const [ipA, ipB] = pairKey.split('|')

    // A graceful restart is a teardown with an explanation, so it is not this
    // rule's business — the same reasoning that keeps it quiet about a reset a
    // NOTIFICATION accounted for. Without this, `s8-graceful-restart` would
    // carry both a reset row pointing at firewalls and a restart row saying the
    // router came back with forwarding intact, which is the confusion S8 exists
    // to end rather than a second opinion worth having.
    const explained = new Set(
      gracefulRestarts(connections).map((event) => event.wentDownAt?.getTime())
    )

    const unexplained = connections.filter(
      (connection) =>
        connection.bgpSenders.size >= 2 &&
        connection.kind &&
        !connection.sawNotification &&
        !explained.has(connection.endedAt?.getTime())
    )

    for (const kind of ['RST', 'FIN'] as TeardownKind[]) {
      const matching = unexplained.filter((connection) => connection.kind === kind)
      if (matching.length === 0) continue

      const first = matching[0]
      const times = matching
        .map((connection) => connection.endedAt)
        .filter((at): at is Date => at !== undefined)
      const sender = first.endFrame ? first.endFrame.srcIp : ipA

      alerts.push({
        id: `silent-teardown-${kind}-${pairKey}`,
        severity: 'critical',
        title:
          kind === 'RST'
            ? `${ipA} ↔ ${ipB} was reset with no NOTIFICATION`
            : `${ipA} ↔ ${ipB} was closed with no NOTIFICATION`,
        detail:
          kind === 'RST'
            ? `A connection carrying BGP ended when ${sender} sent an RST, and no ` +
              `NOTIFICATION was exchanged on it. A speaker shutting the session ` +
              `down would have sent a Cease first, so the reset came from ` +
              `somewhere else — a firewall or load balancer dropping the flow, a ` +
              `stack that had no socket for it, an ACL applied mid-session. The ` +
              `frame is in the capture under All Packets.`
            : `A connection carrying BGP was closed with FIN by ${sender}, and no ` +
              `NOTIFICATION was exchanged on it. BGP does not end a session that ` +
              `way — a speaker going down sends a Cease — so something in the ` +
              `path decided the connection was finished, which is what an idle ` +
              `timeout on a firewall or NAT looks like. The frame is in the ` +
              `capture under All Packets.`,
        timestamp: times[0] ?? null,
        filter: sessionFilter(ipA, ipB),
        pairKey,
        frameIndex: first.endFrame?.frameIndex,
        showAllPackets: true,
        count: matching.length > 1 ? matching.length : undefined,
        timeSpan:
          matching.length > 1 && times.length > 1
            ? { start: times[0], end: times[times.length - 1] }
            : undefined,
      })
    }
  }

  return alerts
}

/** `1.5` rather than `1.5000000000000002`, and `3` rather than `3.0`. */
function seconds(value: number): string {
  return `${Math.round(value * 10) / 10}s`
}

/**
 * A restart both ends had agreed to ride out, reported as that rather than as a
 * flap.
 *
 * The operational meanings are opposite — a graceful restart kept forwarding
 * while the control plane came back, a crash loop did not — and until this rule
 * existed the dashboard said "Session flapping detected" for both. The numbers
 * that separate them are all in the capture: the capability says how long the
 * speaker expected to be away and whether it kept forwarding, and the gap
 * between re-establishment and End-of-RIB says how long it actually took.
 */
function computeGracefulRestartAlerts(byPeering: Map<string, Connection[]>): DashboardAlert[] {
  const alerts: DashboardAlert[] = []

  for (const [pairKey, connections] of byPeering) {
    const [ipA, ipB] = pairKey.split('|')
    const events = gracefulRestarts(connections)
    if (events.length === 0) continue

    const first = events[0]
    const slow = events.filter(
      (event) => event.convergenceSeconds !== undefined && event.convergenceSeconds > event.restartTime
    )
    const withoutForwarding = events.filter((event) => !event.forwardingPreserved)

    // Benign by default: a restart that stayed inside its own Restart Time with
    // forwarding preserved is the mechanism working, and shouting about it
    // would be the same mistake in the other direction. It becomes critical
    // when one of the two promises was not kept.
    const severity: DashboardAlert['severity'] =
      slow.length > 0 || withoutForwarding.length > 0 ? 'critical' : 'warning'

    const convergence =
      first.convergenceSeconds !== undefined
        ? `Routes were back ${seconds(first.convergenceSeconds)} after the session came up, ` +
          `against the ${first.restartTime}s ${first.restarter} asked for.`
        : `The capture holds no End-of-RIB from ${first.restarter} after it came back, so how ` +
          `long convergence took cannot be measured here — only that the session returned.`

    const forwarding = first.forwardingPreserved
      ? `${first.restarter} advertised that it kept forwarding state across the restart, so ` +
        `traffic should have continued while BGP caught up.`
      : `${first.restarter} did not advertise preserved forwarding state, so its dataplane ` +
        `most likely dropped traffic for the whole of that window — which is the part a ` +
        `graceful restart is supposed to avoid.`

    const overran =
      slow.length > 0
        ? ` Convergence ran past the Restart Time, so the peer will have given up holding the ` +
          `routes and withdrawn them before they came back.`
        : ''

    alerts.push({
      id: `graceful-restart-${pairKey}`,
      severity,
      // Names the end that went away and the one that held its routes, rather
      // than repeating the restarter inside a peering string that contains it.
      title: `${first.restarter} restarted gracefully, peer ${first.restarter === ipA ? ipB : ipA}`,
      detail:
        `The session went down with nothing at the BGP layer announcing it and came back with ` +
        `both ends re-advertising Graceful Restart, which is a restart rather than a flap. ` +
        `${convergence} ${forwarding}${overran}`,
      timestamp: first.cameBackAt,
      filter: sessionFilter(ipA, ipB),
      pairKey,
      packetIndex: first.packetIndex,
      count: events.length > 1 ? events.length : undefined,
      timeSpan:
        events.length > 1
          ? { start: first.cameBackAt, end: events[events.length - 1].cameBackAt }
          : undefined,
    })
  }

  return alerts
}

/**
 * `allPackets` is optional so the many tests that only care about BGP-level
 * rules can keep passing packets alone; the establishment rules simply find
 * nothing without it.
 */
export function computeAlerts(
  packets: BgpPacket[],
  allPackets: GenericPacket[] = []
): DashboardAlert[] {
  const alerts: DashboardAlert[] = []
  const byPeering = connectionsByPeering(packets, allPackets)

  alerts.push(...computeSessionSetupAlerts(packets, allPackets))
  alerts.push(...computeSilentTeardownAlerts(byPeering))
  alerts.push(...computeGracefulRestartAlerts(byPeering))

  // 1. NOTIFICATIONs, one row per repeated fault rather than per packet.
  alerts.push(...groupNotifications(packets))

  // 2. Flapping sessions: repeated OPEN exchanges between the same peer pair.
  const opensByPair = new Map<string, { timestamp: Date; packetIndex: number }[]>()
  packets.forEach((packet, packetIndex) => {
    for (const msg of packet.messages) {
      if (msg.type !== 'OPEN') continue
      const key = sortedPairKey(packet.srcIp, packet.dstIp)
      if (!opensByPair.has(key)) opensByPair.set(key, [])
      opensByPair.get(key)!.push({ timestamp: packet.timestamp, packetIndex })
    }
  })
  for (const [key, opens] of opensByPair) {
    if (opens.length < FLAP_OPEN_THRESHOLD) continue

    // "Session flapping detected" is the wrong headline for a peering whose
    // every re-establishment was a graceful restart: the row above already
    // says the session came back, and says whether forwarding survived, which
    // is the question. It carries its own count, so a router restarting thirty
    // times is still visible as thirty — the signal moves rather than being
    // suppressed.
    const restarts = gracefulRestarts(byPeering.get(key) ?? [])
    if (restarts.length > 0 && restarts.length >= Math.floor(opens.length / 2) - 1) continue

    const [ipA, ipB] = key.split('|')
    const establishments = Math.floor(opens.length / 2)
    alerts.push({
      id: `flap-${key}`,
      severity: 'warning',
      title: 'Session flapping detected',
      detail: `${ipA} ↔ ${ipB} — ${opens.length} OPEN messages (~${establishments} establishments)`,
      timestamp: opens[opens.length - 1].timestamp,
      filter: sessionFilter(ipA, ipB),
      packetIndex: opens[0].packetIndex,
    })
  }

  // 3. Bursts of withdrawn prefixes within a short time window.
  const withdrawEvents: { timestamp: Date; count: number; packetIndex: number }[] = []
  packets.forEach((packet, packetIndex) => {
    for (const msg of packet.messages) {
      if (msg.type !== 'UPDATE') continue
      const count = getWithdrawnCount(msg as BgpUpdateMessage)
      if (count > 0) withdrawEvents.push({ timestamp: packet.timestamp, count, packetIndex })
    }
  })
  withdrawEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

  let cursor = 0
  while (cursor < withdrawEvents.length) {
    const windowStartTime = withdrawEvents[cursor].timestamp.getTime()
    let windowEnd = cursor
    let windowTotal = 0
    while (
      windowEnd < withdrawEvents.length &&
      withdrawEvents[windowEnd].timestamp.getTime() - windowStartTime <= WITHDRAWN_BURST_WINDOW_MS
    ) {
      windowTotal += withdrawEvents[windowEnd].count
      windowEnd++
    }
    if (windowTotal >= WITHDRAWN_BURST_THRESHOLD) {
      alerts.push({
        id: `withdraw-burst-${cursor}`,
        severity: 'warning',
        title: 'Burst of withdrawn prefixes',
        detail: `${windowTotal} prefixes withdrawn within ${WITHDRAWN_BURST_WINDOW_MS / 1000}s`,
        timestamp: withdrawEvents[cursor].timestamp,
        filter: 'type=UPDATE',
        packetIndex: withdrawEvents[cursor].packetIndex,
      })
      cursor = windowEnd // move past this burst instead of re-triggering on overlapping windows
    } else {
      cursor++
    }
  }

  // 4. Route-level findings. aggregatePrefixStats walks every packet, so it is
  // called once here and both route rules read the same result.
  alerts.push(...computeRouteAlerts(aggregatePrefixStats(packets)))

  // Most severe first, then the rows standing for the most occurrences, then
  // most recent first. Counting before recency keeps a peer that failed 40
  // times above one that failed once a second later.
  const severityRank: Record<DashboardAlert['severity'], number> = { critical: 0, warning: 1 }
  return alerts.sort((a, b) => {
    if (severityRank[a.severity] !== severityRank[b.severity]) {
      return severityRank[a.severity] - severityRank[b.severity]
    }
    if ((a.count ?? 1) !== (b.count ?? 1)) return (b.count ?? 1) - (a.count ?? 1)
    return (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0)
  })
}

/**
 * When a capture holds no BGP at all, the interesting question is *why* — and
 * the answer is usually visible at the TCP layer. A capture of SYNs answered
 * by RSTs is a session failing to establish (filter, MD5/TCP-AO mismatch,
 * BGP not running), and presenting that as "no issues detected" sends the
 * engineer away from the evidence.
 */
export function computeTransportAlerts(allPackets: GenericPacket[]): DashboardAlert[] {
  const port179 = allPackets.filter(
    (p) => p.protocol === 'TCP' && (p.srcPort === 179 || p.dstPort === 179)
  )

  if (port179.length === 0) {
    const tcpCount = allPackets.filter((p) => p.protocol === 'TCP').length
    return [
      {
        id: 'transport-no-179',
        severity: 'warning',
        title: 'No BGP messages and no TCP port 179 traffic',
        detail:
          tcpCount > 0
            ? `${tcpCount} TCP packets on other ports — non-standard-port sessions are decoded only when BGP message markers are visible in the flow`
            : 'The capture contains no TCP traffic',
        timestamp: allPackets[0]?.timestamp ?? null,
        filter: '',
      },
    ]
  }

  const syns = port179.filter((p) => p.dstPort === 179 && p.tcpFlags?.syn && !p.tcpFlags?.ack)
  const synAcks = port179.filter((p) => p.srcPort === 179 && p.tcpFlags?.syn && p.tcpFlags?.ack)
  const rsts = port179.filter((p) => p.srcPort === 179 && p.tcpFlags?.rst)
  const withPayload = port179.filter((p) => p.payloadLength > 0)

  if (withPayload.length === 0 && syns.length > 0 && rsts.length > 0) {
    return [
      {
        id: 'transport-refused',
        severity: 'critical',
        title: 'TCP connections to port 179 are being refused',
        detail: `${syns.length} SYNs answered by RST — the session never reaches BGP. Check ACLs/filters, MD5 (TCP-AO) configuration, or whether BGP is running on the peer`,
        timestamp: syns[0].timestamp,
        filter: '',
      },
    ]
  }

  if (withPayload.length === 0 && syns.length > 0 && synAcks.length === 0) {
    return [
      {
        id: 'transport-unanswered',
        severity: 'critical',
        title: 'TCP SYNs to port 179 go unanswered',
        detail: `${syns.length} SYNs with no SYN-ACK — traffic filtered in transit or the peer is unreachable`,
        timestamp: syns[0].timestamp,
        filter: '',
      },
    ]
  }

  return [
    {
      id: 'transport-no-bgp-payload',
      severity: 'warning',
      title: 'TCP port 179 traffic carries no decodable BGP',
      detail: `${port179.length} packets on port 179 but no BGP messages could be decoded`,
      timestamp: port179[0].timestamp,
      filter: '',
    },
  ]
}
