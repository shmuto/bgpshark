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
import { peeringKey } from '../../lib/bgp/peering'
import type { GenericPacket } from '../../lib/pcap'
import { prefixStatsFor, prefixStatsForAsync, type PrefixEvent, type PrefixStats } from '../../lib/bgp/prefix-stats'
import { pauseAt, runInSlices, runToEnd, type Sliced } from '../../lib/sliced'
import type { DashboardAlert } from './types'
import { formatAsPath } from '../../lib/bgp/as-path-display'
import { getMessages, type Locale } from '../../i18n/locale'

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

const sortedPairKey = peeringKey

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

/**
 * Cease / Connection Collision Resolution (RFC 4271 §6.8): when both ends
 * connect at once, one of the two connections is closed with this code. It is
 * how BGP is meant to resolve the race, so it is reported — it does mean two
 * connections were opened — but not as a failure, and never above the
 * NOTIFICATION that actually brought the session down.
 */
function isRoutineNotification(notif: BgpNotificationMessage): boolean {
  return notif.errorCode === 6 && notif.errorSubcode === 7
}

interface NotificationGroup {
  title: string
  routine: boolean
  errorCode: number
  errorSubcode: number
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
function* groupNotifications(packets: BgpPacket[], locale: Locale): Sliced<DashboardAlert[]> {
  const t = getMessages(locale).alerts
  const groups = new Map<string, NotificationGroup>()

  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    if (pauseAt(packetIndex)) yield
    const packet = packets[packetIndex]
    for (const msg of packet.messages) {
      if (msg.type !== 'NOTIFICATION') continue
      const notif = msg as BgpNotificationMessage
      const key = `${packet.srcIp}|${packet.dstIp}|${notif.errorCode}|${notif.errorSubcode}`
      const group = groups.get(key)
      if (!group) {
        groups.set(key, {
          title: t.notifTitle(notif.errorCodeName, notif.errorSubcodeName),
          routine: isRoutineNotification(notif),
          errorCode: notif.errorCode,
          errorSubcode: notif.errorSubcode,
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
  }

  return Array.from(groups.values()).map((group) => ({
    id: `notif-${group.firstPacketIndex}`,
    rule: 'notification' as const,
    groupKey: `notification-${group.errorCode}-${group.errorSubcode}`,
    peering: sortedPairKey(group.srcIp, group.dstIp),
    severity: group.routine ? ('info' as const) : ('critical' as const),
    title: group.title,
    detail: group.routine
      ? t.notifCollisionDetail(group.srcIp, group.dstIp)
      : `${group.srcIp} → ${group.dstIp}`,
    timestamp: group.first,
    filter: sessionFilter(group.srcIp, group.dstIp),
    packetIndex: group.firstPacketIndex,
    count: group.count,
    timeSpan: group.count > 1 ? { start: group.first, end: group.last } : undefined,
  }))
}

interface PathChange {
  /** The peer whose path changed. */
  source: string
  pathId?: number
  /** Distinct AS_PATHs that peer announced, in the order they first appeared. */
  paths: string[]
}

/**
 * The peer (and ADD-PATH path) whose AS_PATH for a route changed the most.
 *
 * Paths are only compared within one peer's announcements. Two peers sending
 * different paths for the same prefix is ordinary — an iBGP peer's empty
 * AS_PATH next to an eBGP peer's `65001` is the textbook case — and comparing
 * across them reported "(no AS_PATH) → 65001" on every capture with both kinds
 * of session. ADD-PATH Path Identifiers are kept apart for the same reason:
 * several paths from one peer is what ADD-PATH is for.
 */
function* asPathChange(stat: PrefixStats): Sliced<PathChange | null> {
  // Read off the history's columns rather than its events: this runs over
  // every announcement in the capture.
  const history = stat.history

  // Nearly every route is announced by one peer with one path, or by several
  // that each keep to theirs. Settle the commonest case — every announcement
  // the same peer, path and AS_PATH — without building a key per event. The
  // decoder shares AS_PATH text between repeats, so the comparison is almost
  // always of one string with itself.
  let firstAt = -1
  let mixed = false
  for (let index = 0; index < history.length; index++) {
    if (pauseAt(index)) yield
    const asPath = history.asPath(index)
    if (asPath === undefined) continue
    if (firstAt < 0) {
      firstAt = index
      continue
    }
    if (
      asPath !== history.asPath(firstAt) ||
      history.source(index) !== history.source(firstAt) ||
      history.pathId(index) !== history.pathId(firstAt)
    ) {
      mixed = true
      break
    }
  }
  if (!mixed) return null

  const bySource = new Map<string, PathChange>()
  for (let index = firstAt; index < history.length; index++) {
    if (pauseAt(index)) yield
    const asPath = history.asPath(index)
    if (asPath === undefined) continue
    const source = history.source(index)
    const pathId = history.pathId(index)
    // An address never contains `|`, so the bare address cannot collide with
    // an address-and-path-identifier key.
    const key = pathId === undefined ? source : `${source}|${pathId}`
    let entry = bySource.get(key)
    if (!entry) {
      entry = { source, pathId, paths: [] }
      bySource.set(key, entry)
    }
    if (!entry.paths.includes(asPath)) entry.paths.push(asPath)
  }

  let worst: PathChange | null = null
  for (const entry of bySource.values()) {
    if (entry.paths.length > 1 && (!worst || entry.paths.length > worst.paths.length)) worst = entry
  }
  return worst
}

function describeAsPath(path: string, locale: Locale): string {
  // Collapsed the same way the routes screen shows it, so a prepend reads as a
  // count in both places rather than as a wall of the same AS number.
  return path === '' ? getMessages(locale).alerts.noAsPath : formatAsPath(path)
}

/**
 * The first `limit` of the items offered, in `compare` order — what sorting
 * them all and keeping the head would give, ties in the order offered — and
 * how many were offered.
 *
 * The route rules list five routes and sum up the rest, and they used to sort
 * every candidate to find the five. On a table transfer nearly every route is
 * a candidate: a million routes that flapped, a million whose path changed,
 * each sorted in one go, which held the page for over a second apiece once
 * the rest of the findings had been sliced. Keeping the leaders as the routes
 * go by is a comparison or two per route, and the loop can pause.
 */
class Leaders<T> {
  readonly top: T[] = []
  count = 0

  constructor(
    private readonly limit: number,
    private readonly compare: (a: T, b: T) => number
  ) {}

  offer(item: T): void {
    this.count++
    const top = this.top
    // Offered last, so it goes after everything it ties with.
    if (top.length === this.limit && this.compare(item, top[top.length - 1]) >= 0) return
    let at = top.length
    while (at > 0 && this.compare(item, top[at - 1]) < 0) at--
    top.splice(at, 0, item)
    if (top.length > this.limit) top.pop()
  }
}

/**
 * Routes moving while every session stays up — the case the panel used to call
 * "no issues detected" at someone who came in looking for a missing route.
 *
 * Warnings, not criticals: nothing here means a session is broken.
 */
function* computeRouteAlerts(stats: PrefixStats[], locale: Locale): Sliced<DashboardAlert[]> {
  const t = getMessages(locale).alerts
  const alerts: DashboardAlert[] = []

  // A route that went away at least once. `flap` is already counted per
  // (route, announcing peer) by aggregatePrefixStats, so a widely announced
  // stable route does not score here.
  const flapping = new Leaders<PrefixStats>(
    ROUTE_ALERT_LIMIT,
    (a, b) => b.flap - a.flap || b.lastSeenMs - a.lastSeenMs
  )
  let flaps = 0
  for (let index = 0; index < stats.length; index++) {
    if (pauseAt(index)) yield
    const stat = stats[index]
    if (stat.flap < 1) continue
    flaps += stat.flap
    flapping.offer(stat)
  }

  for (const stat of flapping.top) {
    const history = stat.history.events()
    const withdraws = history.filter((event) => event.action === 'withdraw')
    // flap >= 1 guarantees a withdraw; the fallback only keeps the types honest.
    const first = withdraws[0] ?? history[0]
    const last = withdraws[withdraws.length - 1] ?? first
    alerts.push({
      id: `route-flap-${stat.key}`,
      rule: 'route-flap',
      severity: 'warning',
      title: t.routeFlappingTitle(stat.key),
      detail: t.routeFlappingDetail(stat.announced, stat.withdrawn),
      timestamp: first.timestamp,
      filter: `prefix = ${stat.key}`,
      packetIndex: first.packetIndex,
      count: stat.flap,
      timeSpan: stat.flap > 1 ? { start: first.timestamp, end: last.timestamp } : undefined,
    })
  }

  if (flapping.count > ROUTE_ALERT_LIMIT) {
    const restFlaps = flaps - flapping.top.reduce((sum, stat) => sum + stat.flap, 0)
    alerts.push({
      id: 'route-flap-more',
      rule: 'route-flap',
      severity: 'warning',
      title: t.morePrefixesFlappedTitle(flapping.count - ROUTE_ALERT_LIMIT),
      detail: t.morePrefixesFlappedDetail(restFlaps),
      timestamp: null,
      filter: 'type=UPDATE',
      // The rows above count their flaps, so this one counts the rest's:
      // the group's total is then every flap, not the listed ones plus one.
      count: restFlaps,
    })
  }

  // More than one AS_PATH for the same route: a reroute, a prepend change, or
  // a leak. Which of those it is only the AS numbers can say, so the row shows
  // the first path and the latest one.
  const repathed = new Leaders<{ stat: PrefixStats; change: PathChange }>(
    ROUTE_ALERT_LIMIT,
    (a, b) => b.change.paths.length - a.change.paths.length || b.stat.lastSeenMs - a.stat.lastSeenMs
  )
  let repaths = 0
  for (let index = 0; index < stats.length; index++) {
    if (pauseAt(index)) yield
    const stat = stats[index]
    const change = yield* asPathChange(stat)
    if (change === null) continue
    repaths += change.paths.length
    repathed.offer({ stat, change })
  }

  for (const { stat, change: { source, pathId, paths } } of repathed.top) {
    // The packet worth opening is the one where that peer's path first
    // differed, not the original announcement.
    const history = stat.history.events()
    const change =
      history.find(
        (event) =>
          event.action === 'announce' &&
          event.source === source &&
          event.pathId === pathId &&
          event.asPath !== undefined &&
          event.asPath !== paths[0]
      ) ?? history[0]
    const from = pathId !== undefined ? t.asPathFromPath(source, pathId) : source
    alerts.push({
      id: `route-aspath-${stat.key}`,
      rule: 'route-aspath',
      severity: 'warning',
      title: t.asPathChangedTitle(stat.key),
      detail: t.asPathChangedDetail(
        from,
        describeAsPath(paths[0], locale),
        describeAsPath(paths[paths.length - 1], locale)
      ),
      timestamp: change.timestamp,
      filter: `prefix = ${stat.key}`,
      packetIndex: change.packetIndex,
      count: paths.length,
    })
  }

  // An EVPN MAC/IP route announced by one VTEP and then by another is a host
  // moving. Comparing AS_PATHs only within a peer (above) no longer sees that,
  // and "AS_PATH changed" was never the right name for it anyway: the fact
  // worth a row is which leaf the MAC was behind, and which it is behind now.
  const moved: { stat: PrefixStats; announcements: PrefixEvent[]; moves: PrefixEvent[] }[] = []
  for (let index = 0; index < stats.length; index++) {
    if (pauseAt(index)) yield
    const stat = stats[index]
    if (!stat.key.startsWith('[2] ')) continue
    const announcements = stat.history.events().filter((event) => event.action === 'announce')
    const moves = announcements.filter((event, i) => i > 0 && event.source !== announcements[i - 1].source)
    if (moves.length > 0) moved.push({ stat, announcements, moves })
  }
  moved.sort((a, b) => b.moves.length - a.moves.length || b.stat.lastSeenMs - a.stat.lastSeenMs)

  for (const { stat, announcements, moves } of moved.slice(0, ROUTE_ALERT_LIMIT)) {
    const last = moves[moves.length - 1]
    const mac = stat.key.match(/[0-9a-f]{2}(?::[0-9a-f]{2}){5}/i)?.[0]
    alerts.push({
      id: `route-macmove-${stat.key}`,
      rule: 'route-macmove',
      severity: 'warning',
      title: t.macMovedTitle(stat.key),
      detail: `${announcements[0].source} → ${last.source}`,
      timestamp: moves[0].timestamp,
      filter: mac ? `mac = ${mac}` : `prefix = ${stat.key}`,
      packetIndex: moves[0].packetIndex,
      count: moves.length,
    })
  }

  if (repathed.count > ROUTE_ALERT_LIMIT) {
    alerts.push({
      id: 'route-aspath-more',
      rule: 'route-aspath',
      severity: 'warning',
      title: t.moreAsPathChangedTitle(repathed.count - ROUTE_ALERT_LIMIT),
      detail: t.moreAsPathChangedDetail,
      timestamp: null,
      filter: 'type=UPDATE',
      // Counted like the rows above (paths seen per route), for the same
      // reason as the flap summary.
      count: repaths - repathed.top.reduce((sum, { change }) => sum + change.paths.length, 0),
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

function* collectPairFacts(
  packets: BgpPacket[],
  allPackets: GenericPacket[]
): Sliced<Map<string, PairFacts>> {
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

  for (let frameIndex = 0; frameIndex < allPackets.length; frameIndex++) {
    if (pauseAt(frameIndex)) yield
    const packet = allPackets[frameIndex]
    if (packet.protocol !== 'TCP') continue
    if (packet.srcPort !== 179 && packet.dstPort !== 179) continue

    const facts = factsFor(packet.srcIp, packet.dstIp)
    facts.directions.add(`${packet.srcIp}>${packet.dstIp}`)
    // A SYN-ACK is the far end saying "something is listening here". It is the
    // fact that separates "nothing answers" from "answered, then said nothing".
    if (packet.tcpFlags?.syn && packet.tcpFlags.ack) facts.accepted++
    if (!facts.firstSeen || packet.timestamp < facts.firstSeen) facts.firstSeen = packet.timestamp
  }

  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    if (pauseAt(packetIndex)) yield
    const packet = packets[packetIndex]
    if (packet.messages.length === 0) continue
    const facts = factsFor(packet.srcIp, packet.dstIp)
    facts.bgpSenders.add(packet.srcIp)
    if (facts.firstBgpIndex === undefined) facts.firstBgpIndex = packetIndex
  }

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
function* computeSessionSetupAlerts(
  packets: BgpPacket[],
  allPackets: GenericPacket[],
  locale: Locale
): Sliced<DashboardAlert[]> {
  const t = getMessages(locale).alerts
  const alerts: DashboardAlert[] = []

  for (const facts of (yield* collectPairFacts(packets, allPackets)).values()) {
    const { ipA, ipB } = facts

    // Only one direction. Either the capture caught one leg, or the peer's
    // packets are not arriving — an outage, not a capture problem. Nothing in
    // the file distinguishes them, so the row must not claim to.
    if (facts.directions.size === 1) {
      const [only] = facts.directions
      const [from] = only.split('>')
      alerts.push({
        id: `one-direction-${sortedPairKey(ipA, ipB)}`,
        rule: 'one-direction',
        peering: sortedPairKey(ipA, ipB),
        severity: 'critical',
        title: t.oneDirectionTitle,
        detail: t.oneDirectionDetail(ipA, ipB, from),
        timestamp: facts.firstSeen,
        filter: sessionFilter(ipA, ipB),
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
        rule: 'no-reply',
        peering: sortedPairKey(ipA, ipB),
        severity: 'critical',
        title: t.noReplyTitle(silent),
        detail: t.noReplyDetail(facts.accepted, speaker, silent),
        timestamp: facts.firstSeen,
        filter: sessionFilter(ipA, ipB),
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

function* splitIntoConnections(
  frames: GenericPacket[],
  bgpByFrame: Map<number, BgpPacket>,
  indexByFrame: Map<number, number>
): Sliced<Connection[]> {
  const connections: Connection[] = []
  let current: Connection | null = null

  for (let index = 0; index < frames.length; index++) {
    if (pauseAt(index)) yield
    const frame = frames[index]
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
function* connectionsByPeering(
  packets: BgpPacket[],
  allPackets: GenericPacket[]
): Sliced<Map<string, Connection[]>> {
  const bgpByFrame = new Map<number, BgpPacket>()
  const indexByFrame = new Map<number, number>()
  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    if (pauseAt(packetIndex)) yield
    const packet = packets[packetIndex]
    bgpByFrame.set(packet.frameIndex, packet)
    indexByFrame.set(packet.frameIndex, packetIndex)
  }

  const framesByPair = new Map<string, GenericPacket[]>()
  for (let index = 0; index < allPackets.length; index++) {
    if (pauseAt(index)) yield
    const frame = allPackets[index]
    if (frame.protocol !== 'TCP') continue
    if (frame.srcPort !== 179 && frame.dstPort !== 179) continue
    const key = sortedPairKey(frame.srcIp, frame.dstIp)
    const frames = framesByPair.get(key)
    if (frames) frames.push(frame)
    else framesByPair.set(key, [frame])
  }

  const byPeering = new Map<string, Connection[]>()
  for (const [key, frames] of framesByPair) {
    byPeering.set(key, yield* splitIntoConnections(frames, bgpByFrame, indexByFrame))
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

function computeSilentTeardownAlerts(
  byPeering: Map<string, Connection[]>,
  locale: Locale
): DashboardAlert[] {
  const t = getMessages(locale).alerts
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
        rule: 'silent-teardown',
        groupKey: `silent-teardown-${kind}`,
        peering: pairKey,
        severity: 'critical',
        title:
          kind === 'RST'
            ? t.silentResetTitle(ipA, ipB)
            : t.silentCloseTitle(ipA, ipB),
        detail:
          kind === 'RST'
            ? t.silentResetDetail(sender)
            : t.silentCloseDetail(sender),
        timestamp: times[0] ?? null,
        filter: sessionFilter(ipA, ipB),
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
function computeGracefulRestartAlerts(
  byPeering: Map<string, Connection[]>,
  locale: Locale
): DashboardAlert[] {
  const t = getMessages(locale).alerts
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
        ? t.grConvergenceMeasured(seconds(first.convergenceSeconds), first.restartTime, first.restarter)
        : t.grConvergenceUnknown(first.restarter)

    const forwarding = first.forwardingPreserved
      ? t.grForwardingPreserved(first.restarter)
      : t.grForwardingNotPreserved(first.restarter)

    const overran = slow.length > 0 ? t.grOverran : ''

    alerts.push({
      id: `graceful-restart-${pairKey}`,
      rule: 'graceful-restart',
      peering: pairKey,
      severity,
      // Names the end that went away and the one that held its routes, rather
      // than repeating the restarter inside a peering string that contains it.
      title: t.grTitle(first.restarter, first.restarter === ipA ? ipB : ipA),
      detail: t.grDetail(convergence, forwarding, overran),
      timestamp: first.cameBackAt,
      filter: sessionFilter(ipA, ipB),
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
  allPackets: GenericPacket[] = [],
  locale: Locale = 'en'
): DashboardAlert[] {
  return runToEnd(alertsWork(packets, allPackets, locale))
}

/** `computeAlerts`, as work that pauses; see `src/lib/sliced.ts`. */
function* alertsWork(
  packets: BgpPacket[],
  allPackets: GenericPacket[],
  locale: Locale
): Sliced<DashboardAlert[]> {
  const t = getMessages(locale).alerts
  const alerts: DashboardAlert[] = []
  const byPeering = yield* connectionsByPeering(packets, allPackets)

  alerts.push(...(yield* computeSessionSetupAlerts(packets, allPackets, locale)))
  alerts.push(...computeSilentTeardownAlerts(byPeering, locale))
  alerts.push(...computeGracefulRestartAlerts(byPeering, locale))

  // 1. NOTIFICATIONs, one row per repeated fault rather than per packet.
  alerts.push(...(yield* groupNotifications(packets, locale)))

  // 2. Flapping sessions: repeated OPEN exchanges between the same peer pair.
  const opensByPair = new Map<string, { timestamp: Date; packetIndex: number }[]>()
  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    if (pauseAt(packetIndex)) yield
    const packet = packets[packetIndex]
    for (const msg of packet.messages) {
      if (msg.type !== 'OPEN') continue
      const key = sortedPairKey(packet.srcIp, packet.dstIp)
      if (!opensByPair.has(key)) opensByPair.set(key, [])
      opensByPair.get(key)!.push({ timestamp: packet.timestamp, packetIndex })
    }
  }
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
      rule: 'session-flap',
      peering: key,
      severity: 'warning',
      title: t.sessionFlapTitle,
      detail: t.sessionFlapDetail(ipA, ipB, opens.length, establishments),
      timestamp: opens[opens.length - 1].timestamp,
      filter: sessionFilter(ipA, ipB),
      packetIndex: opens[0].packetIndex,
    })
  }

  // 3–4. Withdrawal bursts and route-level findings, which no one session owns.
  alerts.push(...(yield* computeCaptureWideAlerts(packets, locale)))

  return sortAlerts(alerts)
}

/**
 * Most severe first, then the rows standing for the most occurrences, then
 * most recent first. Counting before recency keeps a peer that failed 40
 * times above one that failed once a second later. The "N more prefixes"
 * summaries come after the routes they follow on from: their count adds up
 * dozens of routes, and ranked by it they led the list they close.
 */
function sortAlerts(alerts: DashboardAlert[]): DashboardAlert[] {
  const severityRank: Record<DashboardAlert['severity'], number> = { critical: 0, warning: 1, info: 2 }
  const isSummary = (alert: DashboardAlert) => alert.id.endsWith('-more')
  return alerts.sort((a, b) => {
    if (severityRank[a.severity] !== severityRank[b.severity]) {
      return severityRank[a.severity] - severityRank[b.severity]
    }
    if (isSummary(a) !== isSummary(b)) return isSummary(a) ? 1 : -1
    if ((a.count ?? 1) !== (b.count ?? 1)) return (b.count ?? 1) - (a.count ?? 1)
    return (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0)
  })
}

/** Rules whose findings belong to no one session; see `computeCaptureWideAlerts`. */
const CAPTURE_WIDE_RULES = new Set<DashboardAlert['rule']>([
  'withdraw-burst',
  'route-flap',
  'route-aspath',
  'route-macmove',
])

/**
 * Findings about routes rather than sessions: withdrawal bursts, flapping
 * routes, AS_PATH changes and MAC moves. They carry no `peering`, so a session
 * scope cannot filter them; `scopeAlerts` reruns this over the session's own
 * packets instead.
 */
function* computeCaptureWideAlerts(packets: BgpPacket[], locale: Locale): Sliced<DashboardAlert[]> {
  const t = getMessages(locale).alerts
  const alerts: DashboardAlert[] = []

  // Bursts of withdrawn prefixes within a short time window.
  const withdrawEvents: { timestamp: Date; count: number; packetIndex: number }[] = []
  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    if (pauseAt(packetIndex)) yield
    const packet = packets[packetIndex]
    for (const msg of packet.messages) {
      if (msg.type !== 'UPDATE') continue
      const count = getWithdrawnCount(msg as BgpUpdateMessage)
      if (count > 0) withdrawEvents.push({ timestamp: packet.timestamp, count, packetIndex })
    }
  }
  withdrawEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

  let cursor = 0
  let windows = 0
  while (cursor < withdrawEvents.length) {
    if (pauseAt(windows++)) yield
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
        rule: 'withdraw-burst',
        severity: 'warning',
        title: t.withdrawBurstTitle,
        detail: t.withdrawBurstDetail(windowTotal, WITHDRAWN_BURST_WINDOW_MS / 1000),
        timestamp: withdrawEvents[cursor].timestamp,
        filter: 'type=UPDATE',
        packetIndex: withdrawEvents[cursor].packetIndex,
      })
      cursor = windowEnd // move past this burst instead of re-triggering on overlapping windows
    } else {
      cursor++
    }
  }

  // Route-level findings. aggregatePrefixStats walks every packet, so it is
  // called once here and both route rules read the same result — as does the
  // Routes screen, through the same cache.
  alerts.push(...(yield* computeRouteAlerts(prefixStatsFor(packets), locale)))

  return alerts
}

/**
 * The findings for one session.
 *
 * Session findings are those whose `peering` is the scope. Route findings
 * have no peering, and kept as they were they showed the whole capture's
 * counts — "Route flapping ×6" beside a session that flapped twice, the one
 * row in the column the scope did not narrow. They are recomputed over the
 * session's packets, with each `packetIndex` mapped back to the capture's
 * array so the row still opens the packet it names.
 *
 * Findings with no peering that are not route findings (the TCP-only rules a
 * capture without BGP raises) are kept as they are.
 */
export function scopeAlerts(
  alerts: DashboardAlert[],
  packets: BgpPacket[],
  scope: string | null,
  locale: Locale = 'en',
  /**
   * The scope's packets, in capture order, when the caller already holds them.
   * Route statistics are cached per packet array, so passing the array the
   * workspace keeps lets them be worked out once — and ahead of time.
   */
  scopePackets?: BgpPacket[]
): DashboardAlert[] {
  return runToEnd(scopeAlertsWork(alerts, packets, scope, locale, scopePackets))
}

/** `scopeAlerts`, as work that pauses; see `src/lib/sliced.ts`. */
function* scopeAlertsWork(
  alerts: DashboardAlert[],
  packets: BgpPacket[],
  scope: string | null,
  locale: Locale,
  scopePackets: BgpPacket[] | undefined
): Sliced<DashboardAlert[]> {
  if (!scope) return alerts

  const indices: number[] = []
  const collected: BgpPacket[] = []
  for (let index = 0; index < packets.length; index++) {
    if (pauseAt(index)) yield
    const packet = packets[index]
    if (peeringKey(packet.srcIp, packet.dstIp) !== scope) continue
    indices.push(index)
    collected.push(packet)
  }
  const sessionPackets = scopePackets && scopePackets.length === collected.length ? scopePackets : collected

  const own = alerts.filter((alert) =>
    alert.peering ? alert.peering === scope : !CAPTURE_WIDE_RULES.has(alert.rule)
  )
  const routes = (yield* computeCaptureWideAlerts(sessionPackets, locale)).map((alert) =>
    alert.packetIndex === undefined ? alert : { ...alert, packetIndex: indices[alert.packetIndex] }
  )
  return sortAlerts([...own, ...routes])
}

/**
 * The findings for a capture, worked out once per capture and language.
 *
 * Cached like the route statistics they read, and for the same reason: on a
 * large capture they take seconds, so they are worked out in the background
 * (`alertsForAsync`) and the workspace then reads them from here at once. The
 * returned array is shared; callers must not change it.
 */
const alertsByPackets = new WeakMap<
  BgpPacket[],
  { allPackets: GenericPacket[]; byLocale: Map<Locale, DashboardAlert[]> }
>()

function cachedAlerts(packets: BgpPacket[], allPackets: GenericPacket[], locale: Locale) {
  const entry = alertsByPackets.get(packets)
  return entry?.allPackets === allPackets ? entry.byLocale.get(locale) : undefined
}

function cacheAlerts(
  packets: BgpPacket[],
  allPackets: GenericPacket[],
  locale: Locale,
  alerts: DashboardAlert[]
): DashboardAlert[] {
  let entry = alertsByPackets.get(packets)
  if (entry?.allPackets !== allPackets) {
    entry = { allPackets, byLocale: new Map() }
    alertsByPackets.set(packets, entry)
  }
  entry.byLocale.set(locale, alerts)
  return alerts
}

/** `computeAlerts`, cached; see `alertsByPackets`. */
export function alertsFor(packets: BgpPacket[], allPackets: GenericPacket[], locale: Locale): DashboardAlert[] {
  return (
    cachedAlerts(packets, allPackets, locale) ??
    cacheAlerts(packets, allPackets, locale, computeAlerts(packets, allPackets, locale))
  )
}

/** Whether `alertsFor` already has these findings. */
export function hasAlerts(packets: BgpPacket[], allPackets: GenericPacket[], locale: Locale): boolean {
  return cachedAlerts(packets, allPackets, locale) !== undefined
}

/**
 * `alertsFor`, worked out in slices that hand the page back between them —
 * the route statistics first, then the rules. Same findings, same cache.
 * Resolves to null if `signal` aborts first.
 */
export async function alertsForAsync(
  packets: BgpPacket[],
  allPackets: GenericPacket[],
  locale: Locale,
  signal?: AbortSignal
): Promise<DashboardAlert[] | null> {
  const cached = cachedAlerts(packets, allPackets, locale)
  if (cached) return cached
  // The rules read the statistics through `prefixStatsFor`, which answers at
  // once after this; without it, that one call would be the freeze again.
  if (!(await prefixStatsForAsync(packets, signal))) return null
  const alerts = await runInSlices(alertsWork(packets, allPackets, locale), signal)
  if (!alerts) return null
  // Worked out synchronously in the meantime, by a screen that could not
  // wait: keep that copy, so everyone holds the same array.
  return cachedAlerts(packets, allPackets, locale) ?? cacheAlerts(packets, allPackets, locale, alerts)
}

/**
 * One session's findings, cached on the session's packet array — which the
 * workspace keeps for as long as the scope is chosen — together with what
 * they were worked out from.
 */
const scopedBySessionPackets = new WeakMap<
  BgpPacket[],
  {
    alerts: DashboardAlert[]
    packets: BgpPacket[]
    scope: string
    locale: Locale
    scoped: DashboardAlert[]
  }
>()

function cachedScopedAlerts(
  alerts: DashboardAlert[],
  packets: BgpPacket[],
  scope: string,
  locale: Locale,
  sessionPackets: BgpPacket[]
): DashboardAlert[] | undefined {
  const entry = scopedBySessionPackets.get(sessionPackets)
  return entry &&
    entry.alerts === alerts &&
    entry.packets === packets &&
    entry.scope === scope &&
    entry.locale === locale
    ? entry.scoped
    : undefined
}

/** `scopeAlerts` over the workspace's session packets, cached; see `scopedBySessionPackets`. */
export function scopedAlertsFor(
  alerts: DashboardAlert[],
  packets: BgpPacket[],
  scope: string | null,
  locale: Locale,
  sessionPackets: BgpPacket[]
): DashboardAlert[] {
  if (!scope) return alerts
  const cached = cachedScopedAlerts(alerts, packets, scope, locale, sessionPackets)
  if (cached) return cached
  const scoped = scopeAlerts(alerts, packets, scope, locale, sessionPackets)
  scopedBySessionPackets.set(sessionPackets, { alerts, packets, scope, locale, scoped })
  return scoped
}

/** Whether `scopedAlertsFor` already has this session's findings. */
export function hasScopedAlerts(
  alerts: DashboardAlert[],
  packets: BgpPacket[],
  scope: string | null,
  locale: Locale,
  sessionPackets: BgpPacket[]
): boolean {
  return !scope || cachedScopedAlerts(alerts, packets, scope, locale, sessionPackets) !== undefined
}

/** `scopedAlertsFor`, in slices; see `alertsForAsync`. */
export async function scopedAlertsForAsync(
  alerts: DashboardAlert[],
  packets: BgpPacket[],
  scope: string | null,
  locale: Locale,
  sessionPackets: BgpPacket[],
  signal?: AbortSignal
): Promise<DashboardAlert[] | null> {
  if (!scope) return alerts
  const cached = cachedScopedAlerts(alerts, packets, scope, locale, sessionPackets)
  if (cached) return cached
  if (!(await prefixStatsForAsync(sessionPackets, signal))) return null
  const scoped = await runInSlices(scopeAlertsWork(alerts, packets, scope, locale, sessionPackets), signal)
  if (!scoped) return null
  const meantime = cachedScopedAlerts(alerts, packets, scope, locale, sessionPackets)
  if (meantime) return meantime
  scopedBySessionPackets.set(sessionPackets, { alerts, packets, scope, locale, scoped })
  return scoped
}

/**
 * When a capture holds no BGP at all, the interesting question is *why* — and
 * the answer is usually visible at the TCP layer. A capture of SYNs answered
 * by RSTs is a session failing to establish (filter, MD5/TCP-AO mismatch,
 * BGP not running), and presenting that as "no issues detected" sends the
 * engineer away from the evidence.
 */
export function computeTransportAlerts(
  allPackets: GenericPacket[],
  locale: Locale = 'en'
): DashboardAlert[] {
  const t = getMessages(locale).alerts
  const port179 = allPackets.filter(
    (p) => p.protocol === 'TCP' && (p.srcPort === 179 || p.dstPort === 179)
  )

  if (port179.length === 0) {
    const tcpCount = allPackets.filter((p) => p.protocol === 'TCP').length
    return [
      {
        id: 'transport-no-179',
        rule: 'transport',
        severity: 'warning',
        title: t.transportNo179Title,
        detail:
          tcpCount > 0 ? t.transportNo179DetailTcp(tcpCount) : t.transportNo179DetailNone,
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
        rule: 'transport',
        severity: 'critical',
        title: t.transportRefusedTitle,
        detail: t.transportRefusedDetail(syns.length),
        timestamp: syns[0].timestamp,
        filter: '',
      },
    ]
  }

  if (withPayload.length === 0 && syns.length > 0 && synAcks.length === 0) {
    return [
      {
        id: 'transport-unanswered',
        rule: 'transport',
        severity: 'critical',
        title: t.transportUnansweredTitle,
        detail: t.transportUnansweredDetail(syns.length),
        timestamp: syns[0].timestamp,
        filter: '',
      },
    ]
  }

  return [
    {
      id: 'transport-no-bgp-payload',
      rule: 'transport',
      severity: 'warning',
      title: t.transportNoBgpPayloadTitle,
      detail: t.transportNoBgpPayloadDetail(port179.length),
      timestamp: port179[0].timestamp,
      filter: '',
    },
  ]
}
