/**
 * Per-prefix route statistics for the routes screen.
 *
 * A route only means something together with its mask length, so everything
 * here is keyed by `prefix/length`: 10.0.12.0/24 and 10.0.12.0/23 are different
 * routes and must not share a row.
 *
 * Kept out of the page so the counting rules — the flap definition especially —
 * can be tested without a browser.
 */
import { yieldToPage } from '../yield-to-page'
import type { AsPathAttribute, BgpPacket, BgpPathAttribute, BgpPrefix, BgpUpdateMessage } from './types'
import { formatEvpnIdentity } from './evpn'
import { formatPrefix, parseBgpPrefix, type ParsedPrefix } from '../net/prefix'
import { SharedTable } from './shared-decode'
import { Ipv4PrefixIndex, ipv4PrefixAddress } from '../net/ipv4-index'

export interface PrefixEvent {
  timestamp: Date
  action: 'announce' | 'withdraw'
  asPath?: string
  nextHop?: string
  /**
   * The rest of what decides a best path, carried per announcement because that
   * is the question the route history is opened with: "why did traffic for this
   * prefix leave that way". AS_PATH and NEXT_HOP alone answer it only when the
   * paths differ in length, which is the easy case and not the one anyone comes
   * here for.
   *
   * All optional, and absent means the attribute was not on the UPDATE rather
   * than that it was zero — MED 0 and no MED are different answers, and eBGP
   * routinely carries neither MED nor LOCAL_PREF.
   */
  med?: number
  localPref?: number
  origin?: 'IGP' | 'EGP' | 'INCOMPLETE'
  /** Standard and large communities, formatted as they are displayed elsewhere. */
  communities?: string[]
  /**
   * Route Distinguisher, on EVPN routes. It names the leaf that advertised the
   * route, which is what turns a pair of events into a visible MAC move.
   */
  rd?: string
  /**
   * The ADD-PATH Path Identifier this announcement carried (RFC 7911), which is
   * what tells two otherwise identical rows apart: same prefix, same peer, two
   * paths. Absent means the session did not use ADD-PATH for this family — or,
   * when the OPENs were not captured, that the parser could not tell, which the
   * packet's own warnings say.
   */
  pathId?: number
  /**
   * The peer this event came from. Not the same question as NEXT_HOP, which is
   * a path attribute and can name a router that is not the sender at all —
   * over iBGP or through a route server they routinely differ.
   */
  source: string
  packetIndex: number
}

export interface PrefixStats {
  /**
   * `prefix/length`. The address alone is not an identity: 10.0.12.0/24 and
   * 10.0.12.0/23 are different routes and must not share a row.
   */
  key: string
  parsed: ParsedPrefix | null
  /**
   * Every AS number seen on a path to this route, each once, in the order
   * first seen. An array rather than a Set: a Set is around 150 bytes even for
   * three entries, and there is one of these per route — on a full table,
   * hundreds of thousands. Routes announced with the same path share one array;
   * it is replaced, never modified, when a new AS turns up.
   */
  asns: readonly string[]
  announced: number
  withdrawn: number
  lastSeen: Date
  /**
   * Times this route went away, summed over the peers announcing it. See
   * `aggregatePrefixStats` for what counts as going away.
   */
  flap: number
  /** `lastSeen` as a number, so sorting does not call into Date per comparison. */
  lastSeenMs: number
  /** `announced + withdrawn`: how busy the route is, used as the sort tiebreak. */
  eventCount: number
  /** Every announce and withdraw of the route, oldest first; see `RouteHistory`. */
  history: RouteHistory
}

/**
 * What an UPDATE says about every route it announces, gathered once per UPDATE
 * and shared by the history of every route it carries — and by every UPDATE
 * with the same attributes, see `createAggregator`.
 */
interface Announcement {
  asPath: string
  /** The path's AS numbers, each once, in path order. */
  asns: readonly string[]
  /** The UPDATE's NEXT_HOP, or MP_REACH_NLRI's for the routes it carries. */
  nextHop: string
  med: number | undefined
  localPref: number | undefined
  origin: 'IGP' | 'EGP' | 'INCOMPLETE' | undefined
  communities: string[] | undefined
}

