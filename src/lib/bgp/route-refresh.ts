/**
 * What a route refresh actually changed.
 *
 * A ROUTE-REFRESH asks the peer to re-advertise everything it has for one
 * address family, and the reason anyone sends one is a policy change: a soft
 * clear, then a look at whether the routes that came back are the ones expected.
 * The capture holds both halves — the routes before the request, and the
 * re-advertisement that answers it — and until this existed the difference
 * between them was the reader's to take by eye.
 *
 * The comparison is one-directional and easy to get backwards. A refresh sent
 * by A asks *B* to re-advertise, so the RIB being compared is the one B
 * announces, and the request travels the opposite way to the answer.
 *
 * The other thing worth stating: after a refresh the peer re-sends its whole
 * table, and a route it no longer has is simply absent from that re-send rather
 * than withdrawn. So "removed" cannot be read from withdrawals — it is what was
 * there before and did not come back, which is exactly the "my soft clear lost
 * routes" complaint S9 is about.
 */
import type { BgpPacket, BgpUpdateMessage, BgpRouteRefreshMessage } from './types'
import { formatPrefix } from '../net/prefix'
import { endOfRibMarker } from './update'

/** One route as the comparison sees it: an identity and the attributes on it. */
interface RouteState {
  key: string
  asPath?: string
  communities?: string[]
  med?: number
  localPref?: number
  nextHop?: string
  /** The packet it was last announced in, so the row can link to it. */
  packetIndex: number
}

/** How one route differed across the refresh. */
export interface RouteChange {
  key: string
  /** What changed, in the words the panel uses. */
  detail: string
  packetIndex: number
}

export interface RouteRefreshDiff {
  /** The end asked to re-advertise — the refresh's destination. */
  peer: string
  afiName: string
  safiName: string
  added: RouteChange[]
  removed: RouteChange[]
  changed: RouteChange[]
  unchanged: number
  /**
   * True when the capture began after this session was already up, so the
   * "before" set is whatever happened to be caught rather than the peer's
   * table. A removal reported from an incomplete before-set may be a route the
   * capture never saw announced.
   */
  beforeIncomplete: boolean
  /**
   * True when no End-of-RIB closed the re-advertisement, so the "after" set is
   * only what had arrived by the end of the capture. Everything not yet re-sent
   * looks removed.
   */
  afterIncomplete: boolean
}

function attributesOf(update: BgpUpdateMessage): Omit<RouteState, 'key' | 'packetIndex'> {
  const state: Omit<RouteState, 'key' | 'packetIndex'> = {}
  const communities: string[] = []

  for (const attr of update.pathAttributes) {
    if (attr.parsed?.type === 'AS_PATH') {
      state.asPath = attr.parsed.segments.flatMap((segment) => segment.asNumbers).join(' ')
    }
    if (attr.parsed?.type === 'NEXT_HOP') state.nextHop = attr.parsed.address
    if (attr.parsed?.type === 'MULTI_EXIT_DISC') state.med = attr.parsed.value
    if (attr.parsed?.type === 'LOCAL_PREF') state.localPref = attr.parsed.value
    if (attr.parsed?.type === 'COMMUNITIES') communities.push(...attr.parsed.communities)
    if (attr.parsed?.type === 'LARGE_COMMUNITIES') {
      communities.push(
        ...attr.parsed.communities.map(
          (community) => `${community.globalAdmin}:${community.localData1}:${community.localData2}`
        )
      )
    }
  }
  if (communities.length > 0) state.communities = communities

  return state
}

/**
 * The routes `peer` had announced and not withdrawn, walking packets in
 * `range`.
 *
 * A map rather than a list because a route announced twice is one route in the
 * table with the attributes of the later announcement — which is the whole
 * point on the "after" side, where everything is announced again.
 */
function ribFrom(
  packets: BgpPacket[],
  peer: string,
  from: number,
  to: number
): Map<string, RouteState> {
  const rib = new Map<string, RouteState>()

  for (let index = from; index < to; index++) {
    const packet = packets[index]
    if (!packet || packet.srcIp !== peer) continue

    for (const message of packet.messages) {
      if (message.type !== 'UPDATE') continue
      const update = message as BgpUpdateMessage
      // An End-of-RIB is a marker, not a route, and its empty NLRI must not be
      // mistaken for one.
      if (endOfRibMarker(update)) continue

      const attributes = attributesOf(update)
      for (const prefix of update.nlri) {
        rib.set(formatPrefix(prefix), {
          key: formatPrefix(prefix),
          ...attributes,
          packetIndex: index,
        })
      }
      for (const attr of update.pathAttributes) {
        if (attr.parsed?.type === 'MP_REACH_NLRI') {
          for (const prefix of attr.parsed.nlri ?? []) {
            rib.set(formatPrefix(prefix), {
              key: formatPrefix(prefix),
              ...attributes,
              nextHop: attr.parsed.nextHop,
              packetIndex: index,
            })
          }
        }
      }

      for (const prefix of update.withdrawnRoutes) rib.delete(formatPrefix(prefix))
      for (const attr of update.pathAttributes) {
        if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
          for (const prefix of attr.parsed.withdrawnRoutes ?? []) rib.delete(formatPrefix(prefix))
        }
      }
    }
  }

  return rib
}

