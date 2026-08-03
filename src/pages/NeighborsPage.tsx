import { useState, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import type { BgpMessage, BgpOpenMessage, BgpUpdateMessage, BgpNotificationMessage } from '../lib/bgp/types'
import { extractNeighbors, getLatestOpen, type OpenMessageRecord } from '../lib/bgp/neighbor'
import { CapabilityDiff } from '../components/neighbor'

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

interface SessionMessage {
  timestamp: Date
  srcIp: string
  dstIp: string
  type: string
  summary: string
  packetIndex: number
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
      type: 'OPEN' | 'NOTIFICATION'
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

  // Get session timeline for selected peer
  const sessionTimeline = useMemo((): SessionMessage[] => {
    if (selectedIps.length === 0 || !selectedPeer) return []

    const messages: SessionMessage[] = []

    packets.forEach((packet, index) => {
      const isOutbound = selectedIps.includes(packet.srcIp) && packet.dstIp === selectedPeer
      const isInbound = packet.srcIp === selectedPeer && selectedIps.includes(packet.dstIp)

      if (!isOutbound && !isInbound) return

      for (const msg of packet.messages) {
        messages.push({
          timestamp: packet.timestamp,
          srcIp: packet.srcIp,
          dstIp: packet.dstIp,
          type: msg.type,
          summary: getMessageSummary(msg),
          packetIndex: index,
        })
      }
    })

    return messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
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

  const handleViewMessageAtIndex = (packetIndex: number) => {
    const filter = buildFilter()
    if (!filter) return
    navigate(`/messages?filter=${encodeURIComponent(filter)}&selected=${packetIndex}`)
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
    navigate(`/routes`)
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
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by IP, Router ID, or AS number..."
              className="w-full px-3 py-2 border border-hair rounded-lg text-sm focus:ring-2 focus:ring-accent focus:border-accent"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Filter:</span>
            {(['all', 'alerts', 'open', 'inactive'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-3 py-1.5 text-xs rounded transition-colors ${
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

      {/* Main Content */}
      <div className="flex-1 flex min-h-0">
        {/* Router List */}
        <div className="w-1/3 border-r border-hair bg-surface flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken sticky top-0">
                <tr className="text-left text-muted">
                  <th className="px-4 py-2 font-medium">Router ID / IP</th>
                  <th className="px-4 py-2 font-medium">AS</th>
                  <th className="px-4 py-2 font-medium text-right">Msgs</th>
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

        {/* Detail Panel */}
        <div className="flex-1 overflow-auto p-4">
          {selectedRouterInfo ? (
            <div className="space-y-4">
              {/* Router Detail Header */}
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

              {/* Message Summary & Sessions */}
              <div className="grid grid-cols-2 gap-4">
                {/* Message Summary */}
                <div className="bg-surface rounded-lg shadow-sm border border-hair">
                  <div className="px-4 py-2 border-b border-hair bg-surface-sunken">
                    <span className="text-sm font-medium text-strong">📊 Message Summary</span>
                  </div>
                  <div className="p-4">
                    {messageSummary && (
                      <table className="w-full text-sm">
                        <tbody>
                          {Object.entries(messageSummary).map(([type, count]) => (
                            <tr key={type} className="border-b border-hair last:border-0">
                              <td className="py-1 text-muted uppercase">{type}</td>
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
              {sessionMessages.length > 0 && (
                <div className="bg-surface rounded-lg shadow-sm border border-hair">
                  <div className="px-4 py-2 border-b border-hair bg-surface-sunken">
                    <span className="text-sm font-medium text-strong">📋 Session Messages ({sessionMessages.length})</span>
                  </div>
                  <div className="divide-y divide-hair max-h-48 overflow-auto">
                    {sessionMessages.map((msg, idx) => (
                      <div
                        key={idx}
                        onClick={() => handleViewEventAtIndex(msg.peerIp, msg.packetIndex)}
                        className={`px-4 py-2 cursor-pointer hover:bg-surface-sunken ${
                          msg.type === 'OPEN' ? 'bg-bgp-open/5' : 'bg-bgp-notification/5'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            msg.type === 'OPEN' ? 'bg-bgp-open/10 text-bgp-open' : 'bg-bgp-notification/10 text-bgp-notification'
                          }`}>
                            {msg.type}
                          </span>
                          <span className="font-mono text-xs text-muted">
                            {msg.srcIp} → {msg.dstIp}
                          </span>
                          <span className="text-xs text-dim">
                            {formatTime(msg.timestamp)}
                          </span>
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
                        <span
                          key={prefix}
                          className="px-2 py-0.5 bg-accent-subtle text-accent rounded text-xs font-mono"
                        >
                          {prefix}
                        </span>
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

              {/* Session Timeline (when peer selected) */}
              {selectedPeer && (
                <>
                  <div className="bg-surface rounded-lg shadow-sm border border-hair">
                    <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between">
                      <span className="text-sm font-medium text-strong">
                        📜 Session Timeline: {selectedRouterInfo?.displayName} ↔ {selectedPeer}
                      </span>
                      <button
                        onClick={handleViewMessages}
                        className="text-xs text-accent hover:text-accent-hover"
                      >
                        Show all messages →
                      </button>
                    </div>
                    <div className="max-h-64 overflow-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-surface-sunken sticky top-0">
                          <tr className="text-left text-muted">
                            <th className="px-4 py-2 font-medium w-28">Time</th>
                            <th className="px-4 py-2 font-medium">Source → Dest</th>
                            <th className="px-4 py-2 font-medium w-28">Type</th>
                            <th className="px-4 py-2 font-medium">Summary</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-hair">
                          {sessionTimeline.slice(0, 50).map((msg, idx) => (
                            <tr
                              key={idx}
                              onClick={() => handleViewMessageAtIndex(msg.packetIndex)}
                              className={`cursor-pointer hover:bg-surface-raised ${
                                msg.type === 'NOTIFICATION' ? 'bg-bgp-notification/5' :
                                msg.type === 'OPEN' ? 'bg-bgp-open/5' :
                                msg.type === 'KEEPALIVE' ? 'bg-surface-sunken' : ''
                              }`}
                            >
                              <td className="px-4 py-1.5 font-mono text-muted">
                                {formatTime(msg.timestamp)}
                              </td>
                              <td className="px-4 py-1.5 font-mono text-xs text-muted">
                                {msg.srcIp} → {msg.dstIp}
                              </td>
                              <td className="px-4 py-1.5">
                                <span className={`px-2 py-0.5 rounded text-xs ${
                                  msg.type === 'OPEN' ? 'bg-bgp-open/10 text-bgp-open' :
                                  msg.type === 'UPDATE' ? 'bg-bgp-update/10 text-bgp-update' :
                                  msg.type === 'NOTIFICATION' ? 'bg-bgp-notification/10 text-bgp-notification' :
                                  msg.type === 'KEEPALIVE' ? 'bg-bgp-keepalive/10 text-bgp-keepalive' :
                                  'bg-bgp-route-refresh/10 text-bgp-route-refresh'
                                }`}>
                                  {msg.type}
                                </span>
                              </td>
                              <td className="px-4 py-1.5 text-muted truncate max-w-xs">
                                {msg.summary}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {sessionTimeline.length > 50 && (
                        <div className="text-center text-xs text-muted py-2">
                          Showing 50 of {sessionTimeline.length} messages
                        </div>
                      )}
                    </div>
                  </div>

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
      </div>
    </div>
  )
}

function getMessageSummary(msg: BgpMessage): string {
  switch (msg.type) {
    case 'OPEN': {
      const as = msg.fourByteAs ?? msg.myAs
      return `AS${as} Hold=${msg.holdTime}`
    }
    case 'UPDATE': {
      const nlri = msg.nlri?.length || 0
      const withdrawn = msg.withdrawnRoutes?.length || 0
      return `+${nlri} prefixes, -${withdrawn} withdrawn`
    }
    case 'NOTIFICATION':
      return `${msg.errorCodeName}/${msg.errorSubcodeName}`
    case 'KEEPALIVE':
      return ''
    default:
      return ''
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}
