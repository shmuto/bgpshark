import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import type { BgpPacket } from '../../lib/bgp/types'
import type { GenericPacket } from '../../lib/pcap'
import type { SessionEvent } from '../../lib/bgp/session-events'
import { useFilter } from '../../hooks/useFilter'
import { useResizablePanes } from '../../hooks/useResizablePanes'
import { PacketList, QueryInput } from '../common'
import { PacketDetail } from '../message/PacketDetail'
import { NeighborSummary } from '../neighbor'
import { BgpPeersSidebar } from '../sidebar'

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
  const [showSqlHelp, setShowSqlHelp] = useState(false)
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
  const [showPeersSidebar, setShowPeersSidebar] = useState(true)
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Clear highlight after animation
  useEffect(() => {
    if (highlightedIndex !== null) {
      const timer = setTimeout(() => setHighlightedIndex(null), 1500)
      return () => clearTimeout(timer)
    }
  }, [highlightedIndex])

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

  // Filter packets by selected peer first
  const peerFilteredPackets = useMemo(() => {
    if (!selectedPeer) return packets
    return packets.filter(p => p.srcIp === selectedPeer || p.dstIp === selectedPeer)
  }, [packets, selectedPeer])

  const {
    query,
    setQuery,
    filteredPackets,
    hasActiveFilter,
    hasParseErrors,
    parseErrors,
    isFiltering,
  } = useFilter(peerFilteredPackets)
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
    // For all packets mode, apply peer and query filtering
    let filtered = displayPackets

    // Apply peer filter
    if (selectedPeer) {
      filtered = filtered.filter((dp) => {
        const pkt = dp.kind === 'bgp' ? dp.packet : dp.packet
        return pkt.srcIp === selectedPeer || pkt.dstIp === selectedPeer
      })
    }

    // Apply query filter
    if (hasActiveFilter) {
      const lowerQuery = query.toLowerCase()
      filtered = filtered.filter((dp) => {
        const pkt = dp.kind === 'bgp' ? dp.packet : dp.packet
        return pkt.srcIp.includes(lowerQuery) || pkt.dstIp.includes(lowerQuery)
      })
    }

    return filtered
  }, [showAllPackets, filteredPackets, displayPackets, hasActiveFilter, query, selectedPeer])

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
    (srcIp: string, dstIp: string) => {
      // Filter packets for this specific session (src->dst or dst->src)
      const filterQuery = `(src=${srcIp} and dst=${dstIp}) or (src=${dstIp} and dst=${srcIp})`
      setQuery(filterQuery)
      // Ensure packets pane is visible
      setPanes((prev) => ({ ...prev, packets: true }))
      // Clear selection when filter changes
      onSelectPacket(null)
    },
    [setQuery, onSelectPacket]
  )

  // Handle event click from mini timeline - find and highlight the matching packet
  const handleEventClick = useCallback(
    (event: SessionEvent) => {
      // Find the packet that matches this event by timestamp and IPs
      const eventTime = event.timestamp.getTime()
      const index = filteredDisplayPackets.findIndex((dp) => {
        if (dp.kind !== 'bgp') return false
        const packet = dp.packet
        // Check if timestamp matches (within 1ms tolerance) and IPs match
        const timeMatch = Math.abs(packet.timestamp.getTime() - eventTime) < 1
        const ipsMatch =
          (packet.srcIp === event.srcIp && packet.dstIp === event.dstIp) ||
          (packet.srcIp === event.dstIp && packet.dstIp === event.srcIp)
        // Check if message type matches the event type
        if (!timeMatch || !ipsMatch) return false
        for (const msg of packet.messages) {
          if (
            (event.eventType === 'OPEN_SENT' && msg.type === 'OPEN') ||
            (event.eventType === 'OPEN_RECEIVED' && msg.type === 'OPEN') ||
            (event.eventType === 'KEEPALIVE' && msg.type === 'KEEPALIVE') ||
            (event.eventType === 'NOTIFICATION' && msg.type === 'NOTIFICATION') ||
            (event.eventType === 'UPDATE' && msg.type === 'UPDATE')
          ) {
            return true
          }
        }
        return false
      })

      if (index !== -1) {
        setHighlightedIndex(index)
        onSelectPacket(index)
        // Ensure packets pane is visible
        setPanes((prev) => ({ ...prev, packets: true }))
      }
    },
    [filteredDisplayPackets, onSelectPacket]
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
                <span className="text-xs text-muted">
                  {filteredDisplayPackets.length} packet{filteredDisplayPackets.length !== 1 ? 's' : ''}
                  {hasActiveFilter && ` (${showAllPackets ? allPackets.length : packets.length} total)`}
                </span>
              </PaneHeader>
              <div className="flex-1 min-h-0 overflow-auto">
                <PacketList
                  packets={filteredDisplayPackets}
                  selectedIndex={selectedIndex}
                  onSelect={onSelectPacket}
                  highlightedIndex={highlightedIndex}
                />
              </div>
            </>
          )}
          {paneKey === 'detail' && (
            <>
              <PaneHeader title="Packet Detail">
                {selectedDisplayPacket && (
                  <span className="text-xs text-muted">
                    {selectedDisplayPacket.kind === 'bgp'
                      ? selectedDisplayPacket.packet.messages.map(m => m.type).join(', ')
                      : selectedDisplayPacket.packet.protocol}
                  </span>
                )}
              </PaneHeader>
              <div className="flex-1 min-h-0 overflow-auto bg-surface">
                {selectedBgpPacket ? (
                  <PacketDetail packet={selectedBgpPacket} />
                ) : selectedDisplayPacket?.kind === 'generic' ? (
                  <GenericPacketDetail packet={selectedDisplayPacket.packet} />
                ) : (
                  <div className="flex-1 h-full flex items-center justify-center text-dim text-sm p-8">
                    Select a packet to view details
                  </div>
                )}
              </div>
            </>
          )}
          {paneKey === 'neighbors' && (
            <>
              <PaneHeader title="Neighbor Summary">
                <span className="text-xs text-muted">Session info</span>
              </PaneHeader>
              <div className="flex-1 min-h-0 overflow-auto bg-surface">
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
    <div className="flex-1 flex min-h-0">
      {/* Left Sidebar - BGP Peers */}
      {showPeersSidebar && (
        <div className="w-56 shrink-0">
          <BgpPeersSidebar
            packets={packets}
            selectedPeer={selectedPeer}
            onSelectPeer={(peer) => {
              setSelectedPeer(peer)
              onSelectPacket(null)
            }}
            onEventClick={handleEventClick}
          />
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Toolbar */}
        <div className="bg-surface-sunken border-b border-hair px-4 py-2 flex items-center gap-4">
          {/* Sidebar Toggle */}
          <button
            onClick={() => setShowPeersSidebar(!showPeersSidebar)}
            className={`p-1.5 rounded transition-colors ${
              showPeersSidebar ? 'bg-accent text-accent-fg' : 'bg-surface-raised text-muted hover:text-strong'
            }`}
            title={showPeersSidebar ? 'Hide Peers' : 'Show Peers'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
            </svg>
          </button>

          {/* Selected Peer Indicator */}
          {selectedPeer && (
            <div className="flex items-center gap-1 bg-accent-subtle text-accent px-2 py-1 rounded text-xs">
              <span className="font-mono">{selectedPeer}</span>
              <button
                onClick={() => {
                  setSelectedPeer(null)
                  onSelectPacket(null)
                }}
                className="hover:bg-accent/20 rounded p-0.5"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          <div className="h-4 w-px bg-hair-strong" />

          {/* Pane Toggles */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted mr-1">Panes:</span>
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

          <div className="h-4 w-px bg-hair-strong" />

          {/* Packet Filter Toggle */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted mr-1">Show:</span>
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

          <div className="h-4 w-px bg-hair-strong" />

          {/* Query Input */}
          <QueryInput value={query} onChange={setQuery} packets={peerFilteredPackets} hasError={hasParseErrors} />
          {isFiltering && (
            <span className="text-xs text-muted whitespace-nowrap">
              filtering...
            </span>
          )}
          {hasParseErrors ? (
            <span className="text-xs text-critical whitespace-nowrap max-w-64 truncate" title={parseErrors.map(e => e.message).join('; ')}>
              {parseErrors[0]?.message}
            </span>
          ) : (
            <span className="text-xs text-muted whitespace-nowrap">
              {showAllPackets
                ? `${filteredDisplayPackets.length} / ${allPackets.length} packets`
                : hasActiveFilter || selectedPeer
                  ? `${filteredPackets.length} / ${packets.length} packets`
                  : `${packets.length} packets`}
            </span>
          )}
          <button
            onClick={() => setShowSqlHelp(true)}
            className="w-6 h-6 flex items-center justify-center text-dim hover:text-strong hover:bg-surface-raised rounded transition-colors"
            title="Filter Help"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>

          {/* File name */}
          {fileName && (
            <>
              <div className="h-4 w-px bg-hair-strong" />
              <span className="text-xs text-muted font-medium truncate max-w-48">{fileName}</span>
            </>
          )}
        </div>

        {/* Content - Resizable multi-pane layout */}
        <div ref={containerRef} className="flex-1 flex min-h-0 h-0">
          {renderPanesWithDividers()}
        </div>

        {/* SQL Help Modal */}
        {showSqlHelp && <SqlHelpModal onClose={() => setShowSqlHelp(false)} />}
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
          ? 'bg-accent text-accent-fg'
          : 'bg-surface-raised text-muted hover:text-strong'
      }`}
    >
      {label}
    </button>
  )
}

function PaneHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="px-3 py-2 bg-surface-sunken border-b border-hair flex items-center justify-between shrink-0">
      <span className="text-xs font-semibold text-strong uppercase tracking-wide">{title}</span>
      {children}
    </div>
  )
}

function ResizeDivider({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="w-1 bg-hair hover:bg-accent cursor-col-resize transition-colors shrink-0 relative group"
      onMouseDown={onMouseDown}
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-8 rounded-full bg-hair-strong group-hover:bg-accent transition-colors" />
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
        <h3 className="text-sm font-semibold text-strong">Network Layer</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-muted">Source IP:</span>
            <span className="ml-2 font-mono">{packet.srcIp}</span>
          </div>
          <div>
            <span className="text-muted">Destination IP:</span>
            <span className="ml-2 font-mono">{packet.dstIp}</span>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-strong">Transport Layer</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-muted">Protocol:</span>
            <span className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${
              packet.protocol === 'TCP' ? 'bg-accent-subtle text-accent' :
              packet.protocol === 'UDP' ? 'bg-ok-subtle text-ok' :
              packet.protocol === 'ICMP' ? 'bg-warning-subtle text-warning' :
              'bg-surface-sunken text-muted'
            }`}>
              {packet.protocol}
            </span>
          </div>
          {packet.srcPort !== undefined && (
            <div>
              <span className="text-muted">Source Port:</span>
              <span className="ml-2 font-mono">{packet.srcPort}</span>
            </div>
          )}
          {packet.dstPort !== undefined && (
            <div>
              <span className="text-muted">Destination Port:</span>
              <span className="ml-2 font-mono">{packet.dstPort}</span>
            </div>
          )}
          <div>
            <span className="text-muted">Payload Length:</span>
            <span className="ml-2 font-mono">{packet.payloadLength} bytes</span>
          </div>
        </div>
        {packet.tcpFlags && (
          <div className="text-sm">
            <span className="text-muted">TCP Flags:</span>
            <span className="ml-2 font-mono">{formatTcpFlags(packet.tcpFlags)}</span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-strong">Frame Info</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-muted">Captured:</span>
            <span className="ml-2 font-mono">{packet.capturedLength} bytes</span>
          </div>
          <div>
            <span className="text-muted">Original:</span>
            <span className="ml-2 font-mono">{packet.originalLength} bytes</span>
          </div>
          <div>
            <span className="text-muted">Timestamp:</span>
            <span className="ml-2 font-mono">{packet.timestamp.toISOString()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function SqlHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-canvas/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-hair flex items-center justify-between bg-surface-sunken">
          <h2 className="text-lg font-semibold text-strong">Filter Help</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-strong p-1"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-auto">
          {/* Available Fields */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-strong uppercase tracking-wide mb-3">Available Fields</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <FieldHelp name="type" desc="Message type" examples="OPEN, UPDATE, NOTIFICATION, KEEPALIVE" />
              <FieldHelp name="src_ip" desc="Source IP address" examples="10.0.0.1, 192.168.1.0/24" />
              <FieldHelp name="dst_ip" desc="Destination IP address" examples="10.0.0.2" />
              <FieldHelp name="router_id" desc="Router ID (OPEN)" examples="1.1.1.1" />
              <FieldHelp name="my_as" desc="AS number in OPEN" examples="65001" />
              <FieldHelp name="asn" desc="AS in AS_PATH" examples="65001, 65002" />
              <FieldHelp name="origin" desc="Origin attribute" examples="IGP, EGP, INCOMPLETE" />
              <FieldHelp name="next_hop" desc="Next hop address" examples="10.0.0.1" />
              <FieldHelp name="prefix" desc="Announced prefix (NLRI)" examples="192.168.0.0/24" />
              <FieldHelp name="withdrawn" desc="Withdrawn prefix" examples="10.0.0.0/8" />
              <FieldHelp name="community" desc="Community value" examples="65001:100" />
              <FieldHelp name="capability" desc="Capability name" examples="4-byte AS, Route Refresh" />
            </div>
          </div>

          {/* Operators */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-strong uppercase tracking-wide mb-3">Operators</h3>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="bg-surface-sunken p-2 rounded">
                <code className="font-mono text-accent">=</code>
                <span className="text-muted ml-2">Equals</span>
              </div>
              <div className="bg-surface-sunken p-2 rounded">
                <code className="font-mono text-accent">!=</code>
                <span className="text-muted ml-2">Not equals</span>
              </div>
              <div className="bg-surface-sunken p-2 rounded">
                <code className="font-mono text-accent">contains</code>
                <span className="text-muted ml-2">Contains</span>
              </div>
            </div>
          </div>

          {/* Examples */}
          <div>
            <h3 className="text-sm font-semibold text-strong uppercase tracking-wide mb-3">Examples</h3>
            <div className="space-y-2 text-sm bg-surface-sunken p-4 rounded-lg font-mono">
              <div><code className="text-body">type=UPDATE</code></div>
              <div><code className="text-body">type=UPDATE and src_ip=10.0.0.1</code></div>
              <div><code className="text-body">asn=65001</code></div>
              <div><code className="text-body">prefix contains 192.168</code></div>
              <div><code className="text-body">(type=OPEN or type=UPDATE) and src_ip=10.0.0.1</code></div>
              <div><code className="text-body">community=65001:100</code></div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-hair bg-surface-sunken flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium bg-accent text-accent-fg rounded hover:bg-accent-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function FieldHelp({ name, desc, examples }: { name: string; desc: string; examples: string }) {
  return (
    <div className="bg-surface-sunken p-2 rounded">
      <code className="font-mono text-accent font-medium">{name}</code>
      <p className="text-muted text-xs mt-0.5">{desc}</p>
      <p className="text-muted text-xs">{examples}</p>
    </div>
  )
}
