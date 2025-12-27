import { useState, useCallback, useRef, useMemo } from 'react'
import type { BgpPacket } from '../../lib/bgp/types'
import type { GenericPacket } from '../../lib/pcap'
import { useFilter } from '../../hooks/useFilter'
import { useResizablePanes } from '../../hooks/useResizablePanes'
import { PacketList, QueryInput } from '../common'
import { PacketDetail } from '../message/PacketDetail'
import { NeighborSummary } from '../neighbor'

interface PaneConfig {
  packets: boolean
  detail: boolean
  neighbors: boolean
}

export type DisplayPacket =
  | { kind: 'bgp'; packet: BgpPacket; timestamp: Date }
  | { kind: 'generic'; packet: GenericPacket; timestamp: Date }

interface MainContentProps {
  packets: BgpPacket[]
  allPackets: GenericPacket[]
  selectedIndex: number | null
  onSelectPacket: (index: number | null) => void
  fileName: string | null
}

export function MainContent({
  packets,
  allPackets,
  selectedIndex,
  onSelectPacket,
  fileName,
}: MainContentProps) {
  const [panes, setPanes] = useState<PaneConfig>({
    packets: true,
    detail: true,
    neighbors: false,
  })
  const [showAllPackets, setShowAllPackets] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Create display packets based on mode
  const displayPackets = useMemo((): DisplayPacket[] => {
    if (showAllPackets) {
      // Show all packets, merging BGP-parsed with generic
      // Create a map of BGP packets by timestamp+src+dst for matching
      const bgpMap = new Map<string, BgpPacket>()
      for (const p of packets) {
        const key = `${p.timestamp.getTime()}-${p.srcIp}-${p.dstIp}-${p.srcPort}-${p.dstPort}`
        bgpMap.set(key, p)
      }

      return allPackets.map((gp): DisplayPacket => {
        const key = `${gp.timestamp.getTime()}-${gp.srcIp}-${gp.dstIp}-${gp.srcPort ?? 0}-${gp.dstPort ?? 0}`
        const bgpPacket = bgpMap.get(key)
        if (bgpPacket) {
          return { kind: 'bgp', packet: bgpPacket, timestamp: gp.timestamp }
        }
        return { kind: 'generic', packet: gp, timestamp: gp.timestamp }
      })
    } else {
      // Show only BGP packets
      return packets.map((p): DisplayPacket => ({
        kind: 'bgp',
        packet: p,
        timestamp: p.timestamp,
      }))
    }
  }, [packets, allPackets, showAllPackets])

  const { query, setQuery, filteredPackets, hasActiveFilter, hasParseErrors, parseErrors } = useFilter(packets)
  const { getActualSizes, getVisiblePanes, handleMouseDown } = useResizablePanes({
    panes,
    containerRef,
  })

  // Filter display packets (basic filter for non-BGP)
  const filteredDisplayPackets = useMemo(() => {
    if (!showAllPackets) {
      return filteredPackets.map((p): DisplayPacket => ({
        kind: 'bgp',
        packet: p,
        timestamp: p.timestamp,
      }))
    }
    // For all packets mode, apply basic filtering
    if (!hasActiveFilter) return displayPackets
    // Simple filter: match src/dst IP
    const lowerQuery = query.toLowerCase()
    return displayPackets.filter((dp) => {
      if (dp.kind === 'bgp') {
        return (
          dp.packet.srcIp.includes(lowerQuery) ||
          dp.packet.dstIp.includes(lowerQuery)
        )
      }
      return (
        dp.packet.srcIp.includes(lowerQuery) ||
        dp.packet.dstIp.includes(lowerQuery)
      )
    })
  }, [showAllPackets, filteredPackets, displayPackets, hasActiveFilter, query])

  const selectedDisplayPacket = selectedIndex !== null ? filteredDisplayPackets[selectedIndex] : null
  const selectedBgpPacket = selectedDisplayPacket?.kind === 'bgp' ? selectedDisplayPacket.packet : null

  const togglePane = useCallback((pane: keyof PaneConfig) => {
    setPanes((prev) => {
      const next = { ...prev, [pane]: !prev[pane] }
      // At least one pane must be visible
      if (!next.packets && !next.detail && !next.neighbors) {
        return prev
      }
      return next
    })
  }, [])

  const handleFilterByNeighbor = useCallback(
    (localIp: string, remoteIp: string) => {
      // Create a filter query that matches packets from either direction
      const filterQuery = `src=${localIp} or src=${remoteIp}`
      setQuery(filterQuery)
      // Ensure packets pane is visible
      setPanes((prev) => ({ ...prev, packets: true }))
      // Clear selection when filter changes
      onSelectPacket(null)
    },
    [setQuery, onSelectPacket]
  )

  const sizes = getActualSizes()
  const visiblePanes = getVisiblePanes()

  // Render panes with dividers
  const renderPanesWithDividers = () => {
    const elements: React.ReactNode[] = []

    visiblePanes.forEach((paneKey, index) => {
      // Add divider before pane (except first)
      if (index > 0) {
        elements.push(
          <ResizeDivider key={`divider-${index}`} onMouseDown={handleMouseDown(index - 1)} />
        )
      }

      // Add pane
      const width = sizes[paneKey]
      elements.push(
        <div
          key={paneKey}
          className="flex flex-col min-w-0 h-full overflow-hidden"
          style={{ width: `${width}%` }}
        >
          {paneKey === 'packets' && (
            <>
              <PaneHeader title="Packet List">
                <span className="text-xs text-gray-500">
                  {filteredDisplayPackets.length} packet{filteredDisplayPackets.length !== 1 ? 's' : ''}
                  {hasActiveFilter && ` (${showAllPackets ? allPackets.length : packets.length} total)`}
                </span>
              </PaneHeader>
              <div className="flex-1 min-h-0 overflow-auto">
                <PacketList
                  packets={filteredDisplayPackets}
                  selectedIndex={selectedIndex}
                  onSelect={onSelectPacket}
                />
              </div>
            </>
          )}
          {paneKey === 'detail' && (
            <>
              <PaneHeader title="Packet Detail">
                {selectedDisplayPacket && (
                  <span className="text-xs text-gray-500">
                    {selectedDisplayPacket.kind === 'bgp'
                      ? selectedDisplayPacket.packet.message.type
                      : selectedDisplayPacket.packet.protocol}
                  </span>
                )}
              </PaneHeader>
              <div className="flex-1 min-h-0 overflow-auto bg-white">
                {selectedBgpPacket ? (
                  <PacketDetail packet={selectedBgpPacket} />
                ) : selectedDisplayPacket?.kind === 'generic' ? (
                  <GenericPacketDetail packet={selectedDisplayPacket.packet} />
                ) : (
                  <div className="flex-1 h-full flex items-center justify-center text-gray-400 text-sm p-8">
                    Select a packet to view details
                  </div>
                )}
              </div>
            </>
          )}
          {paneKey === 'neighbors' && (
            <>
              <PaneHeader title="Neighbor Summary">
                <span className="text-xs text-gray-500">Session info</span>
              </PaneHeader>
              <div className="flex-1 min-h-0 overflow-auto bg-white">
                <NeighborSummary packets={packets} onFilterByNeighbor={handleFilterByNeighbor} />
              </div>
            </>
          )}
        </div>
      )
    })

    return elements
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center gap-4">
        {/* Pane Toggles */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500 mr-1">Panes:</span>
          <PaneToggle
            label="Packets"
            active={panes.packets}
            onClick={() => togglePane('packets')}
          />
          <PaneToggle
            label="Detail"
            active={panes.detail}
            onClick={() => togglePane('detail')}
          />
          <PaneToggle
            label="Neighbors"
            active={panes.neighbors}
            onClick={() => togglePane('neighbors')}
          />
        </div>

        <div className="h-4 w-px bg-gray-300" />

        {/* Packet Filter Toggle */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500 mr-1">Show:</span>
          <PaneToggle
            label="BGP Only"
            active={!showAllPackets}
            onClick={() => {
              setShowAllPackets(false)
              onSelectPacket(null)
            }}
          />
          <PaneToggle
            label="All Packets"
            active={showAllPackets}
            onClick={() => {
              setShowAllPackets(true)
              onSelectPacket(null)
            }}
          />
        </div>

        <div className="h-4 w-px bg-gray-300" />

        {/* Query Input */}
        <QueryInput value={query} onChange={setQuery} packets={packets} hasError={hasParseErrors} />
        {hasParseErrors ? (
          <span className="text-xs text-red-500 whitespace-nowrap" title={parseErrors.map(e => e.message).join('; ')}>
            ⚠ {parseErrors[0].message}
          </span>
        ) : (
          <span className="text-xs text-gray-500 whitespace-nowrap">
            {showAllPackets
              ? `${filteredDisplayPackets.length} / ${allPackets.length} packets`
              : hasActiveFilter
                ? `${filteredPackets.length} / ${packets.length} packets`
                : `${packets.length} packets`}
          </span>
        )}

        {/* File name */}
        {fileName && (
          <>
            <div className="h-4 w-px bg-gray-300" />
            <span className="text-xs text-gray-600 font-medium truncate max-w-48">{fileName}</span>
          </>
        )}
      </div>

      {/* Content - Resizable multi-pane layout */}
      <div ref={containerRef} className="flex-1 flex min-h-0 h-0">
        {renderPanesWithDividers()}
      </div>
    </div>
  )
}

function PaneToggle({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
        active
          ? 'bg-blue-500 text-white'
          : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
      }`}
    >
      {label}
    </button>
  )
}

function PaneHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between shrink-0">
      <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">{title}</span>
      {children}
    </div>
  )
}

function ResizeDivider({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="w-1 bg-gray-200 hover:bg-blue-400 cursor-col-resize transition-colors shrink-0 relative group"
      onMouseDown={onMouseDown}
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-8 rounded-full bg-gray-400 group-hover:bg-blue-500 transition-colors" />
    </div>
  )
}

function GenericPacketDetail({ packet }: { packet: GenericPacket }) {
  const formatTcpFlags = (flags: GenericPacket['tcpFlags']) => {
    if (!flags) return null
    const flagList: string[] = []
    if (flags.syn) flagList.push('SYN')
    if (flags.ack) flagList.push('ACK')
    if (flags.fin) flagList.push('FIN')
    if (flags.rst) flagList.push('RST')
    if (flags.psh) flagList.push('PSH')
    if (flags.urg) flagList.push('URG')
    return flagList.join(', ') || 'none'
  }

  return (
    <div className="p-4 space-y-4">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-700">Network Layer</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-gray-500">Source IP:</span>
            <span className="ml-2 font-mono">{packet.srcIp}</span>
          </div>
          <div>
            <span className="text-gray-500">Destination IP:</span>
            <span className="ml-2 font-mono">{packet.dstIp}</span>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-700">Transport Layer</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-gray-500">Protocol:</span>
            <span className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${
              packet.protocol === 'TCP' ? 'bg-blue-100 text-blue-700' :
              packet.protocol === 'UDP' ? 'bg-green-100 text-green-700' :
              packet.protocol === 'ICMP' ? 'bg-yellow-100 text-yellow-700' :
              'bg-gray-100 text-gray-700'
            }`}>
              {packet.protocol}
            </span>
          </div>
          {packet.srcPort !== undefined && (
            <div>
              <span className="text-gray-500">Source Port:</span>
              <span className="ml-2 font-mono">{packet.srcPort}</span>
            </div>
          )}
          {packet.dstPort !== undefined && (
            <div>
              <span className="text-gray-500">Destination Port:</span>
              <span className="ml-2 font-mono">{packet.dstPort}</span>
            </div>
          )}
          <div>
            <span className="text-gray-500">Payload Length:</span>
            <span className="ml-2 font-mono">{packet.payloadLength} bytes</span>
          </div>
        </div>
        {packet.tcpFlags && (
          <div className="text-sm">
            <span className="text-gray-500">TCP Flags:</span>
            <span className="ml-2 font-mono">{formatTcpFlags(packet.tcpFlags)}</span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-700">Frame Info</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-gray-500">Captured:</span>
            <span className="ml-2 font-mono">{packet.capturedLength} bytes</span>
          </div>
          <div>
            <span className="text-gray-500">Original:</span>
            <span className="ml-2 font-mono">{packet.originalLength} bytes</span>
          </div>
          <div>
            <span className="text-gray-500">Timestamp:</span>
            <span className="ml-2 font-mono">{packet.timestamp.toISOString()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
