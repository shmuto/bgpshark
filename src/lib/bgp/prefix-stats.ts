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
import type { BgpPacket, BgpPrefix, BgpUpdateMessage } from './types'
import { formatEvpnIdentity } from './evpn'
import { formatPrefix, parseBgpPrefix, type ParsedPrefix } from '../net/prefix'

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
  /** Every AS seen in an AS_PATH announcing this prefix, for AS number searches. */
  asns: Set<string>
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
  history: PrefixEvent[]
}

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

  const aggregator = createAggregator()
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

/** What an UPDATE says about every route it announces, gathered once per UPDATE. */
interface Announcement {
  asPath: string
  asns: string[]
  nextHop: string
  med: number | undefined
  localPref: number | undefined
  origin: 'IGP' | 'EGP' | 'INCOMPLETE' | undefined
  communities: string[] | undefined
}

/**
 * Builds route statistics one packet at a time, so the same rules can run in
 * one go (`aggregatePrefixStats`) or in slices that leave the page responsive
 * between them (`prefixStatsForAsync`).
 *
 * Written for speed, because it is: it runs over every route of every packet
 * before the findings can show, and on a 50MB capture it was most of the
 * several seconds the page sat frozen after a load. So nothing is allocated
 * per route beyond the history entry itself — the UPDATE's attributes are
 * gathered once and passed by reference, route state is kept per peer rather
 * than under a key concatenated for every route, and AS numbers are formatted
 * once each. The rules are unchanged; tests/lib/bgp/prefix-stats.test.ts holds
 * them.
 */
function createAggregator() {
  const stats = new Map<string, PrefixStats>()
  /**
   * Per announcing peer, whether each route is currently announced; absent
   * means never announced.
   */
  const routeUpByPeer = new Map<string, Map<string, boolean>>()
  const asnText = new Map<number, string>()

  /**
   * Records one announce or withdraw against `prefix/length`. Every caller goes
   * through here so the four NLRI sources cannot drift apart on how a route is
   * keyed or how its state is tracked.
   */
  const record = (
    prefix: BgpPrefix,
    routeUp: Map<string, boolean>,
    source: string,
    timestamp: Date,
    packetIndex: number,
    announcement: Announcement | null,
    nextHop: string | undefined
  ) => {
    // EVPN routes are keyed by what identifies them across the fabric, not by
    // the leaf that happened to advertise them — see `formatEvpnIdentity`.
    const key = prefix.evpn ? formatEvpnIdentity(prefix.evpn) : formatPrefix(prefix)
    let stat = stats.get(key)
    if (!stat) {
      stat = {
        key,
        parsed: parseBgpPrefix(prefix),
        asns: new Set(),
        announced: 0,
        withdrawn: 0,
        lastSeen: timestamp,
        flap: 0,
        lastSeenMs: timestamp.getTime(),
        eventCount: 0,
        history: [],
      }
      stats.set(key, stat)
    }

    if (announcement) {
      stat.announced++
      routeUp.set(key, true)
      for (const asn of announcement.asns) stat.asns.add(asn)
    } else {
      stat.withdrawn++
      if (routeUp.get(key) !== false) stat.flap++
      routeUp.set(key, false)
    }

    stat.eventCount++
    stat.lastSeen = timestamp
    stat.lastSeenMs = timestamp.getTime()
    stat.history.push({
      timestamp,
      action: announcement ? 'announce' : 'withdraw',
      asPath: announcement?.asPath,
      nextHop,
      med: announcement?.med,
      localPref: announcement?.localPref,
      origin: announcement?.origin,
      communities: announcement?.communities,
      rd: prefix.evpn?.rd,
      // Off the prefix rather than the UPDATE, like `rd`: it is part of the
      // NLRI entry, not of the attributes shared by every prefix in the
      // UPDATE, so each route in a block keeps its own.
      pathId: prefix.pathId,
      source,
      packetIndex,
    })
  }

  const addPacket = (packet: BgpPacket, packetIndex: number) => {
    // The peer that spoke, which is what makes route state per-session.
    const source = packet.srcIp
    let routeUp = routeUpByPeer.get(source)
    if (!routeUp) {
      routeUp = new Map()
      routeUpByPeer.set(source, routeUp)
    }
    const { timestamp } = packet

    for (const msg of packet.messages) {
      if (msg.type !== 'UPDATE') continue
      const update = msg as BgpUpdateMessage
      const attributes = update.pathAttributes || []

      // Get AS_PATH and NEXT_HOP from path attributes
      let asns: string[] = []
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
            asns = []
            for (const segment of parsed.segments) {
              for (const asn of segment.asNumbers) {
                let text = asnText.get(asn)
                if (text === undefined) {
                  text = String(asn)
                  asnText.set(asn, text)
                }
                asns.push(text)
              }
            }
            asPath = asns.join(' ')
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
      const announcement: Announcement = {
        asPath,
        asns,
        nextHop,
        med,
        localPref,
        origin,
        communities: communities && communities.length > 0 ? communities : undefined,
      }

      // Process NLRI (announced prefixes)
      for (const nlri of update.nlri || []) {
        record(nlri, routeUp, source, timestamp, packetIndex, announcement, nextHop)
      }

      // Process withdrawn routes
      for (const wr of update.withdrawnRoutes || []) {
        record(wr, routeUp, source, timestamp, packetIndex, null, undefined)
      }

      // Process MP_REACH_NLRI / MP_UNREACH_NLRI (IPv6 and other families)
      if (!hasMp) continue
      for (const attr of attributes) {
        if (attr.parsed?.type === 'MP_REACH_NLRI') {
          for (const nlri of attr.parsed.nlri || []) {
            record(nlri, routeUp, source, timestamp, packetIndex, announcement, attr.parsed.nextHop)
          }
        }
        if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
          for (const nlri of attr.parsed.withdrawnRoutes || []) {
            record(nlri, routeUp, source, timestamp, packetIndex, null, undefined)
          }
        }
      }
    }
  }

  const finish = (): PrefixStats[] => {
    // Sort history by timestamp. Packets come in capture order, so a history is
    // almost always in order already; checking is far cheaper than sorting.
    for (const stat of stats.values()) {
      const history = stat.history
      for (let i = 1; i < history.length; i++) {
        if (history[i].timestamp.getTime() < history[i - 1].timestamp.getTime()) {
          history.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
          break
        }
      }
    }

    return Array.from(stats.values())
  }

  return { addPacket, finish }
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
  const aggregator = createAggregator()
  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    aggregator.addPacket(packets[packetIndex], packetIndex)
  }
  return aggregator.finish()
}
