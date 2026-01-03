import { useState, useMemo } from 'react'
import type { BgpPacket, BgpUpdateMessage } from '../../lib/bgp/types'
import {
  extractNeighborGroups,
  getSessionLatestOpen,
  extractSessionEvents,
  getTimeRange,
  type SessionInfo,
  type SessionEvent,
} from '../../lib/bgp'

interface BgpPeersSidebarProps {
  packets: BgpPacket[]
  selectedPeer: string | null
  onSelectPeer: (peer: string | null) => void
  onEventClick?: (event: SessionEvent) => void
}

interface PeerStats {
  ip: string
  sessions: SessionInfo[]
  state: 'Established' | 'OpenSent' | 'Connect' | 'Idle'
  ipv4Routes: number
  ipv6Routes: number
  hasError: boolean
  events: SessionEvent[]
}

export function BgpPeersSidebar({ packets, selectedPeer, onSelectPeer, onEventClick }: BgpPeersSidebarProps) {
  const [expandedPeers, setExpandedPeers] = useState<Set<string>>(new Set())

  // Extract all session events once
  const allEvents = useMemo(() => extractSessionEvents(packets), [packets])
  const globalTimeRange = useMemo(() => getTimeRange(allEvents), [allEvents])

  const peers = useMemo(() => {
    const groups = extractNeighborGroups(packets)

    // Combine forward and reverse sessions to understand peer state
    const peerMap = new Map<string, PeerStats>()

    for (const group of groups) {
      for (const session of group.sessions) {
        // For each unique peer IP (both src and dst), track their state
        const peerIp = session.srcIp

        if (!peerMap.has(peerIp)) {
          peerMap.set(peerIp, {
            ip: peerIp,
            sessions: [],
            state: 'Idle',
            ipv4Routes: 0,
            ipv6Routes: 0,
            hasError: false,
            events: [],
          })
        }

        const peer = peerMap.get(peerIp)!
        peer.sessions.push(session)

        // Calculate state
        const latestOpen = getSessionLatestOpen(session)
        if (session.hasNotification) {
          peer.hasError = true
          peer.state = 'Idle'
        } else if (latestOpen && session.messageCount.keepalive > 0) {
          peer.state = 'Established'
        } else if (latestOpen) {
          peer.state = 'OpenSent'
        } else if (session.messageCount.open > 0 || session.messageCount.keepalive > 0) {
          peer.state = 'Connect'
        }

        // Count routes from UPDATE messages
        const routeCounts = countRoutes(packets, session.srcIp)
        peer.ipv4Routes = routeCounts.ipv4
        peer.ipv6Routes = routeCounts.ipv6
      }
    }

    // Add events for each peer
    for (const peer of peerMap.values()) {
      peer.events = allEvents.filter(e => e.srcIp === peer.ip || e.dstIp === peer.ip)
    }

    return Array.from(peerMap.values()).sort((a, b) => {
      // Sort: Established first, then by IP
      if (a.state === 'Established' && b.state !== 'Established') return -1
      if (a.state !== 'Established' && b.state === 'Established') return 1
      return a.ip.localeCompare(b.ip)
    })
  }, [packets, allEvents])

  const toggleExpand = (ip: string) => {
    setExpandedPeers((prev) => {
      const next = new Set(prev)
      if (next.has(ip)) {
        next.delete(ip)
      } else {
        next.add(ip)
      }
      return next
    })
  }

  const handlePeerClick = (ip: string) => {
    if (selectedPeer === ip) {
      onSelectPeer(null)
    } else {
      onSelectPeer(ip)
    }
  }

  return (
    <div className="h-full flex flex-col bg-white border-r border-gray-200">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-700">BGP Peers</h2>
      </div>

      {/* Peer List */}
      <div className="flex-1 overflow-auto">
        {peers.length === 0 ? (
          <div className="p-4 text-sm text-gray-400 text-center">
            No BGP peers found
          </div>
        ) : (
          <div className="py-1">
            {peers.map((peer) => (
              <PeerItem
                key={peer.ip}
                peer={peer}
                isSelected={selectedPeer === peer.ip}
                isExpanded={expandedPeers.has(peer.ip)}
                onToggleExpand={() => toggleExpand(peer.ip)}
                onClick={() => handlePeerClick(peer.ip)}
                globalTimeRange={globalTimeRange}
                onEventClick={onEventClick}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PeerItem({
  peer,
  isSelected,
  isExpanded,
  onToggleExpand,
  onClick,
  globalTimeRange,
  onEventClick,
}: {
  peer: PeerStats
  isSelected: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  onClick: () => void
  globalTimeRange: { start: Date; end: Date } | null
  onEventClick?: (event: SessionEvent) => void
}) {
  return (
    <div className={`${isSelected ? 'bg-blue-50' : ''}`}>
      {/* Main row */}
      <div
        className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 ${
          isSelected ? 'bg-blue-500 text-white hover:bg-blue-600' : ''
        }`}
        onClick={onClick}
      >
        {/* Status icon */}
        <div className={`w-5 h-5 flex items-center justify-center`}>
          <StateIcon state={peer.state} isSelected={isSelected} />
        </div>

        {/* IP Address */}
        <span className={`flex-1 font-mono text-sm ${isSelected ? 'text-white' : 'text-gray-800'}`}>
          {peer.ip}
        </span>

        {/* Expand button */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          className={`p-1 rounded hover:bg-opacity-20 hover:bg-gray-500 ${
            isSelected ? 'text-white' : 'text-gray-400'
          }`}
        >
          <svg
            className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div className={`px-4 py-2 ${isSelected ? 'bg-blue-100' : 'bg-gray-50'} border-b border-gray-200`}>
          {/* State */}
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`w-2 h-2 rounded-full ${
                peer.state === 'Established'
                  ? 'bg-green-500'
                  : peer.state === 'OpenSent'
                    ? 'bg-yellow-500'
                    : peer.state === 'Connect'
                      ? 'bg-blue-500'
                      : 'bg-red-500'
              }`}
            />
            <span className={`text-xs ${peer.hasError ? 'text-red-600' : 'text-gray-600'}`}>
              {peer.state}
            </span>
          </div>

          {/* Mini timeline */}
          {globalTimeRange && peer.events.length > 0 && (
            <MiniTimeline events={peer.events} globalTimeRange={globalTimeRange} onEventClick={onEventClick} />
          )}

          {/* Route counts */}
          {peer.ipv4Routes > 0 && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              IPv4 Routes: {peer.ipv4Routes}
            </div>
          )}
          {peer.ipv6Routes > 0 && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              IPv6 Routes: {peer.ipv6Routes}
            </div>
          )}
          {peer.ipv4Routes === 0 && peer.ipv6Routes === 0 && (
            <div className="text-xs text-gray-400">No routes</div>
          )}
        </div>
      )}
    </div>
  )
}

function StateIcon({ state, isSelected }: { state: PeerStats['state']; isSelected: boolean }) {
  const colorClass = isSelected
    ? 'text-white'
    : state === 'Established'
      ? 'text-green-500'
      : state === 'Idle'
        ? 'text-red-500'
        : 'text-yellow-500'

  if (state === 'Established') {
    return (
      <svg className={`w-4 h-4 ${colorClass}`} fill="currentColor" viewBox="0 0 20 20">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clipRule="evenodd"
        />
      </svg>
    )
  }

  return (
    <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  )
}

function MiniTimeline({
  events,
  globalTimeRange,
  onEventClick,
}: {
  events: SessionEvent[]
  globalTimeRange: { start: Date; end: Date }
  onEventClick?: (event: SessionEvent) => void
}) {
  const duration = globalTimeRange.end.getTime() - globalTimeRange.start.getTime()
  const padding = duration * 0.05
  const startTime = globalTimeRange.start.getTime() - padding
  const totalDuration = duration + padding * 2

  const getXPosition = (timestamp: Date): number => {
    return ((timestamp.getTime() - startTime) / totalDuration) * 100
  }

  const getEventColor = (eventType: string): string => {
    switch (eventType) {
      case 'OPEN_SENT':
      case 'OPEN_RECEIVED':
        return 'bg-blue-500'
      case 'KEEPALIVE':
        return 'bg-green-500'
      case 'NOTIFICATION':
        return 'bg-red-500'
      case 'UPDATE':
        return 'bg-purple-500'
      default:
        return 'bg-gray-500'
    }
  }

  // Build state segments
  const segments: Array<{
    startPct: number
    endPct: number
    state: string
  }> = []

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const nextEvent = events[i + 1]

    const startPct = getXPosition(event.timestamp)
    const endPct = nextEvent
      ? getXPosition(nextEvent.timestamp)
      : Math.min(startPct + 5, 100)

    if (event.state !== 'Idle') {
      segments.push({
        startPct,
        endPct,
        state: event.state,
      })
    }
  }

  const getStateColor = (state: string): string => {
    switch (state) {
      case 'Established':
        return 'bg-green-400'
      case 'OpenSent':
      case 'OpenConfirm':
        return 'bg-yellow-400'
      case 'Down':
        return 'bg-red-400'
      default:
        return 'bg-gray-300'
    }
  }

  return (
    <div className="mb-2">
      <div className="text-xs text-gray-500 mb-1">Timeline</div>
      <div className="relative h-3 bg-gray-200 rounded overflow-hidden">
        {/* State segments */}
        {segments.map((seg, idx) => (
          <div
            key={idx}
            className={`absolute top-0 bottom-0 ${getStateColor(seg.state)} opacity-60`}
            style={{
              left: `${seg.startPct}%`,
              width: `${Math.max(seg.endPct - seg.startPct, 1)}%`,
            }}
          />
        ))}

        {/* Event markers */}
        {events.map((event, idx) => (
          <div
            key={idx}
            className={`absolute top-0 w-1 h-3 ${getEventColor(event.eventType)} ${onEventClick ? 'cursor-pointer hover:scale-150 transition-transform' : ''}`}
            style={{ left: `${getXPosition(event.timestamp)}%` }}
            title={`${event.eventType.replace('_', ' ')} - ${event.state}`}
            onClick={(e) => {
              e.stopPropagation()
              onEventClick?.(event)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function countRoutes(packets: BgpPacket[], srcIp: string): { ipv4: number; ipv6: number } {
  let ipv4 = 0
  let ipv6 = 0

  for (const packet of packets) {
    if (packet.srcIp !== srcIp) continue

    for (const msg of packet.messages) {
      if (msg.type !== 'UPDATE') continue
      const updateMsg = msg as BgpUpdateMessage

      // Count IPv4 NLRI
      ipv4 += updateMsg.nlri.length

      // Count IPv6 from MP_REACH_NLRI
      for (const attr of updateMsg.pathAttributes) {
        if (attr.parsed?.type === 'MP_REACH_NLRI') {
          ipv6 += attr.parsed.nlri.length
        }
      }
    }
  }

  return { ipv4, ipv6 }
}