/**
 * Every route's history in one set of columns, each route's events side by
 * side and oldest first.
 *
 * The history used to be one `PrefixEvent` object per announce or withdraw —
 * about 65 bytes each in Chromium, and most of the route statistics: on a
 * dense 200MB capture 3.4 million of them, 240MB of a 1GB heap. Nearly all of
 * an event is something the capture already holds: the packet (its time and
 * sender), the decoded prefix (its RD and Path Identifier) and the UPDATE's
 * attributes, which repeat across UPDATEs. So an event is three indexes into
 * those, twelve bytes, and the `PrefixEvent` the Routes screen shows is put
 * back together from them when it asks (`RouteHistory.events`). The rules
 * that walk every event read the columns directly.
 *
 * The prefix itself is kept only when it says more than the route's key does:
 * an ADD-PATH Path Identifier or an EVPN route's RD. For any other route every
 * event's prefix is the route, so a reference per event — 22 million of them
 * on a 94MB table transfer, in an array grown by copying — bought nothing.
 */
interface HistoryStore {
  packets: BgpPacket[]
  packetIndex: Int32Array
  /** Index into `announcements`; -1 for a withdraw. */
  announcement: Int32Array
  /** Index into `distinctPrefixes`, or -1 when the prefix carries nothing beyond the route's key. */
  distinct: Int32Array
  distinctPrefixes: BgpPrefix[]
  announcements: Announcement[]
}

/** The event's prefix if it carries a Path Identifier or an RD; see `HistoryStore`. */
function distinctPrefix(store: HistoryStore, at: number): BgpPrefix | undefined {
  const distinct = store.distinct[at]
  return distinct < 0 ? undefined : store.distinctPrefixes[distinct]
}

/**
 * One route's events, oldest first. Indexes run from 0 to `length - 1`.
 *
 * Read-only, and its events are built afresh on each call; callers that read
 * them more than once should keep the array `events` returns.
 */
export class RouteHistory {
  private readonly store: HistoryStore
  private readonly start: number
  readonly length: number

  constructor(store: HistoryStore, start: number, length: number) {
    this.store = store
    this.start = start
    this.length = length
  }

  isAnnounce(index: number): boolean {
    return this.store.announcement[this.start + index] >= 0
  }

  packetIndex(index: number): number {
    return this.store.packetIndex[this.start + index]
  }

  timestamp(index: number): Date {
    return this.store.packets[this.packetIndex(index)].timestamp
  }

  /** The peer the event came from. */
  source(index: number): string {
    return this.store.packets[this.packetIndex(index)].srcIp
  }

  /** The announced AS_PATH as text; undefined for a withdraw. */
  asPath(index: number): string | undefined {
    const announcement = this.store.announcement[this.start + index]
    return announcement >= 0 ? this.store.announcements[announcement].asPath : undefined
  }

  pathId(index: number): number | undefined {
    return distinctPrefix(this.store, this.start + index)?.pathId
  }

  /** Whether any event came from one of `sources`. */
  hasSourceIn(sources: ReadonlySet<string>): boolean {
    for (let index = 0; index < this.length; index++) {
      if (sources.has(this.source(index))) return true
    }
    return false
  }

  event(index: number): PrefixEvent {
    const { store } = this
    const at = this.start + index
    const packetIndex = store.packetIndex[at]
    const packet = store.packets[packetIndex]
    const announcement = store.announcement[at] >= 0 ? store.announcements[store.announcement[at]] : undefined
    const prefix = distinctPrefix(store, at)
    return {
      timestamp: packet.timestamp,
      action: announcement ? 'announce' : 'withdraw',
      asPath: announcement?.asPath,
      nextHop: announcement?.nextHop,
      med: announcement?.med,
      localPref: announcement?.localPref,
      origin: announcement?.origin,
      communities: announcement?.communities,
      rd: prefix?.evpn?.rd,
      // Off the prefix rather than the UPDATE, like `rd`: it is part of the
      // NLRI entry, not of the attributes shared by every prefix in the
      // UPDATE, so each route in a block keeps its own.
      pathId: prefix?.pathId,
      source: packet.srcIp,
      packetIndex,
    }
  }

