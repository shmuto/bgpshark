import { useState, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useIsCompact } from '../hooks/useMediaQuery'
import { BackToList, PaneDivider } from '../components/common'
import { useSplitPane } from '../hooks/useSplitPane'
import type { BgpOpenMessage, BgpUpdateMessage, BgpNotificationMessage } from '../lib/bgp/types'
import { extractNeighbors, getLatestOpen, type OpenMessageRecord } from '../lib/bgp/neighbor'
import { extractSessionEvents, groupEventsBySession, type SessionState } from '../lib/bgp/session-events'
import { CapabilityDiff } from '../components/neighbor'
import { countUpdatePrefixes, endOfRibMarker } from '../lib/bgp/update'
import { formatDelta, formatTimeOfDayUtc } from '../lib/format-time'

const SESSION_EVENT_TYPES = new Set(['OPEN', 'NOTIFICATION'])

const SESSION_STATE_STYLE: Record<SessionState, string> = {
  Established: 'bg-ok-subtle text-ok',
  Down: 'bg-critical-subtle text-critical',
  Idle: 'bg-surface-sunken text-muted',
  Connect: 'bg-warning-subtle text-warning',
  OpenSent: 'bg-warning-subtle text-warning',
  OpenConfirm: 'bg-warning-subtle text-warning',
}

const MESSAGE_ROW_TINT: Record<string, string> = {
  OPEN: 'bg-bgp-open/5',
  NOTIFICATION: 'bg-bgp-notification/5',
}

const MESSAGE_BADGE: Record<string, string> = {
  OPEN: 'bg-bgp-open/10 text-bgp-open',
  NOTIFICATION: 'bg-bgp-notification/10 text-bgp-notification',
  UPDATE: 'bg-bgp-update/10 text-bgp-update',
  KEEPALIVE: 'bg-bgp-keepalive/10 text-bgp-keepalive',
  ROUTE_REFRESH: 'bg-bgp-route-refresh/10 text-bgp-route-refresh',
}

// Display names for the messageSummary keys; a bare uppercase() turns
// routeRefresh into ROUTEREFRESH.
const MESSAGE_TYPE_LABELS: Record<string, string> = {
  open: 'OPEN',
  update: 'UPDATE',
  notification: 'NOTIFICATION',
  keepalive: 'KEEPALIVE',
  routeRefresh: 'ROUTE_REFRESH',
}

// Group by Router ID
interface RouterGroup {
  routerId: string // Router ID or "unknown-{ip}" if no OPEN received
  displayName: string // Router ID or first IP
  asNumber: number | null
  ips: string[] // All IPs associated with this Router ID
  totalMessages: number
  messageCounts: {
    open: number
    update: number
    notification: number
    keepalive: number
    routeRefresh: number
  }
  lastActivity: Date
  latestOpen: OpenMessageRecord | null
}

interface SessionDetail {
  peerIp: string
  direction: 'outbound' | 'inbound'
  messageCount: number
  hasNotification: boolean
}

