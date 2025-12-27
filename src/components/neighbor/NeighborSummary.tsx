import { useMemo, useState } from 'react'
import type { BgpPacket } from '../../lib/bgp/types'
import {
  extractNeighbors,
  pairNeighbors,
  getCapabilitySummary,
  getLatestOpen,
  hasCapabilityChanges,
  type NeighborPair,
  type NeighborInfo,
  type OpenMessageRecord,
} from '../../lib/bgp'

interface NeighborSummaryProps {
  packets: BgpPacket[]
  onFilterByNeighbor?: (localIp: string, remoteIp: string) => void
}

export function NeighborSummary({ packets, onFilterByNeighbor }: NeighborSummaryProps) {
  const neighborPairs = useMemo(() => {
    const neighbors = extractNeighbors(packets)
    return pairNeighbors(neighbors)
  }, [packets])

  if (neighborPairs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No OPEN messages found
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-auto">
      {neighborPairs.map((pair, index) => (
        <NeighborPairCard key={index} pair={pair} onFilter={onFilterByNeighbor} />
      ))}
    </div>
  )
}

function NeighborPairCard({
  pair,
  onFilter,
}: {
  pair: NeighborPair
  onFilter?: (localIp: string, remoteIp: string) => void
}) {
  const { local, remote, established } = pair

  const handleFilterClick = () => {
    if (onFilter) {
      onFilter(local.localAddress, local.remoteAddress)
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* Header */}
      <div
        className={`px-4 py-2 flex items-center justify-between ${
          established
            ? 'bg-green-50 border-b border-green-200'
            : local.hasNotification || remote?.hasNotification
              ? 'bg-red-50 border-b border-red-200'
              : 'bg-gray-50 border-b border-gray-200'
        }`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              established
                ? 'bg-green-500'
                : local.hasNotification || remote?.hasNotification
                  ? 'bg-red-500'
                  : 'bg-yellow-500'
            }`}
          />
          <span className="font-medium text-sm">
            {local.localAddress} ↔ {local.remoteAddress}
          </span>
          {onFilter && (
            <button
              onClick={handleFilterClick}
              className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
              title="Filter packets by this neighbor pair"
            >
              Filter
            </button>
          )}
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            established
              ? 'bg-green-100 text-green-700'
              : local.hasNotification || remote?.hasNotification
                ? 'bg-red-100 text-red-700'
                : 'bg-yellow-100 text-yellow-700'
          }`}
        >
          {established
            ? 'Established'
            : local.hasNotification || remote?.hasNotification
              ? 'Error'
              : 'Incomplete'}
        </span>
      </div>

      {/* Body */}
      <div className="grid grid-cols-2 divide-x divide-gray-200">
        <NeighborCard neighbor={local} label="Local" />
        {remote ? (
          <NeighborCard neighbor={remote} label="Remote" />
        ) : (
          <div className="p-4 text-gray-400 text-sm text-center">No OPEN received</div>
        )}
      </div>
    </div>
  )
}

function NeighborCard({ neighbor, label }: { neighbor: NeighborInfo; label: string }) {
  const [showHistory, setShowHistory] = useState(false)
  const latestOpen = getLatestOpen(neighbor)
  const hasChanges = hasCapabilityChanges(neighbor)
  const capabilities = latestOpen ? getCapabilitySummary(latestOpen.capabilities) : []
  const totalMessages =
    neighbor.messageCount.open +
    neighbor.messageCount.update +
    neighbor.messageCount.notification +
    neighbor.messageCount.keepalive +
    neighbor.messageCount.routeRefresh

  return (
    <div className="p-4 space-y-3">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>

      {latestOpen ? (
        <>
          {/* Basic Info */}
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Router ID</span>
              <span className="font-mono">{latestOpen.routerId}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">AS Number</span>
              <span className="font-mono">{latestOpen.asNumber}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Hold Time</span>
              <span className="font-mono">{latestOpen.holdTime}s</span>
            </div>
          </div>

          {/* Capabilities */}
          {capabilities.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1">Capabilities</div>
              <div className="flex flex-wrap gap-1">
                {capabilities.map((cap, i) => (
                  <span key={i} className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                    {cap}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* OPEN History (if multiple) */}
          {neighbor.openHistory.length > 1 && (
            <div>
              <button
                onClick={() => setShowHistory(!showHistory)}
                className={`text-xs flex items-center gap-1 ${
                  hasChanges ? 'text-orange-600 hover:text-orange-700' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <svg
                  className={`w-3 h-3 transition-transform ${showHistory ? 'rotate-90' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                {neighbor.openHistory.length} OPEN messages
                {hasChanges && <span className="text-orange-600">(capabilities changed)</span>}
              </button>

              {showHistory && (
                <div className="mt-2 space-y-2">
                  {neighbor.openHistory.map((open, i) => (
                    <OpenHistoryItem key={i} open={open} index={i} isLatest={i === neighbor.openHistory.length - 1} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Message Stats */}
          <div>
            <div className="text-xs text-gray-500 mb-1">Messages ({totalMessages})</div>
            <div className="grid grid-cols-5 gap-1 text-center text-xs">
              <div>
                <div className="font-medium text-bgp-open">{neighbor.messageCount.open}</div>
                <div className="text-gray-400">OPEN</div>
              </div>
              <div>
                <div className="font-medium text-bgp-update">{neighbor.messageCount.update}</div>
                <div className="text-gray-400">UPD</div>
              </div>
              <div>
                <div className="font-medium text-bgp-notification">{neighbor.messageCount.notification}</div>
                <div className="text-gray-400">NOTIF</div>
              </div>
              <div>
                <div className="font-medium text-bgp-keepalive">{neighbor.messageCount.keepalive}</div>
                <div className="text-gray-400">KA</div>
              </div>
              <div>
                <div className="font-medium text-cyan-500">{neighbor.messageCount.routeRefresh}</div>
                <div className="text-gray-400">RR</div>
              </div>
            </div>
          </div>

          {/* Notification Error */}
          {neighbor.hasNotification && neighbor.notificationInfo && (
            <div className="bg-red-50 border border-red-200 rounded p-2">
              <div className="text-xs text-red-700 font-medium">
                {neighbor.notificationInfo.errorCode} / {neighbor.notificationInfo.errorSubcode}
              </div>
              <div className="text-xs text-red-600 mt-1">{neighbor.notificationInfo.hint}</div>
            </div>
          )}
        </>
      ) : (
        <div className="text-gray-400 text-sm">No OPEN message sent</div>
      )}
    </div>
  )
}

function OpenHistoryItem({
  open,
  index,
  isLatest,
}: {
  open: OpenMessageRecord
  index: number
  isLatest: boolean
}) {
  const capabilities = getCapabilitySummary(open.capabilities)

  return (
    <div className={`text-xs p-2 rounded ${isLatest ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50'}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium">
          #{index + 1} {isLatest && '(latest)'}
        </span>
        <span className="text-gray-500">{open.timestamp.toISOString().slice(11, 23)}</span>
      </div>
      <div className="text-gray-600">
        AS{open.asNumber} / Hold={open.holdTime}s
      </div>
      {capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {capabilities.map((cap, i) => (
            <span key={i} className="bg-white border border-gray-200 px-1 py-0.5 rounded text-gray-600">
              {cap}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
