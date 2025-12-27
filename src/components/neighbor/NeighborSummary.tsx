import { useMemo } from 'react'
import type { BgpPacket } from '../../lib/bgp/types'
import {
  extractNeighborGroups,
  getCapabilitySummary,
  getSessionLatestOpen,
  type NeighborGroup,
  type SessionInfo,
} from '../../lib/bgp'

interface NeighborSummaryProps {
  packets: BgpPacket[]
  onFilterByNeighbor?: (srcIp: string, dstIp: string) => void
}

export function NeighborSummary({ packets, onFilterByNeighbor }: NeighborSummaryProps) {
  const neighborGroups = useMemo(() => extractNeighborGroups(packets), [packets])

  if (neighborGroups.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No BGP messages found
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-auto">
      {neighborGroups.map((group) => (
        <NeighborGroupCard key={group.srcIp} group={group} onFilter={onFilterByNeighbor} />
      ))}
    </div>
  )
}

function NeighborGroupCard({
  group,
  onFilter,
}: {
  group: NeighborGroup
  onFilter?: (srcIp: string, dstIp: string) => void
}) {
  const totalMessages = group.sessions.reduce((sum, s) => {
    return (
      sum +
      s.messageCount.open +
      s.messageCount.update +
      s.messageCount.notification +
      s.messageCount.keepalive +
      s.messageCount.routeRefresh
    )
  }, 0)

  const hasError = group.sessions.some((s) => s.hasNotification)

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* Header: Source IP */}
      <div
        className={`px-4 py-2 flex items-center justify-between ${
          hasError ? 'bg-red-50 border-b border-red-200' : 'bg-gray-50 border-b border-gray-200'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium text-sm">{group.srcIp}</span>
          <span className="text-xs text-gray-500">
            → {group.sessions.length} peer{group.sessions.length > 1 ? 's' : ''}
          </span>
        </div>
        <span className="text-xs text-gray-500">{totalMessages} msgs</span>
      </div>

      {/* Sessions */}
      <div className="divide-y divide-gray-100">
        {group.sessions.map((session) => (
          <SessionCard key={session.dstIp} session={session} onFilter={onFilter} />
        ))}
      </div>
    </div>
  )
}

function SessionCard({
  session,
  onFilter,
}: {
  session: SessionInfo
  onFilter?: (srcIp: string, dstIp: string) => void
}) {
  const latestOpen = getSessionLatestOpen(session)
  const capabilities = latestOpen ? getCapabilitySummary(latestOpen.capabilities) : []
  const totalMessages =
    session.messageCount.open +
    session.messageCount.update +
    session.messageCount.notification +
    session.messageCount.keepalive +
    session.messageCount.routeRefresh

  const handleFilterClick = () => {
    if (onFilter) {
      onFilter(session.srcIp, session.dstIp)
    }
  }

  return (
    <div className="p-3 hover:bg-gray-50">
      {/* Destination IP and Filter button */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-gray-400">→</span>
          <span className="font-mono text-sm">{session.dstIp}</span>
          {session.hasNotification && (
            <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">Error</span>
          )}
          {onFilter && (
            <button
              onClick={handleFilterClick}
              className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
              title="Filter packets for this session"
            >
              Filter
            </button>
          )}
        </div>
        <span className="text-xs text-gray-400">{totalMessages} msgs</span>
      </div>

      {/* OPEN info */}
      {latestOpen && (
        <div className="ml-5 space-y-1">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>
              <span className="text-gray-500">AS:</span>{' '}
              <span className="font-mono">{latestOpen.asNumber}</span>
            </span>
            <span>
              <span className="text-gray-500">Router ID:</span>{' '}
              <span className="font-mono">{latestOpen.routerId}</span>
            </span>
            <span>
              <span className="text-gray-500">Hold:</span>{' '}
              <span className="font-mono">{latestOpen.holdTime}s</span>
            </span>
          </div>

          {/* Capabilities */}
          {capabilities.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {capabilities.map((cap, i) => (
                <span key={i} className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">
                  {cap}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Message counts */}
      <div className="ml-5 mt-2 flex gap-3 text-xs">
        {session.messageCount.open > 0 && (
          <span>
            <span className="text-bgp-open font-medium">{session.messageCount.open}</span>
            <span className="text-gray-400 ml-0.5">OPEN</span>
          </span>
        )}
        {session.messageCount.update > 0 && (
          <span>
            <span className="text-bgp-update font-medium">{session.messageCount.update}</span>
            <span className="text-gray-400 ml-0.5">UPD</span>
          </span>
        )}
        {session.messageCount.keepalive > 0 && (
          <span>
            <span className="text-bgp-keepalive font-medium">{session.messageCount.keepalive}</span>
            <span className="text-gray-400 ml-0.5">KA</span>
          </span>
        )}
        {session.messageCount.notification > 0 && (
          <span>
            <span className="text-bgp-notification font-medium">{session.messageCount.notification}</span>
            <span className="text-gray-400 ml-0.5">NOTIF</span>
          </span>
        )}
        {session.messageCount.routeRefresh > 0 && (
          <span>
            <span className="text-cyan-500 font-medium">{session.messageCount.routeRefresh}</span>
            <span className="text-gray-400 ml-0.5">RR</span>
          </span>
        )}
      </div>

      {/* Notification Error */}
      {session.hasNotification && session.notificationInfo && (
        <div className="ml-5 mt-2 bg-red-50 border border-red-200 rounded p-2">
          <div className="text-xs text-red-700 font-medium">
            {session.notificationInfo.errorCode} / {session.notificationInfo.errorSubcode}
          </div>
          <div className="text-xs text-red-600 mt-1">{session.notificationInfo.hint}</div>
        </div>
      )}
    </div>
  )
}