export function NeighborsPage() {
  const { packets } = useApp()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // URL-based state for router and peer selection (persists across navigation)
  const selectedRouter = searchParams.get('router')
  const selectedPeer = searchParams.get('peer')

  const setSelectedRouter = useCallback((routerId: string | null) => {
    setSearchParams((prev) => {
      if (routerId) {
        prev.set('router', routerId)
      } else {
        prev.delete('router')
      }
      prev.delete('peer') // Clear peer when router changes
      return prev
    })
  }, [setSearchParams])

  const setSelectedPeer = useCallback((peerIp: string | null) => {
    setSearchParams((prev) => {
      if (peerIp) {
        prev.set('peer', peerIp)
      } else {
        prev.delete('peer')
      }
      return prev
    })
  }, [setSearchParams])

  const [filterType, setFilterType] = useState<'all' | 'alerts' | 'open' | 'inactive'>('all')
  /**
   * Session Messages defaults to the events that establish or end a session.
   * The rest is what was flowing while it was up — which is the question when
   * a hold timer expires, because the keepalives stopping is the evidence.
   */
  const [messageScope, setMessageScope] = useState<'events' | 'all'>('events')

  /**
   * Where each session stood when the capture ended, keyed by the sorted IP
   * pair. "22 messages exchanged" does not say whether the session is up now,
   * which is the first thing asked about a peer under suspicion.
   */
  const sessionStates = useMemo(() => {
    const tracks = groupEventsBySession(extractSessionEvents(packets))
    const byPair = new Map<string, SessionState>()
    for (const track of tracks.values()) {
      byPair.set([track.srcIp, track.dstIp].sort().join('|'), track.currentState)
    }
    return byPair
  }, [packets])
  const [searchQuery, setSearchQuery] = useState('')

  // Extract all routers grouped by Router ID
  const routers = useMemo((): RouterGroup[] => {
    const neighbors = extractNeighbors(packets)
    const routerIdMap = new Map<string, RouterGroup>()

    for (const [ip, neighbor] of neighbors) {
      const latestOpen = getLatestOpen(neighbor)
      const routerId = latestOpen?.routerId || `unknown-${ip}`
      const totalMsgs = neighbor.messageCount.open + neighbor.messageCount.update +
                        neighbor.messageCount.notification + neighbor.messageCount.keepalive +
                        neighbor.messageCount.routeRefresh

      if (routerIdMap.has(routerId)) {
        // Merge with existing router group
        const existing = routerIdMap.get(routerId)!
        if (!existing.ips.includes(ip)) {
          existing.ips.push(ip)
        }
        existing.totalMessages += totalMsgs
        existing.messageCounts.open += neighbor.messageCount.open
        existing.messageCounts.update += neighbor.messageCount.update
        existing.messageCounts.notification += neighbor.messageCount.notification
        existing.messageCounts.keepalive += neighbor.messageCount.keepalive
        existing.messageCounts.routeRefresh += neighbor.messageCount.routeRefresh
        if (neighbor.lastSeen > existing.lastActivity) {
          existing.lastActivity = neighbor.lastSeen
        }
        // Update latestOpen if this one is newer
        if (latestOpen && (!existing.latestOpen || latestOpen.timestamp > existing.latestOpen.timestamp)) {
          existing.latestOpen = latestOpen
          existing.asNumber = latestOpen.asNumber
        }
      } else {
        // Create new router group
        routerIdMap.set(routerId, {
          routerId,
          displayName: latestOpen?.routerId || ip,
          asNumber: latestOpen?.asNumber || null,
          ips: [ip],
          totalMessages: totalMsgs,
          messageCounts: {
            open: neighbor.messageCount.open,
            update: neighbor.messageCount.update,
            notification: neighbor.messageCount.notification,
            keepalive: neighbor.messageCount.keepalive,
            routeRefresh: neighbor.messageCount.routeRefresh,
          },
          lastActivity: neighbor.lastSeen,
          latestOpen,
        })
      }
    }

    return Array.from(routerIdMap.values()).sort((a, b) => {
      // Sort: with notifications first, then by message count
      if (a.messageCounts.notification > 0 && b.messageCounts.notification === 0) return -1
      if (a.messageCounts.notification === 0 && b.messageCounts.notification > 0) return 1
      return b.totalMessages - a.totalMessages
    })
  }, [packets])

  // Filter routers
  const filteredRouters = useMemo(() => {
    let result = routers

    // Apply type filter
    switch (filterType) {
      case 'alerts':
        result = result.filter(r => r.messageCounts.notification > 0)
        break
      case 'open':
        result = result.filter(r => r.latestOpen !== null)
        break
      case 'inactive':
        result = result.filter(r => r.totalMessages <= 10)
        break
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(r =>
        r.routerId.toLowerCase().includes(query) ||
        r.ips.some(ip => ip.includes(query)) ||
        r.asNumber?.toString().includes(query)
      )
    }

    return result
  }, [routers, filterType, searchQuery])

  // Get selected router details
  const selectedRouterInfo = selectedRouter ? routers.find(r => r.routerId === selectedRouter) : null

  // Too narrow for two columns: show the list, or the detail, but not halves of
  // both.
  const isCompact = useIsCompact()
  const split = useSplitPane('neighbors', 33)
  const showList = !isCompact || selectedRouter === null
  const showDetail = !isCompact || selectedRouter !== null

  // Get IPs for selected router
  const selectedIps = useMemo(() => {
    return selectedRouterInfo?.ips || []
  }, [selectedRouterInfo])

  // Get message summary for selected router
  const messageSummary = useMemo(() => {
    if (selectedIps.length === 0) return null

    const counts = { open: 0, update: 0, notification: 0, keepalive: 0, routeRefresh: 0 }
    for (const packet of packets) {
      if (selectedIps.includes(packet.srcIp) || selectedIps.includes(packet.dstIp)) {
        for (const msg of packet.messages) {
          switch (msg.type) {
            case 'OPEN': counts.open++; break
            case 'UPDATE': counts.update++; break
            case 'NOTIFICATION': counts.notification++; break
            case 'KEEPALIVE': counts.keepalive++; break
            case 'ROUTE_REFRESH': counts.routeRefresh++; break
          }
        }
      }
    }
    return counts
  }, [selectedIps, packets])

  // Get sessions for selected router
  const sessions = useMemo((): SessionDetail[] => {
    if (selectedIps.length === 0) return []

    const sessionMap = new Map<string, SessionDetail>()

    for (const packet of packets) {
      let peerIp: string | null = null
      let direction: 'outbound' | 'inbound' | null = null

      if (selectedIps.includes(packet.srcIp)) {
        peerIp = packet.dstIp
        direction = 'outbound'
      } else if (selectedIps.includes(packet.dstIp)) {
        peerIp = packet.srcIp
        direction = 'inbound'
      }

      if (peerIp && direction && !selectedIps.includes(peerIp)) {
        if (!sessionMap.has(peerIp)) {
          sessionMap.set(peerIp, {
            peerIp,
            direction,
            messageCount: 0,
            hasNotification: false,
          })
        }
        const session = sessionMap.get(peerIp)!
        session.messageCount += packet.messages.length
        if (packet.messages.some(m => m.type === 'NOTIFICATION')) {
          session.hasNotification = true
        }
      }
    }

    return Array.from(sessionMap.values()).sort((a, b) => b.messageCount - a.messageCount)
  }, [selectedIps, packets])

  // Get key session messages (OPEN/NOTIFICATION) for selected router
  const sessionMessages = useMemo(() => {
    if (selectedIps.length === 0) return []

    const result: Array<{
      timestamp: Date
      srcIp: string
      dstIp: string
      peerIp: string
      type: 'OPEN' | 'NOTIFICATION' | 'UPDATE' | 'KEEPALIVE' | 'ROUTE_REFRESH'
      detail: string
      packetIndex: number
    }> = []

    packets.forEach((packet, index) => {
      const isSrc = selectedIps.includes(packet.srcIp)
      const isDst = selectedIps.includes(packet.dstIp)
      if (!isSrc && !isDst) return

      const peerIp = isSrc ? packet.dstIp : packet.srcIp

      for (const msg of packet.messages) {
        if (msg.type === 'OPEN') {
          const openMsg = msg as BgpOpenMessage
          const asNum = openMsg.fourByteAs ?? openMsg.myAs
          result.push({
            timestamp: packet.timestamp,
            srcIp: packet.srcIp,
            dstIp: packet.dstIp,
            peerIp,
            type: 'OPEN',
            detail: `AS${asNum} Hold=${openMsg.holdTime}s`,
            packetIndex: index,
          })
        } else if (msg.type === 'UPDATE') {
          const { announced, withdrawn } = countUpdatePrefixes(msg as BgpUpdateMessage)
          const eor = endOfRibMarker(msg as BgpUpdateMessage)
          const parts = []
          if (announced > 0) parts.push(`${announced} announced`)
          if (withdrawn > 0) parts.push(`${withdrawn} withdrawn`)
          result.push({
            timestamp: packet.timestamp,
            srcIp: packet.srcIp,
            dstIp: packet.dstIp,
            peerIp,
            type: 'UPDATE',
            detail: eor ? `End-of-RIB (${eor})` : parts.join(', ') || 'empty',
            packetIndex: index,
          })
        } else if (msg.type === 'KEEPALIVE' || msg.type === 'ROUTE_REFRESH') {
          result.push({
            timestamp: packet.timestamp,
            srcIp: packet.srcIp,
            dstIp: packet.dstIp,
            peerIp,
            type: msg.type,
            detail: msg.type === 'ROUTE_REFRESH' ? `${msg.afiName}/${msg.safiName}` : '',
            packetIndex: index,
          })
        } else if (msg.type === 'NOTIFICATION') {
          const notif = msg as BgpNotificationMessage
          result.push({
            timestamp: packet.timestamp,
            srcIp: packet.srcIp,
            dstIp: packet.dstIp,
            peerIp,
            type: 'NOTIFICATION',
            detail: `${notif.errorCodeName}: ${notif.errorSubcodeName}`,
            packetIndex: index,
          })
        }
      }
    })

    return result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  }, [selectedIps, packets])

  // With a session selected, the list is that session's alone: one list with
  // the Δ column, rather than the router-wide list plus a second, narrower
  // timeline underneath it that said the same thing with less.
  const visibleSessionMessages = useMemo(
    () =>
      sessionMessages.filter(
        (m) =>
          (!selectedPeer || m.peerIp === selectedPeer) &&
          (messageScope === 'all' || SESSION_EVENT_TYPES.has(m.type))
      ),
    [sessionMessages, messageScope, selectedPeer]
  )
  const sessionMessageTotal = useMemo(
    () => (selectedPeer ? sessionMessages.filter((m) => m.peerIp === selectedPeer).length : sessionMessages.length),
    [sessionMessages, selectedPeer]
  )

  // Get prefixes announced by selected router
  const announcedPrefixes = useMemo(() => {
    if (selectedIps.length === 0) return []

    const prefixSet = new Set<string>()

    for (const packet of packets) {
      // Only count prefixes sent by this router
      if (!selectedIps.includes(packet.srcIp)) continue

      for (const msg of packet.messages) {
        if (msg.type === 'UPDATE') {
          const update = msg as BgpUpdateMessage
          // IPv4 NLRI
          if (update.nlri) {
            for (const p of update.nlri) {
              prefixSet.add(`${p.prefix}/${p.length}`)
            }
          }
          // MP_REACH_NLRI (IPv6, etc.)
          if (update.pathAttributes) {
            for (const attr of update.pathAttributes) {
              if (attr.parsed?.type === 'MP_REACH_NLRI' && attr.parsed.nlri) {
                for (const p of attr.parsed.nlri) {
                  prefixSet.add(`${p.prefix}/${p.length}`)
                }
              }
            }
          }
        }
      }
    }

    return Array.from(prefixSet).sort()
  }, [selectedIps, packets])

  /** This router's address on the selected session, for the breadcrumb. */
  const selectedLocalIp = useMemo(() => {
    if (!selectedPeer) return null
    for (const packet of packets) {
      if (selectedIps.includes(packet.srcIp) && packet.dstIp === selectedPeer) return packet.srcIp
      if (packet.srcIp === selectedPeer && selectedIps.includes(packet.dstIp)) return packet.dstIp
    }
    return selectedIps[0] ?? null
  }, [selectedIps, selectedPeer, packets])

  // Get OPEN comparison data
  const openComparison = useMemo(() => {
    if (selectedIps.length === 0 || !selectedPeer) return null

    let localOpen: BgpOpenMessage | null = null
    let remoteOpen: BgpOpenMessage | null = null

    for (const packet of packets) {
      if (selectedIps.includes(packet.srcIp) && packet.dstIp === selectedPeer) {
        for (const msg of packet.messages) {
          if (msg.type === 'OPEN') {
            localOpen = msg as BgpOpenMessage
          }
        }
      }
      if (packet.srcIp === selectedPeer && selectedIps.includes(packet.dstIp)) {
        for (const msg of packet.messages) {
          if (msg.type === 'OPEN') {
            remoteOpen = msg as BgpOpenMessage
          }
        }
      }
    }

    if (!localOpen && !remoteOpen) return null

    return { local: localOpen, remote: remoteOpen }
  }, [selectedIps, selectedPeer, packets])

  // Get prefix activity
  const prefixActivity = useMemo(() => {
    if (selectedIps.length === 0 || !selectedPeer) return null

    let announced = 0
    let withdrawn = 0

    for (const packet of packets) {
      if (!selectedIps.includes(packet.srcIp) || packet.dstIp !== selectedPeer) continue

      for (const msg of packet.messages) {
        if (msg.type === 'UPDATE') {
          const update = msg as BgpUpdateMessage
          announced += update.nlri?.length || 0
          withdrawn += update.withdrawnRoutes?.length || 0

          // Count MP_REACH_NLRI and MP_UNREACH_NLRI
          for (const attr of update.pathAttributes || []) {
            if (attr.parsed?.type === 'MP_REACH_NLRI') {
              announced += attr.parsed.nlri?.length || 0
            }
            if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
              withdrawn += attr.parsed.withdrawnRoutes?.length || 0
            }
          }
        }
      }
    }

    return { announced, withdrawn, netChange: announced - withdrawn }
  }, [selectedIps, selectedPeer, packets])

  // Build filter for current router/peer selection
  const buildFilter = useCallback(() => {
    if (selectedIps.length === 0) return null

    if (selectedPeer) {
      // Find the actual IP that communicated with this peer
      let localIp: string | null = null
      for (const packet of packets) {
        if (selectedIps.includes(packet.srcIp) && packet.dstIp === selectedPeer) {
          localIp = packet.srcIp
          break
        }
        if (packet.srcIp === selectedPeer && selectedIps.includes(packet.dstIp)) {
          localIp = packet.dstIp
          break
        }
      }
      const ip = localIp || selectedIps[0]
      // Show conversation between the actual communicating IPs
      return `(src=${ip} and dst=${selectedPeer}) or (src=${selectedPeer} and dst=${ip})`
    } else {
      // Show all messages involving any of this router's IPs
      if (selectedIps.length === 1) {
        return `src=${selectedIps[0]} or dst=${selectedIps[0]}`
      } else {
        return selectedIps.map(ip => `src=${ip} or dst=${ip}`).join(' or ')
      }
    }
  }, [selectedIps, selectedPeer, packets])

  const handleViewMessages = () => {
    const filter = buildFilter()
    if (!filter) return
    navigate(`/messages?filter=${encodeURIComponent(filter)}`)
  }

  // Navigate to messages with a specific peer filter and highlight a packet
  const handleViewEventAtIndex = (peerIp: string, packetIndex: number) => {
    if (selectedIps.length === 0) return
    // Find the actual IP that communicated with this peer
    let localIp: string | null = null
    for (const packet of packets) {
      if (selectedIps.includes(packet.srcIp) && packet.dstIp === peerIp) {
        localIp = packet.srcIp
        break
      }
      if (packet.srcIp === peerIp && selectedIps.includes(packet.dstIp)) {
        localIp = packet.dstIp
        break
      }
    }
    const ip = localIp || selectedIps[0]
    const filter = `(src=${ip} and dst=${peerIp}) or (src=${peerIp} and dst=${ip})`
    navigate(`/messages?filter=${encodeURIComponent(filter)}&selected=${packetIndex}`)
  }

  const handleViewRoutes = () => {
    // Carry the router's addresses across, so the routes screen opens on what
    // this peer announced rather than on everything in the capture.
    const peer = selectedIps.join(',')
    navigate(peer ? `/routes?peer=${encodeURIComponent(peer)}` : '/routes')
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-canvas">
      {/* Header */}
      <div className="p-4 bg-surface border-b border-hair">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">👥</span>
            <h1 className="text-lg font-semibold text-strong">Neighbors Overview</h1>
          </div>
          <span className="text-sm text-muted">{routers.length} routers detected</span>
        </div>

        {/* Search and Filter */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by IP, Router ID, or AS number..."
              className="w-full px-3 py-2 border border-hair rounded-lg text-sm focus:ring-2 focus:ring-accent focus:border-accent"
            />
          </div>
          <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1">
            <span className="shrink-0 text-xs text-muted">Filter:</span>
            {(['all', 'alerts', 'open', 'inactive'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`shrink-0 px-3 py-1.5 text-xs rounded transition-colors ${
                  filterType === type
                    ? 'bg-accent text-accent-fg'
                    : 'bg-surface-sunken text-muted hover:bg-surface-raised'
                }`}
              >
                {type === 'all' ? 'All' :
                 type === 'alerts' ? 'With NOTIFICATION' :
                 type === 'open' ? 'OPEN Received' : 'Low Activity'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Content - stacked when there is no room for two columns */}
      <div ref={split.containerRef} className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Router List */}
        {showList && (
        <div
          className="w-full flex-1 lg:flex-none bg-surface flex flex-col min-h-0"
          style={isCompact ? undefined : { width: `${split.percent}%` }}
        >
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken sticky top-0">
                <tr className="text-left text-muted">
                  <th className="px-4 py-2 font-medium">Router ID / IP</th>
                  <th className="px-4 py-2 font-medium">AS</th>
                  <th className="px-4 py-2 font-medium text-right" title="Messages sent by this router (the detail pane's Message Summary counts both directions)">Sent</th>
                  <th className="px-4 py-2 font-medium">Message Types</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hair">
                {filteredRouters.map((router) => (
                  <tr
                    key={router.routerId}
                    onClick={() => setSelectedRouter(router.routerId)}
                    className={`cursor-pointer hover:bg-surface-sunken ${
                      selectedRouter === router.routerId ? 'bg-accent-subtle' : ''
                    }`}
                  >
                    <td className="px-4 py-2">
                      <div className="font-mono text-strong">{router.displayName}</div>
                      {router.ips.length > 1 && (
                        <div className="text-xs text-muted">
                          {router.ips.length} IPs
                        </div>
                      )}
                      {router.ips.length === 1 && router.displayName !== router.ips[0] && (
                        <div className="text-xs text-muted">{router.ips[0]}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-muted">
                      {router.asNumber || '-'}
                    </td>
                    <td className="px-4 py-2 text-right text-muted">
                      {router.totalMessages}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5 text-xs flex-wrap">
                        {router.messageCounts.open > 0 && (
                          <span className="text-bgp-open bg-bgp-open/10 px-1.5 py-0.5 rounded">
                            OPEN:{router.messageCounts.open}
                          </span>
                        )}
                        {router.messageCounts.update > 0 && (
                          <span className="text-bgp-update bg-bgp-update/10 px-1.5 py-0.5 rounded">
                            UPDATE:{router.messageCounts.update}
                          </span>
                        )}
                        {router.messageCounts.notification > 0 && (
                          <span className="text-bgp-notification bg-bgp-notification/10 px-1.5 py-0.5 rounded">
                            NOTIFICATION:{router.messageCounts.notification}
                          </span>
                        )}
                        {router.messageCounts.keepalive > 0 && (
                          <span className="text-bgp-keepalive bg-bgp-keepalive/10 px-1.5 py-0.5 rounded">
                            KEEPALIVE:{router.messageCounts.keepalive}
                          </span>
                        )}
                        {router.messageCounts.routeRefresh > 0 && (
                          <span className="text-bgp-route-refresh bg-bgp-route-refresh/10 px-1.5 py-0.5 rounded">
                            REFRESH:{router.messageCounts.routeRefresh}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredRouters.length === 0 && (
              <div className="text-center text-dim py-8">
                No routers found
              </div>
            )}
          </div>
        </div>

        )}

        {!isCompact && (
          <PaneDivider
            isDragging={split.isDragging}
            onDragStart={split.startDrag}
            onReset={split.reset}
            onNudge={split.nudge}
            label="Resize the router list"
          />
        )}

        {/* Detail Panel */}
        {showDetail && (
        <div className="flex-1 overflow-auto p-4">
          {isCompact && selectedRouterInfo && (
            <div className="mb-3">
              <BackToList onClick={() => setSelectedRouter(null)} label="Back to routers" />
            </div>
          )}
          {selectedRouterInfo ? (
            <div className="space-y-4">
              {/* Router Detail Header — the breadcrumb takes its place once a
                  session is selected. */}
              {!selectedPeer && (
                <div className="bg-surface rounded-lg shadow-sm border border-hair p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-semibold text-strong">
                        {selectedRouterInfo.displayName}
                        {selectedRouterInfo.asNumber && (
                          <span className="ml-2 text-muted font-normal">
                            (AS{selectedRouterInfo.asNumber})
                          </span>
                        )}
                      </h2>
                      {selectedRouterInfo.ips.length > 0 && (
                        <div className="text-sm text-muted">
                          IPs: {selectedRouterInfo.ips.join(', ')}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setSelectedRouter(null)}
                      className="text-dim hover:text-strong"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}

              {selectedPeer ? (
                <>
                  {/* A session is selected: what it was selected for comes
                      first — the OPEN comparison, the prefixes it carried and
                      its messages — instead of being appended below the
                      router overview where nothing on screen changed. */}
                  <nav
                    aria-label="Breadcrumb"
                    className="bg-surface rounded-lg shadow-sm border border-hair px-4 py-2 flex items-center gap-2 text-sm flex-wrap"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedPeer(null)}
                      className="text-accent hover:text-accent-hover"
                    >
                      ← Router overview
                    </button>
                    <span className="text-dim">/</span>
                    <span className="text-muted">
                      {selectedRouterInfo.displayName}
                      {selectedRouterInfo.asNumber && ` (AS${selectedRouterInfo.asNumber})`}
                    </span>
                    <span className="text-dim">/</span>
                    <span className="font-mono font-medium text-strong" aria-current="page">
                      {selectedLocalIp} ↔ {selectedPeer}
                    </span>
                  </nav>

              {/* OPEN Comparison / Capability diff */}
              {openComparison && (
                <div className="bg-surface rounded-lg shadow-sm border border-hair">
                  <div className="px-4 py-2 border-b border-hair bg-surface-sunken">
                    <span className="text-sm font-medium text-strong">
                      🔍 Capability Diff
                    </span>
                  </div>
                  <div className="p-4">
                    <CapabilityDiff
                      localLabel={selectedRouterInfo?.displayName || ''}
                      remoteLabel={selectedPeer!}
                      localOpen={openComparison.local}
                      remoteOpen={openComparison.remote}
                    />
                  </div>
                </div>
              )}

              {/* Prefix Activity */}
              {prefixActivity && (
                <div className="bg-surface rounded-lg shadow-sm border border-hair">
                  <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between">
                    <span className="text-sm font-medium text-strong">
                      📈 Prefix Activity ({selectedRouterInfo?.displayName} → {selectedPeer})
                    </span>
                    <button
                      onClick={handleViewRoutes}
                      className="text-xs text-accent hover:text-accent-hover"
                    >
                      View Route Details →
                    </button>
                  </div>
                  <div className="p-4 grid grid-cols-4 gap-4 text-center">
                    <div>
                      <div className="text-2xl font-bold text-ok">{prefixActivity.announced}</div>
                      <div className="text-xs text-muted">Announced</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-critical">{prefixActivity.withdrawn}</div>
                      <div className="text-xs text-muted">Withdrawn</div>
                    </div>
                    <div>
                      <div className={`text-2xl font-bold ${prefixActivity.netChange >= 0 ? 'text-ok' : 'text-critical'}`}>
                        {prefixActivity.netChange >= 0 ? '+' : ''}{prefixActivity.netChange}
                      </div>
                      <div className="text-xs text-muted">Net Change</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-strong">
                        {Math.max(0, prefixActivity.netChange)}
                      </div>
                      <div className="text-xs text-muted">Est. Prefixes</div>
                    </div>
                  </div>
                </div>
              )}
              {/* Session Messages (OPEN/NOTIFICATION) */}
              {sessionMessageTotal > 0 && (
                <div className="bg-surface rounded-lg shadow-sm border border-hair">
                  <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-strong">
                      📋 Session Messages ({visibleSessionMessages.length})
                    </span>
                    <div className="flex items-center gap-1 text-xs">
                      {(['events', 'all'] as const).map((scope) => (
                        <button
                          key={scope}
                          onClick={() => setMessageScope(scope)}
                          className={`px-2 py-0.5 rounded ${
                            messageScope === scope
                              ? 'bg-accent text-accent-fg'
                              : 'text-muted hover:bg-surface-raised'
                          }`}
                        >
                          {scope === 'events' ? 'OPEN / NOTIFICATION' : `All (${sessionMessageTotal})`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className={`divide-y divide-hair overflow-auto ${selectedPeer ? 'max-h-96' : 'max-h-48'}`}>
                    {visibleSessionMessages.map((msg, idx, rows) => (
                      <div
                        key={idx}
                        onClick={() => handleViewEventAtIndex(msg.peerIp, msg.packetIndex)}
                        className={`px-4 py-2 cursor-pointer hover:bg-surface-sunken ${
                          MESSAGE_ROW_TINT[msg.type] ?? ''
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            MESSAGE_BADGE[msg.type] ?? 'bg-surface-sunken text-muted'
                          }`}>
                            {msg.type}
                          </span>
                          <span className="font-mono text-xs text-muted">
                            {msg.srcIp} → {msg.dstIp}
                          </span>
                          <span className="text-xs text-dim">
                            {formatTimeOfDayUtc(msg.timestamp)}
                          </span>
                          {idx > 0 && (
                            <span
                              className="text-xs text-dim font-mono"
                              title="Time since the previous message shown"
                            >
                              {formatDelta(
                                msg.timestamp.getTime() - rows[idx - 1].timestamp.getTime()
                              )}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted mt-1 ml-14">
                          {msg.detail}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

                </>
              ) : (
                <>
              {/* Message Summary & Sessions */}
              <div className="grid grid-cols-2 gap-4">
                {/* Message Summary */}
                <div className="bg-surface rounded-lg shadow-sm border border-hair">
                  <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-strong">📊 Message Summary</span>
                    {/* The overview table's "Msgs" counts what this router sent;
                        this panel counts both directions of its sessions. Same
                        router, different questions — say which one this is. */}
                    <span className="text-xs text-muted">sent + received</span>
                  </div>
                  <div className="p-4">
                    {messageSummary && (
                      <table className="w-full text-sm">
                        <tbody>
                          {Object.entries(messageSummary).map(([type, count]) => (
                            <tr key={type} className="border-b border-hair last:border-0">
                              <td className="py-1 text-muted">{MESSAGE_TYPE_LABELS[type] ?? type.toUpperCase()}</td>
                              <td className="py-1 text-right font-mono">{count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                {/* Sessions */}
                <div className="bg-surface rounded-lg shadow-sm border border-hair">
                  <div className="px-4 py-2 border-b border-hair bg-surface-sunken">
                    <span className="text-sm font-medium text-strong">🔗 Sessions</span>
                  </div>
                  <div className="divide-y divide-hair max-h-48 overflow-auto">
                    {sessions.map((session) => {
                      // Find the local IP that communicates with this peer
                      const localIp = selectedIps.find(ip => {
                        return packets.some(p =>
                          (p.srcIp === ip && p.dstIp === session.peerIp) ||
                          (p.srcIp === session.peerIp && p.dstIp === ip)
                        )
                      }) || selectedIps[0]

                      return (
                        <div
                          key={session.peerIp}
                          onClick={() => setSelectedPeer(session.peerIp)}
                          className={`px-4 py-2 cursor-pointer hover:bg-surface-sunken flex items-center justify-between ${
                            selectedPeer === session.peerIp ? 'bg-accent-subtle' : ''
                          }`}
                        >
                          <span className="font-mono text-xs text-muted">
                            {localIp} ↔ {session.peerIp}
                          </span>
                          <div className="flex items-center gap-2">
                            {(() => {
                              const state = sessionStates.get([localIp, session.peerIp].sort().join('|'))
                              if (!state) return null
                              return (
                                <span
                                  className={`text-xs px-1.5 py-0.5 rounded ${SESSION_STATE_STYLE[state]}`}
                                  title="State when the capture ended"
                                >
                                  {state}
                                </span>
                              )
                            })()}
                            <span className="text-xs text-muted">{session.messageCount} msgs</span>
                            {session.hasNotification && <span className="text-critical">⚠</span>}
                          </div>
                        </div>
                      )
                    })}
                    {sessions.length === 0 && (
                      <div className="px-4 py-4 text-center text-dim text-sm">
                        No sessions found
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Session Messages (OPEN/NOTIFICATION) */}
              {sessionMessageTotal > 0 && (
                <div className="bg-surface rounded-lg shadow-sm border border-hair">
                  <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-strong">
                      📋 Session Messages ({visibleSessionMessages.length})
                    </span>
                    <div className="flex items-center gap-1 text-xs">
                      {(['events', 'all'] as const).map((scope) => (
                        <button
                          key={scope}
                          onClick={() => setMessageScope(scope)}
                          className={`px-2 py-0.5 rounded ${
                            messageScope === scope
                              ? 'bg-accent text-accent-fg'
                              : 'text-muted hover:bg-surface-raised'
                          }`}
                        >
                          {scope === 'events' ? 'OPEN / NOTIFICATION' : `All (${sessionMessageTotal})`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className={`divide-y divide-hair overflow-auto ${selectedPeer ? 'max-h-96' : 'max-h-48'}`}>
                    {visibleSessionMessages.map((msg, idx, rows) => (
                      <div
                        key={idx}
                        onClick={() => handleViewEventAtIndex(msg.peerIp, msg.packetIndex)}
                        className={`px-4 py-2 cursor-pointer hover:bg-surface-sunken ${
                          MESSAGE_ROW_TINT[msg.type] ?? ''
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            MESSAGE_BADGE[msg.type] ?? 'bg-surface-sunken text-muted'
                          }`}>
                            {msg.type}
                          </span>
                          <span className="font-mono text-xs text-muted">
                            {msg.srcIp} → {msg.dstIp}
                          </span>
                          <span className="text-xs text-dim">
                            {formatTimeOfDayUtc(msg.timestamp)}
                          </span>
                          {idx > 0 && (
                            <span
                              className="text-xs text-dim font-mono"
                              title="Time since the previous message shown"
                            >
                              {formatDelta(
                                msg.timestamp.getTime() - rows[idx - 1].timestamp.getTime()
                              )}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted mt-1 ml-14">
                          {msg.detail}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Announced Prefixes */}
              {announcedPrefixes.length > 0 && (
                <div className="bg-surface rounded-lg shadow-sm border border-hair">
                  <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between">
                    <span className="text-sm font-medium text-strong">📡 Announced Prefixes ({announcedPrefixes.length})</span>
                    <button
                      onClick={handleViewRoutes}
                      className="text-xs text-accent hover:text-accent-hover"
                    >
                      View all routes →
                    </button>
                  </div>
                  <div className="p-2 max-h-48 overflow-auto">
                    <div className="flex flex-wrap gap-1">
                      {announcedPrefixes.slice(0, 100).map((prefix) => (
                        <button
                          key={prefix}
                          type="button"
                          onClick={() => navigate(`/routes?prefix=${encodeURIComponent(prefix)}`)}
                          title={`Open the route history of ${prefix}`}
                          className="px-2 py-0.5 bg-accent-subtle text-accent rounded text-xs font-mono hover:underline"
                        >
                          {prefix}
                        </button>
                      ))}
                      {announcedPrefixes.length > 100 && (
                        <span className="px-2 py-0.5 text-muted text-xs">
                          +{announcedPrefixes.length - 100} more
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

                </>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={handleViewMessages}
                  className="px-4 py-2 bg-accent text-accent-fg text-sm rounded-lg hover:bg-accent-hover"
                >
                  Show all messages →
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-dim">
              Select a router to view details
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