  events(): PrefixEvent[] {
    const events: PrefixEvent[] = new Array(this.length)
    for (let index = 0; index < this.length; index++) events[index] = this.event(index)
    return events
  }

  /** The events, so a route's statistics serialise as they read. */
  toJSON(): PrefixEvent[] {
    return this.events()
  }
}

/** An `Int32Array` that grows as it is appended to. */
class Int32Column {
  data = new Int32Array(1024)
  length = 0

  push(value: number): void {
    if (this.length === this.data.length) {
      const grown = new Int32Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    this.data[this.length++] = value
  }
}

const NEVER_SEEN = 0
const UP = 1
const DOWN = 2

/**
 * One peer's view of every route: whether it currently announces it
 * (`UP`), withdrew it (`DOWN`) or never spoke of it (`NEVER_SEEN`), by the
 * route's index in the statistics.
 *
 * A byte per route while the capture's peers can afford it — there is one of
 * these per announcing peer, and they share `DENSE_BUDGET` — and a `Map`
 * past that. The `Map` was all there used to be, keyed by `prefix/length`
 * text, and its lookups were the other half of a 20-second pass over a large
 * table transfer.
 */
class RouteStates {
  private dense: Uint8Array | null = new Uint8Array(1024)
  private sparse: Map<number, number> | null = null
  private readonly budget: { bytes: number }

  constructor(budget: { bytes: number }) {
    this.budget = budget
    budget.bytes -= 1024
  }

  get(id: number): number {
    const dense = this.dense
    if (dense) return id < dense.length ? dense[id] : NEVER_SEEN
    return this.sparse!.get(id) ?? NEVER_SEEN
  }

  set(id: number, state: number): void {
    if (this.dense && id >= this.dense.length) this.grow(id)
    if (this.dense) this.dense[id] = state
    else this.sparse!.set(id, state)
  }

  private grow(id: number): void {
    const dense = this.dense!
    let size = dense.length * 2
    while (size <= id) size *= 2
    if (size - dense.length > this.budget.bytes) {
      // Over budget: keep the routes this peer has spoken of, and only those.
      const sparse = new Map<number, number>()
      for (let route = 0; route < dense.length; route++) if (dense[route] !== NEVER_SEEN) sparse.set(route, dense[route])
      this.budget.bytes += dense.length
      this.dense = null
      this.sparse = sparse
      return
    }
    this.budget.bytes -= size - dense.length
    const next = new Uint8Array(size)
    next.set(dense)
    this.dense = next
  }
}

/** Bytes of `RouteStates` all of one capture's peers may hold between them. */
const DENSE_BUDGET = 64 << 20

/**
 * `aggregatePrefixStats`, computed once per packet array.
 *
 * The findings and the Routes screen both need the whole capture's statistics,
 * and on a 50MB capture one pass takes several seconds — so computing them in
 * each place made the Routes tab freeze on every visit for a result the
 * findings had already worked out. Keyed by the array itself: a capture's
 * packets are one array for as long as it is open, and a narrowed view is a
 * different array, so a hit is always the same packets. Callers only read the
 * result, which is what makes sharing it safe.
 */
const statsByPackets = new WeakMap<BgpPacket[], PrefixStats[]>()
export function prefixStatsFor(packets: BgpPacket[]): PrefixStats[] {
  let stats = statsByPackets.get(packets)
  if (!stats) {
    stats = aggregatePrefixStats(packets)
    statsByPackets.set(packets, stats)
  }
  return stats
}

/** Whether `prefixStatsFor` already has these packets' statistics. */
export function hasPrefixStats(packets: BgpPacket[]): boolean {
  return statsByPackets.has(packets)
}

/**
 * How long one slice of `prefixStatsForAsync` may run before it hands the
 * page back. Short enough that scrolling and typing stay smooth around it.
 */
const SLICE_MS = 12

/**
 * `prefixStatsFor`, computed in slices that return to the event loop between
 * them, so a large capture's packet list is usable while its route statistics
 * — and the findings that wait on them — are worked out. Same rules, same
 * result, same cache: once it resolves, `prefixStatsFor` answers at once.
 * Resolves to null if `signal` aborts first.
 */
export async function prefixStatsForAsync(
  packets: BgpPacket[],
  signal?: AbortSignal
): Promise<PrefixStats[] | null> {
  const cached = statsByPackets.get(packets)
  if (cached) return cached

  const aggregator = createAggregator(packets)
  let sliceStart = performance.now()
  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    aggregator.addPacket(packets[packetIndex], packetIndex)
    // The clock is read every so often rather than per packet: a packet is a
    // few microseconds of work, the clock a noticeable fraction of that.
    if ((packetIndex & 0xff) === 0xff && performance.now() - sliceStart > SLICE_MS) {
      await yieldToPage()
      // Nobody is waiting any more — another capture, another scope — so stop
      // rather than finish statistics nothing will read.
      if (signal?.aborted) return null
      // Worked out synchronously in the meantime, by a screen that could not
      // wait: use that, rather than finishing a second copy.
      const done = statsByPackets.get(packets)
      if (done) return done
      sliceStart = performance.now()
    }
  }
  const stats = aggregator.finish()
  statsByPackets.set(packets, stats)
  return stats
}