/** The attribute differences between two announcements of one route. */
function describeChange(before: RouteState, after: RouteState): string | null {
  const parts: string[] = []

  const communitiesBefore = (before.communities ?? []).join(' ')
  const communitiesAfter = (after.communities ?? []).join(' ')
  if (communitiesBefore !== communitiesAfter) {
    if (communitiesBefore === '') parts.push(`community ${communitiesAfter} added`)
    else if (communitiesAfter === '') parts.push(`community ${communitiesBefore} removed`)
    else parts.push(`community ${communitiesBefore} → ${communitiesAfter}`)
  }
  if (before.asPath !== after.asPath) {
    parts.push(`AS_PATH ${before.asPath || '(none)'} → ${after.asPath || '(none)'}`)
  }
  if (before.med !== after.med) {
    parts.push(`MED ${before.med ?? '(none)'} → ${after.med ?? '(none)'}`)
  }
  if (before.localPref !== after.localPref) {
    parts.push(`LOCAL_PREF ${before.localPref ?? '(none)'} → ${after.localPref ?? '(none)'}`)
  }
  if (before.nextHop !== after.nextHop) {
    parts.push(`next hop ${before.nextHop || '(none)'} → ${after.nextHop || '(none)'}`)
  }

  return parts.length > 0 ? parts.join(', ') : null
}

/**
 * Compare the routes either side of the ROUTE-REFRESH at `index`, or null when
 * the packet is not one.
 *
 * The window that answers the request runs from the refresh to the peer's
 * End-of-RIB, or to the next refresh, or to the end of the capture — whichever
 * comes first. Each of those endings means something different about how much
 * of the answer the capture holds, which is why `afterIncomplete` exists.
 */
export function routeRefreshDiff(packets: BgpPacket[], index: number): RouteRefreshDiff | null {
  const packet = packets[index]
  if (!packet) return null

  const refresh = packet.messages.find(
    (message): message is BgpRouteRefreshMessage => message.type === 'ROUTE_REFRESH'
  )
  if (!refresh) return null

  // The request goes to the end that will answer it.
  const peer = packet.dstIp

  // Where the answer stops. An End-of-RIB from the peer closes it; so does
  // another refresh, since the next re-advertisement is a different question.
  let end = packets.length
  let sawEndOfRib = false
  for (let after = index + 1; after < packets.length; after++) {
    const later = packets[after]
    if (later.srcIp === peer) {
      const closed = later.messages.some(
        (message) => message.type === 'UPDATE' && endOfRibMarker(message as BgpUpdateMessage)
      )
      if (closed) {
        end = after + 1
        sawEndOfRib = true
        break
      }
    }
    if (later.messages.some((message) => message.type === 'ROUTE_REFRESH')) {
      end = after
      break
    }
  }

  const before = ribFrom(packets, peer, 0, index)
  const after = ribFrom(packets, peer, index + 1, end)

  const added: RouteChange[] = []
  const removed: RouteChange[] = []
  const changed: RouteChange[] = []
  let unchanged = 0

  for (const [key, state] of after) {
    const previous = before.get(key)
    if (!previous) {
      added.push({
        key,
        detail: state.communities?.length
          ? `announced with community ${state.communities.join(' ')}`
          : 'announced',
        packetIndex: state.packetIndex,
      })
      continue
    }
    const difference = describeChange(previous, state)
    if (difference) changed.push({ key, detail: difference, packetIndex: state.packetIndex })
    else unchanged++
  }

  for (const [key, state] of before) {
    if (after.has(key)) continue
    removed.push({
      key,
      detail: 'was not re-advertised',
      // The packet that last announced it, which is the only place the capture
      // can show a route that has since stopped existing.
      packetIndex: state.packetIndex,
    })
  }

  // Whether the capture caught this session starting. Without the OPENs the
  // "before" set is whatever happened to be in the file, so a removal may be a
  // route that was announced before the capture began.
  const sawOpen = packets
    .slice(0, index)
    .some(
      (earlier) =>
        earlier.srcIp === peer && earlier.messages.some((message) => message.type === 'OPEN')
    )

  return {
    peer,
    afiName: refresh.afiName,
    safiName: refresh.safiName,
    added,
    removed,
    changed,
    unchanged,
    beforeIncomplete: !sawOpen,
    afterIncomplete: !sawEndOfRib,
  }
}
