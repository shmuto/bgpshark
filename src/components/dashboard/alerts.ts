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
  BgpUpdateMessage,
  MpUnreachNlriAttribute,
} from '../../lib/bgp/types'
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

  alerts.push(...computeSessionSetupAlerts(packets, allPackets))

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