const NO_ASNS: readonly string[] = []

/** `current` with any of `added` it lacks appended — the same array when it lacks none. */
function withAsns(current: readonly string[], added: readonly string[]): readonly string[] {
  if (current === added || current.length === 0) return added
  let grown: string[] | null = null
  for (const asn of added) {
    if (current.includes(asn) || grown?.includes(asn)) continue
    grown ??= [...current]
    grown.push(asn)
  }
  return grown ?? current
}

/** What a route's statistics hold until `finish` fills in its history. */
const NO_HISTORY = new RouteHistory(
  {
    packets: [],
    packetIndex: new Int32Array(0),
    announcement: new Int32Array(0),
    distinct: new Int32Array(0),
    distinctPrefixes: [],
    announcements: [],
  },
  0,
  0
)

/** An UPDATE's attributes as the history needs them; see `createAggregator`. */
interface Gathered {
  announcement: Announcement
  hasMp: boolean
  /** Its index in the history's announcements, once a route has used it. */
  id: number
  /** The same, per MP_REACH_NLRI: those routes carry its NEXT_HOP instead. */
  mpIds: Map<BgpPathAttribute, number> | null
}

/**
 * Builds route statistics one packet at a time, so the same rules can run in
 * one go (`aggregatePrefixStats`) or in slices that leave the page responsive
 * between them (`prefixStatsForAsync`).
 *
 * Written for speed, because it is: it runs over every route of every packet
 * before the findings can show, and on a 50MB capture it was most of the
 * several seconds the page sat frozen after a load. So nothing is allocated
 * per route — an event is appended to typed columns (see `HistoryStore`), the
 * UPDATE's attributes are gathered once and passed by reference, route state
 * is kept per peer rather than under a key concatenated for every route, and
 * AS numbers are formatted once each. The rules are unchanged;
 * tests/lib/bgp/prefix-stats.test.ts holds them.
 *
 * The attributes are gathered once per attribute *list*, not per UPDATE: the
 * decoder hands every UPDATE whose attributes repeat an earlier one's the same
 * array, so a capture of a million UPDATEs over a few hundred attribute sets
 * keeps a few hundred `Announcement`s, which is what lets an event be twelve
 * bytes rather than a copy of its attributes. Like the decoder's tables, this
 * rests when lists do not repeat.
 */
