import { useState, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import type { BgpMessage, BgpOpenMessage, BgpUpdateMessage, BgpNotificationMessage } from '../lib/bgp/types'
import { extractNeighbors, getLatestOpen, type OpenMessageRecord } from '../lib/bgp/neighbor'

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
    <div className="flex-1 flex flex-col min-h-0 bg-gray-50">
      {/* Header */}
      <div className="p-4 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">👥</span>
            <h1 className="text-lg font-semibold text-gray-800">Neighbors Overview</h1>
          </div>
          <span className="text-sm text-gray-500">{routers.length} routers detected</span>
        </div>

        {/* Search and Filter */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by IP, Router ID, or AS number..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Filter:</span>
            {(['all', 'alerts', 'open', 'inactive'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-3 py-1.5 text-xs rounded transition-colors ${
                  filterType === type
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
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
        <div className="w-1/3 border-r border-gray-200 bg-white flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr className="text-left text-gray-600">
                  <th className="px-4 py-2 font-medium">Router ID / IP</th>
                  <th className="px-4 py-2 font-medium">AS</th>
                  <th className="px-4 py-2 font-medium text-right">Msgs</th>
                  <th className="px-4 py-2 font-medium">Message Types</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredRouters.map((router) => (
                  <tr
                    key={router.routerId}
                    onClick={() => setSelectedRouter(router.routerId)}
                    className={`cursor-pointer hover:bg-gray-50 ${
                      selectedRouter === router.routerId ? 'bg-blue-50' : ''
                    }`}
                  >
                    <td className="px-4 py-2">
                      <div className="font-mono text-gray-800">{router.displayName}</div>
                      {router.ips.length > 1 && (
                        <div className="text-xs text-gray-500">
                          {router.ips.length} IPs
                        </div>
                      )}
                      {router.ips.length === 1 && router.displayName !== router.ips[0] && (
                        <div className="text-xs text-gray-500">{router.ips[0]}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-gray-600">
                      {router.asNumber || '-'}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-600">
                      {router.totalMessages}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5 text-xs flex-wrap">
                        {router.messageCounts.open > 0 && (
                          <span className="text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                            OPEN:{router.messageCounts.open}
                          </span>
                        )}
                        {router.messageCounts.update > 0 && (
                          <span className="text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                            UPDATE:{router.messageCounts.update}
                          </span>
                        )}
                        {router.messageCounts.notification > 0 && (
                          <span className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                            NOTIFICATION:{router.messageCounts.notification}
                          </span>
                        )}
                        {router.messageCounts.keepalive > 0 && (
                          <span className="text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded">
                            KEEPALIVE:{router.messageCounts.keepalive}
                          </span>
                        )}
                        {router.messageCounts.routeRefresh > 0 && (
                          <span className="text-gray-700 bg-gray-100 px-1.5 py-0.5 rounded">
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
              <div className="text-center text-gray-400 py-8">
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
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-800">
                      {selectedRouterInfo.displayName}
                      {selectedRouterInfo.asNumber && (
                        <span className="ml-2 text-gray-500 font-normal">
                          (AS{selectedRouterInfo.asNumber})
                        </span>
                      )}
                    </h2>
                    {selectedRouterInfo.ips.length > 0 && (
                      <div className="text-sm text-gray-500">
                        IPs: {selectedRouterInfo.ips.join(', ')}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setSelectedRouter(null)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Message Summary & Sessions */}
              <div className="grid grid-cols-2 gap-4">
                {/* Message Summary */}
                <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                  <div className="px-4 py-2 border-b border-gray-200 bg-gray-50">
                    <span className="text-sm font-medium text-gray-700">📊 Message Summary</span>
                  </div>
                  <div className="p-4">
                    {messageSummary && (
                      <table className="w-full text-sm">
                        <tbody>
                          {Object.entries(messageSummary).map(([type, count]) => (
                            <tr key={type} className="border-b border-gray-100 last:border-0">
                              <td className="py-1 text-gray-600 uppercase">{type}</td>
                              <td className="py-1 text-right font-mono">{count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                {/* Sessions */}
                <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                  <div className="px-4 py-2 border-b border-gray-200 bg-gray-50">
                    <span className="text-sm font-medium text-gray-700">🔗 Sessions</span>
                  </div>
                  <div className="divide-y divide-gray-100 max-h-48 overflow-auto">
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
                          className={`px-4 py-2 cursor-pointer hover:bg-gray-50 flex items-center justify-between ${
                            selectedPeer === session.peerIp ? 'bg-blue-50' : ''
                          }`}
                        >
                          <span className="font-mono text-xs text-gray-600">
                            {localIp} ↔ {session.peerIp}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-500">{session.messageCount} msgs</span>
                            {session.hasNotification && <span className="text-red-500">⚠</span>}
                          </div>
                        </div>
                      )
                    })}
                    {sessions.length === 0 && (
                      <div className="px-4 py-4 text-center text-gray-400 text-sm">
                        No sessions found
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Session Messages (OPEN/NOTIFICATION) */}
              {sessionMessages.length > 0 && (
                <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                  <div className="px-4 py-2 border-b border-gray-200 bg-gray-50">
                    <span className="text-sm font-medium text-gray-700">📋 Session Messages ({sessionMessages.length})</span>
                  </div>
                  <div className="divide-y divide-gray-100 max-h-48 overflow-auto">
                    {sessionMessages.map((msg, idx) => (
                      <div
                        key={idx}
                        onClick={() => handleViewEventAtIndex(msg.peerIp, msg.packetIndex)}
                        className={`px-4 py-2 cursor-pointer hover:bg-gray-50 ${
                          msg.type === 'OPEN' ? 'bg-blue-50/50' : 'bg-amber-50/50'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            msg.type === 'OPEN' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
                          }`}>
                            {msg.type}
                          </span>
                          <span className="font-mono text-xs text-gray-600">
                            {msg.srcIp} → {msg.dstIp}
                          </span>
                          <span className="text-xs text-gray-400">
                            {formatTime(msg.timestamp)}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 mt-1 ml-14">
                          {msg.detail}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Announced Prefixes */}
              {announcedPrefixes.length > 0 && (
                <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                  <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700">📡 Announced Prefixes ({announcedPrefixes.length})</span>
                    <button
                      onClick={handleViewRoutes}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      View all routes →
                    </button>
                  </div>
                  <div className="p-2 max-h-48 overflow-auto">
                    <div className="flex flex-wrap gap-1">
                      {announcedPrefixes.slice(0, 100).map((prefix) => (
                        <span
                          key={prefix}
                          className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-mono"
                        >
                          {prefix}
                        </span>
                      ))}
                      {announcedPrefixes.length > 100 && (
                        <span className="px-2 py-0.5 text-gray-500 text-xs">
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
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                    <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700">
                        📜 Session Timeline: {selectedRouterInfo?.displayName} ↔ {selectedPeer}
                      </span>
                      <button
                        onClick={handleViewMessages}
                        className="text-xs text-blue-600 hover:text-blue-800"
                      >
                        Show all messages →
                      </button>
                    </div>
                    <div className="max-h-64 overflow-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr className="text-left text-gray-600">
                            <th className="px-4 py-2 font-medium w-28">Time</th>
                            <th className="px-4 py-2 font-medium">Source → Dest</th>
                            <th className="px-4 py-2 font-medium w-28">Type</th>
                            <th className="px-4 py-2 font-medium">Summary</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {sessionTimeline.slice(0, 50).map((msg, idx) => (
                            <tr
                              key={idx}
                              onClick={() => handleViewMessageAtIndex(msg.packetIndex)}
                              className={`cursor-pointer hover:bg-gray-100 ${
                                msg.type === 'NOTIFICATION' ? 'bg-amber-50' :
                                msg.type === 'OPEN' ? 'bg-blue-50' :
                                msg.type === 'KEEPALIVE' ? 'bg-gray-50' : ''
                              }`}
                            >
                              <td className="px-4 py-1.5 font-mono text-gray-600">
                                {formatTime(msg.timestamp)}
                              </td>
                              <td className="px-4 py-1.5 font-mono text-xs text-gray-600">
                                {msg.srcIp} → {msg.dstIp}
                              </td>
                              <td className="px-4 py-1.5">
                                <span className={`px-2 py-0.5 rounded text-xs ${
                                  msg.type === 'OPEN' ? 'bg-blue-100 text-blue-700' :
                                  msg.type === 'UPDATE' ? 'bg-emerald-100 text-emerald-700' :
                                  msg.type === 'NOTIFICATION' ? 'bg-amber-100 text-amber-700' :
                                  msg.type === 'KEEPALIVE' ? 'bg-purple-100 text-purple-700' :
                                  'bg-gray-100 text-gray-700'
                                }`}>
                                  {msg.type}
                                </span>
                              </td>
                              <td className="px-4 py-1.5 text-gray-600 truncate max-w-xs">
                                {msg.summary}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {sessionTimeline.length > 50 && (
                        <div className="text-center text-xs text-gray-500 py-2">
                          Showing 50 of {sessionTimeline.length} messages
                        </div>
                      )}
                    </div>
                  </div>

                  {/* OPEN Comparison */}
                  {openComparison && (
                    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                      <div className="px-4 py-2 border-b border-gray-200 bg-gray-50">
                        <span className="text-sm font-medium text-gray-700">
                          🔍 OPEN Comparison
                        </span>
                      </div>
                      <div className="p-4">
                        <OpenComparisonTable
                          localIp={selectedRouterInfo?.displayName || ''}
                          remoteIp={selectedPeer!}
                          localOpen={openComparison.local}
                          remoteOpen={openComparison.remote}
                        />
                      </div>
                    </div>
                  )}

                  {/* Prefix Activity */}
                  {prefixActivity && (
                    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                      <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-700">
                          📈 Prefix Activity ({selectedRouterInfo?.displayName} → {selectedPeer})
                        </span>
                        <button
                          onClick={handleViewRoutes}
                          className="text-xs text-blue-600 hover:text-blue-800"
                        >
                          View Route Details →
                        </button>
                      </div>
                      <div className="p-4 grid grid-cols-4 gap-4 text-center">
                        <div>
                          <div className="text-2xl font-bold text-green-600">{prefixActivity.announced}</div>
                          <div className="text-xs text-gray-500">Announced</div>
                        </div>
                        <div>
                          <div className="text-2xl font-bold text-red-600">{prefixActivity.withdrawn}</div>
                          <div className="text-xs text-gray-500">Withdrawn</div>
                        </div>
                        <div>
                          <div className={`text-2xl font-bold ${prefixActivity.netChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {prefixActivity.netChange >= 0 ? '+' : ''}{prefixActivity.netChange}
                          </div>
                          <div className="text-xs text-gray-500">Net Change</div>
                        </div>
                        <div>
                          <div className="text-2xl font-bold text-gray-700">
                            {Math.max(0, prefixActivity.netChange)}
                          </div>
                          <div className="text-xs text-gray-500">Est. Prefixes</div>
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
                  className="px-4 py-2 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600"
                >
                  Show all messages →
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400">
              Select a router to view details
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function OpenComparisonTable({
  localIp,
  remoteIp,
  localOpen,
  remoteOpen,
}: {
  localIp: string
  remoteIp: string
  localOpen: BgpOpenMessage | null
  remoteOpen: BgpOpenMessage | null
}) {
  if (!localOpen && !remoteOpen) {
    return <div className="text-gray-400 text-center">No OPEN messages found</div>
  }

  const localCaps = new Set(localOpen?.capabilities.map(c => c.name) || [])
  const remoteCaps = new Set(remoteOpen?.capabilities.map(c => c.name) || [])
  const allCaps = new Set([...localCaps, ...remoteCaps])

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-200">
          <th className="text-left py-2 text-gray-600 font-medium"></th>
          <th className="text-left py-2 text-gray-600 font-medium">{localIp}</th>
          <th className="text-left py-2 text-gray-600 font-medium">{remoteIp}</th>
        </tr>
      </thead>
      <tbody>
        <tr className="border-b border-gray-100">
          <td className="py-1.5 text-gray-600">AS Number</td>
          <td className="py-1.5 font-mono">{localOpen?.fourByteAs ?? localOpen?.myAs ?? '-'}</td>
          <td className="py-1.5 font-mono">{remoteOpen?.fourByteAs ?? remoteOpen?.myAs ?? '-'}</td>
        </tr>
        <tr className="border-b border-gray-100">
          <td className="py-1.5 text-gray-600">Hold Time</td>
          <td className="py-1.5 font-mono">{localOpen?.holdTime ?? '-'}s</td>
          <td className="py-1.5 font-mono">{remoteOpen?.holdTime ?? '-'}s</td>
        </tr>
        <tr className="border-b border-gray-100">
          <td className="py-1.5 text-gray-600">Router ID</td>
          <td className="py-1.5 font-mono">{localOpen?.bgpIdentifier ?? '-'}</td>
          <td className="py-1.5 font-mono">{remoteOpen?.bgpIdentifier ?? '-'}</td>
        </tr>
        <tr>
          <td colSpan={3} className="pt-3 pb-1 text-gray-600 font-medium">Capabilities</td>
        </tr>
        {Array.from(allCaps).map((cap) => {
          const hasLocal = localCaps.has(cap)
          const hasRemote = remoteCaps.has(cap)
          const mismatch = hasLocal !== hasRemote

          return (
            <tr key={cap} className="border-b border-gray-100">
              <td className="py-1.5 text-gray-600">{cap}</td>
              <td className={`py-1.5 ${mismatch ? 'text-amber-600' : ''}`}>
                {hasLocal ? '✓' : '✗'}
              </td>
              <td className={`py-1.5 ${mismatch ? 'text-amber-600' : ''}`}>
                {hasRemote ? '✓' : '✗'}
                {mismatch && ' ⚠'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
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