function createAggregator(packets: BgpPacket[]) {
  const stats: PrefixStats[] = []
  const statIds = new Map<string, number>()
  /**
   * Each decoded IPv6 or EVPN prefix's route, so its key — a string built from
   * the prefix — is made and looked up once per prefix object rather than once
   * per event; the decoder hands over one object for every repeat of a prefix
   * (`shared-decode.ts`). A `SharedTable`, so that on a capture whose prefixes
   * are never repeated objects it rests rather than adding a lookup to every
   * event. IPv4 routes have `ipv4Routes` instead.
   */
  const statOfPrefix = new SharedTable<BgpPrefix, number>()
  /**
   * Per announcing peer, whether each route — by its index in `stats` — is
   * currently announced; absent means never announced.
   */
  const routeUpByPeer = new Map<string, RouteStates>()
  const denseBudget = { bytes: DENSE_BUDGET }
  const ipv4Routes = new Ipv4PrefixIndex()
  const asnText = new Map<number, string>()
  /**
   * Each AS_PATH's text and AS numbers, worked out once per decoded path. The
   * decoder shares one AS_PATH between every UPDATE that repeats it, so on a
   * capture that repeats paths this is one string and one array per path
   * rather than per UPDATE — and the route history's `asPath` strings are
   * shared with it. Rests, like the decoder's tables, when paths do not repeat.
   */
  const pathTexts = new SharedTable<AsPathAttribute, { text: string; asns: readonly string[] }>()
  const asPathText = (path: AsPathAttribute): { text: string; asns: readonly string[] } => {
    const consult = pathTexts.active()
    const known = consult ? pathTexts.get(path) : undefined
    if (known) return known
    const all: string[] = []
    for (const segment of path.segments) {
      for (const asn of segment.asNumbers) {
        let text = asnText.get(asn)
        if (text === undefined) {
          text = String(asn)
          asnText.set(asn, text)
        }
        all.push(text)
      }
    }
    const unique = new Set(all).size === all.length ? all : [...new Set(all)]
    const result = { text: all.join(' '), asns: unique }
    return consult ? pathTexts.set(path, result) : result
  }

  const gatheredLists = new SharedTable<BgpPathAttribute[], Gathered>()
  const announcements: Announcement[] = []
  const eventStat = new Int32Column()
  const eventPacket = new Int32Column()
  const eventAnnouncement = new Int32Column()
  const eventDistinct = new Int32Column()
  const distinctPrefixes: BgpPrefix[] = []

  const gather = (attributes: BgpPathAttribute[]): Gathered => {
    const consult = gatheredLists.active()
    const known = consult ? gatheredLists.get(attributes) : undefined
    if (known) return known

    let asns: readonly string[] = NO_ASNS
    let asPath = ''
    let nextHop = ''
    // Undefined rather than 0: an UPDATE with no MED and one with MED 0 are
    // different routes to the same prefix, and the column has to say which.
    let med: number | undefined
    let localPref: number | undefined
    let origin: 'IGP' | 'EGP' | 'INCOMPLETE' | undefined
    let communities: string[] | undefined
    let hasMp = false
    for (const attr of attributes) {
      const parsed = attr.parsed
      if (!parsed) continue
      switch (parsed.type) {
        case 'AS_PATH': {
          const path = asPathText(parsed)
          asns = path.asns
          asPath = path.text
          break
        }
        case 'NEXT_HOP':
          nextHop = parsed.address
          break
        case 'MULTI_EXIT_DISC':
          med = parsed.value
          break
        case 'LOCAL_PREF':
          localPref = parsed.value
          break
        case 'ORIGIN':
          origin = parsed.value
          break
        // Standard and large communities land in one list, the way a reader
        // thinks of them: tags on the route, whatever their encoding.
        case 'COMMUNITIES':
          communities = (communities ?? []).concat(parsed.communities)
          break
        case 'LARGE_COMMUNITIES':
          communities = (communities ?? []).concat(
            parsed.communities.map(
              (community) => `${community.globalAdmin}:${community.localData1}:${community.localData2}`
            )
          )
          break
        case 'MP_REACH_NLRI':
        case 'MP_UNREACH_NLRI':
          hasMp = true
          break
      }
    }
    const gathered: Gathered = {
      announcement: {
        asPath,
        asns,
        nextHop,
        med,
        localPref,
        origin,
        communities: communities && communities.length > 0 ? communities : undefined,
      },
      hasMp,
      id: -1,
      mpIds: null,
    }
    return consult ? gatheredLists.set(attributes, gathered) : gathered
  }

  /** `gathered`'s announcement index, for the routes of `mpReach` if given. */
  const announcementId = (gathered: Gathered, mpReach?: BgpPathAttribute, mpNextHop = ''): number => {
    if (!mpReach) {
      if (gathered.id < 0) gathered.id = announcements.push(gathered.announcement) - 1
      return gathered.id
    }
    gathered.mpIds ??= new Map()
    let id = gathered.mpIds.get(mpReach)
    if (id === undefined) {
      id = announcements.push({ ...gathered.announcement, nextHop: mpNextHop }) - 1
      gathered.mpIds.set(mpReach, id)
    }
    return id
  }

  /** The route `prefix` belongs to, by its index in `stats`, created on first sight. */
  const statFor = (prefix: BgpPrefix, timestamp: Date, ms: number): number => {
    // An IPv4 route — nearly every one — is found by its address, without
    // building its key; see `Ipv4PrefixIndex`.
    const address = ipv4PrefixAddress(prefix)
    if (address >= 0) {
      let id = ipv4Routes.get(address | 0, prefix.length)
      if (id < 0) {
        id = addStat(formatPrefix(prefix), prefix, timestamp, ms)
        ipv4Routes.add(address | 0, prefix.length, id)
      }
      return id
    }
    const consult = statOfPrefix.active()
    let statId = consult ? statOfPrefix.get(prefix) : undefined
    if (statId !== undefined) return statId
    // EVPN routes are keyed by what identifies them across the fabric, not by
    // the leaf that happened to advertise them — see `formatEvpnIdentity`.
    const key = prefix.evpn ? formatEvpnIdentity(prefix.evpn) : formatPrefix(prefix)
    statId = statIds.get(key)
    if (statId === undefined) {
      statId = addStat(key, prefix, timestamp, ms)
      statIds.set(key, statId)
    }
    return consult ? statOfPrefix.set(prefix, statId) : statId
  }

  /** A new route's statistics, by its index in `stats`. */
  const addStat = (key: string, prefix: BgpPrefix, timestamp: Date, ms: number): number => {
    stats.push({
      key,
      parsed: parseBgpPrefix(prefix),
      asns: NO_ASNS,
      announced: 0,
      withdrawn: 0,
      lastSeen: timestamp,
      flap: 0,
      lastSeenMs: ms,
      eventCount: 0,
      history: NO_HISTORY,
    })
    return stats.length - 1
  }

  /**
   * Records one announce or withdraw against `prefix/length`. Every caller goes
   * through here so the four NLRI sources cannot drift apart on how a route is
   * keyed or how its state is tracked.
   */
  const record = (
    prefix: BgpPrefix,
    routeUp: RouteStates,
    timestamp: Date,
    /** `timestamp` in milliseconds, read once per packet. */
    ms: number,
    packetIndex: number,
    announcement: Announcement | null,
    /** Index into `announcements`; -1 for a withdraw. */
    announcementIndex: number
  ) => {
    const statId = statFor(prefix, timestamp, ms)
    const stat = stats[statId]

    if (announcement) {
      stat.announced++
      routeUp.set(statId, UP)
      stat.asns = withAsns(stat.asns, announcement.asns)
    } else {
      stat.withdrawn++
      if (routeUp.get(statId) !== DOWN) stat.flap++
      routeUp.set(statId, DOWN)
    }

    stat.eventCount++
    stat.lastSeen = timestamp
    stat.lastSeenMs = ms
    eventStat.push(statId)
    eventPacket.push(packetIndex)
    eventAnnouncement.push(announcementIndex)
    eventDistinct.push(prefix.pathId !== undefined || prefix.evpn ? distinctPrefixes.push(prefix) - 1 : -1)
  }

  const addPacket = (packet: BgpPacket, packetIndex: number) => {
    // The peer that spoke, which is what makes route state per-session.
    const source = packet.srcIp
    let routeUp = routeUpByPeer.get(source)
    if (!routeUp) {
      routeUp = new RouteStates(denseBudget)
      routeUpByPeer.set(source, routeUp)
    }
    const { timestamp } = packet
    const ms = timestamp.getTime()

    for (const msg of packet.messages) {
      if (msg.type !== 'UPDATE') continue
      const update = msg as BgpUpdateMessage
      const attributes = update.pathAttributes || []
      const gathered = gather(attributes)
      const { announcement } = gathered

      // Process NLRI (announced prefixes)
      const nlri = update.nlri || []
      if (nlri.length > 0) {
        const id = announcementId(gathered)
        for (const entry of nlri) record(entry, routeUp, timestamp, ms, packetIndex, announcement, id)
      }

      // Process withdrawn routes
      for (const wr of update.withdrawnRoutes || []) {
        record(wr, routeUp, timestamp, ms, packetIndex, null, -1)
      }

      // Process MP_REACH_NLRI / MP_UNREACH_NLRI (IPv6 and other families)
      if (!gathered.hasMp) continue
      for (const attr of attributes) {
        if (attr.parsed?.type === 'MP_REACH_NLRI') {
          const reached = attr.parsed.nlri || []
          if (reached.length === 0) continue
          const id = announcementId(gathered, attr, attr.parsed.nextHop)
          for (const entry of reached) record(entry, routeUp, timestamp, ms, packetIndex, announcement, id)
        }
        if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
          for (const entry of attr.parsed.withdrawnRoutes || []) {
            record(entry, routeUp, timestamp, ms, packetIndex, null, -1)
          }
        }
      }
    }
  }

  const finish = (): PrefixStats[] => {
    // Lay each route's events side by side, in the order they were recorded:
    // a counting sort on the route, which keeps that order within each one.
    const total = eventStat.length
    const offsets = new Int32Array(stats.length + 1)
    for (let event = 0; event < total; event++) offsets[eventStat.data[event] + 1]++
    for (let statId = 0; statId < stats.length; statId++) offsets[statId + 1] += offsets[statId]
    const cursor = offsets.slice(0, stats.length)
    const store: HistoryStore = {
      packets,
      packetIndex: new Int32Array(total),
      announcement: new Int32Array(total),
      distinct: new Int32Array(total),
      distinctPrefixes,
      announcements,
    }
    for (let event = 0; event < total; event++) {
      const at = cursor[eventStat.data[event]]++
      store.packetIndex[at] = eventPacket.data[event]
      store.announcement[at] = eventAnnouncement.data[event]
      store.distinct[at] = eventDistinct.data[event]
    }

    // Sort history by timestamp. Packets come in capture order, so a history is
    // almost always in order already; checking is far cheaper than sorting.
    const timeOf = (at: number) => packets[store.packetIndex[at]].timestamp.getTime()
    for (let statId = 0; statId < stats.length; statId++) {
      const start = offsets[statId]
      const end = offsets[statId + 1]
      for (let at = start + 1; at < end; at++) {
        if (timeOf(at) < timeOf(at - 1)) {
          sortRange(store, start, end, timeOf)
          break
        }
      }
      stats[statId].history = new RouteHistory(store, start, end - start)
    }

    return stats
  }

  return { addPacket, finish }
}

/** Sort one route's events by time, keeping the recorded order among equal times. */
function sortRange(store: HistoryStore, start: number, end: number, timeOf: (at: number) => number): void {
  const order: number[] = []
  for (let at = start; at < end; at++) order.push(at)
  order.sort((a, b) => timeOf(a) - timeOf(b))
  const packetIndex = order.map((at) => store.packetIndex[at])
  const announcement = order.map((at) => store.announcement[at])
  const distinct = order.map((at) => store.distinct[at])
  for (let i = 0; i < order.length; i++) {
    store.packetIndex[start + i] = packetIndex[i]
    store.announcement[start + i] = announcement[i]
    store.distinct[start + i] = distinct[i]
  }
}

/**
 * Rolls every UPDATE in the capture up into one row per route.
 *
 * Announced and withdrawn are raw event counts — how many times the route was
 * spoken about. Flap is a different question: how many times the route actually
 * went away, counted per (route, announcing peer) pair so that ten peers each
 * announcing a prefix once reads as a stable route rather than as ten flaps.
 * One flap is counted on each up→down transition of a pair; the re-announce
 * that follows is not itself a flap, the next withdraw is. A withdraw for a
 * pair that was never seen announced still counts: the capture started
 * mid-session, the route was up before it began, and it going away is exactly
 * what the column is there to show. A repeat withdraw of an already-down pair
 * is not a second flap.
 */
export function aggregatePrefixStats(packets: BgpPacket[]): PrefixStats[] {
  const aggregator = createAggregator(packets)
  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    aggregator.addPacket(packets[packetIndex], packetIndex)
  }
  return aggregator.finish()
}
