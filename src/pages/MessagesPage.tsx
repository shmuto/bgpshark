import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useFilter } from '../hooks/useFilter'
import { PacketList, QueryInput } from '../components/common'
import { PacketDetail } from '../components/message/PacketDetail'
import type {
  BgpPacket,
  BgpUpdateMessage,
  BgpOpenMessage,
  MpReachNlriAttribute,
  MpUnreachNlriAttribute,
  AsPathAttribute,
  NextHopAttribute,
  CommunitiesAttribute,
  LargeCommunitiesAttribute,
} from '../lib/bgp/types'
import type { GenericPacket } from '../lib/pcap'
import { FILTER_FIELDS, type FilterFieldName } from '../lib/filter/parser'

export type DisplayPacket =
  | { kind: 'bgp'; packet: BgpPacket; timestamp: Date }
  | { kind: 'generic'; packet: GenericPacket; timestamp: Date }

type FilterMode = 'simple' | 'advanced'
type Operator = '=' | '!='

interface FilterRule {
  id: string
  field: FilterFieldName | ''
  operator: Operator
  value: string
}

export function MessagesPage() {
  const { packets, allPackets, selectedPacketIndex, selectPacket } = useApp()
  const [searchParams, setSearchParams] = useSearchParams()
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [showAllPackets, setShowAllPackets] = useState(false)
  const [filterMode, setFilterMode] = useState<FilterMode>('simple')
  const [rules, setRules] = useState<FilterRule[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  // Get initial filter from URL
  const initialFilter = searchParams.get('filter') || ''
  const initialSelected = searchParams.get('selected')

  const {
    query,
    setQuery,
    filteredPackets,
    hasParseErrors,
    parseErrors,
    isFiltering,
  } = useFilter(packets, { initialQuery: initialFilter })

  // Set initial selection from URL - find the packet in filtered results by frameIndex
  useEffect(() => {
    if (initialSelected) {
      const originalIdx = parseInt(initialSelected, 10)
      if (!isNaN(originalIdx) && originalIdx >= 0 && originalIdx < packets.length) {
        // Find the target packet's frameIndex
        const targetPacket = packets[originalIdx]
        // Find this packet in the filtered list
        const filteredIdx = filteredPackets.findIndex(
          (p) => p.frameIndex === targetPacket.frameIndex
        )
        if (filteredIdx >= 0) {
          selectPacket(filteredIdx)
          setHighlightedIndex(filteredIdx)
        }
      }
    }
  }, [initialSelected, packets, filteredPackets, selectPacket])

  // Clear highlight after animation
  useEffect(() => {
    if (highlightedIndex !== null) {
      const timer = setTimeout(() => setHighlightedIndex(null), 1500)
      return () => clearTimeout(timer)
    }
  }, [highlightedIndex])

  // Update URL when filter changes (use replace to avoid duplicate history entries)
  useEffect(() => {
    const currentFilter = searchParams.get('filter') || ''
    // Only update if the query actually changed from what's in the URL
    if (query !== currentFilter) {
      if (query) {
        setSearchParams({ filter: query }, { replace: true })
      } else {
        setSearchParams({}, { replace: true })
      }
    }
  }, [query, searchParams, setSearchParams])

  // Create display packets based on mode
  const displayPackets = useMemo((): DisplayPacket[] => {
    if (showAllPackets) {
      // Show all packets, merging BGP-parsed with generic
      // Create a map of BGP packets by frameIndex for matching
      const bgpMap = new Map<number, BgpPacket>()
      for (const p of filteredPackets) {
        bgpMap.set(p.frameIndex, p)
      }

      // Filter allPackets based on whether any BGP packets match the current filter
      // If no filter is active, show all. Otherwise, only show packets that are either:
      // 1. BGP packets matching the filter
      // 2. Non-BGP packets (always show when no filter or simple IP filter)
      return allPackets.map((gp): DisplayPacket => {
        const bgpPacket = bgpMap.get(gp.frameIndex)
        if (bgpPacket) {
          return { kind: 'bgp', packet: bgpPacket, timestamp: gp.timestamp }
        }
        return { kind: 'generic', packet: gp, timestamp: gp.timestamp }
      })
    } else {
      // Show only BGP packets
      return filteredPackets.map((p): DisplayPacket => ({
        kind: 'bgp',
        packet: p,
        timestamp: p.timestamp,
      }))
    }
  }, [filteredPackets, allPackets, showAllPackets])

  const selectedDisplayPacket = selectedPacketIndex !== null ? displayPackets[selectedPacketIndex] : null
  const selectedBgpPacket = selectedDisplayPacket?.kind === 'bgp' ? selectedDisplayPacket.packet : null
  const selectedGenericPacket = selectedDisplayPacket?.kind === 'generic' ? selectedDisplayPacket.packet : null

  // Extract all dynamic values from packets for filter dropdowns
  const dynamicValues = useMemo(() => {
    const values = {
      src_ip: new Set<string>(),
      dst_ip: new Set<string>(),
      src_as: new Set<string>(),
      router_id: new Set<string>(),
      asn: new Set<string>(),
      next_hop: new Set<string>(),
      prefix: new Set<string>(),
      withdrawn: new Set<string>(),
      community: new Set<string>(),
      capability: new Set<string>(),
    }

    for (const packet of packets) {
      values.src_ip.add(packet.srcIp)
      values.dst_ip.add(packet.dstIp)

      for (const msg of packet.messages) {
        if (msg.type === 'OPEN') {
          const open = msg as BgpOpenMessage
          values.src_as.add(String(open.fourByteAs ?? open.myAs))
          values.router_id.add(open.bgpIdentifier)
          for (const cap of open.capabilities) {
            values.capability.add(cap.name)
          }
        }

        if (msg.type === 'UPDATE') {
          const update = msg as BgpUpdateMessage

          // NLRI prefixes (add to both prefix and withdrawn for unified view)
          for (const p of update.nlri) {
            const prefixStr = `${p.prefix}/${p.length}`
            values.prefix.add(prefixStr)
          }
          // Withdrawn prefixes (add to both prefix and withdrawn)
          for (const p of update.withdrawnRoutes) {
            const prefixStr = `${p.prefix}/${p.length}`
            values.prefix.add(prefixStr)
            values.withdrawn.add(prefixStr)
          }

          // Path attributes
          for (const attr of update.pathAttributes) {
            if (attr.parsed?.type === 'AS_PATH') {
              const asPath = attr.parsed as AsPathAttribute
              for (const seg of asPath.segments) {
                for (const asn of seg.asNumbers) {
                  values.asn.add(String(asn))
                }
              }
            }
            if (attr.parsed?.type === 'NEXT_HOP') {
              values.next_hop.add((attr.parsed as NextHopAttribute).address)
            }
            if (attr.parsed?.type === 'MP_REACH_NLRI') {
              const mpReach = attr.parsed as MpReachNlriAttribute
              values.next_hop.add(mpReach.nextHop)
              for (const p of mpReach.nlri) {
                values.prefix.add(`${p.prefix}/${p.length}`)
              }
            }
            if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
              const mpUnreach = attr.parsed as MpUnreachNlriAttribute
              for (const p of mpUnreach.withdrawnRoutes) {
                const prefixStr = `${p.prefix}/${p.length}`
                values.prefix.add(prefixStr)
                values.withdrawn.add(prefixStr)
              }
            }
            if (attr.parsed?.type === 'COMMUNITIES') {
              const comm = attr.parsed as CommunitiesAttribute
              for (const c of comm.communities) {
                values.community.add(c)
              }
            }
            if (attr.parsed?.type === 'LARGE_COMMUNITIES') {
              const lcomm = attr.parsed as LargeCommunitiesAttribute
              for (const c of lcomm.communities) {
                values.community.add(`${c.globalAdmin}:${c.localData1}:${c.localData2}`)
              }
            }
          }
        }
      }
    }

    // Convert to sorted arrays
    const sortIp = (a: string, b: string) => {
      const aIsV6 = a.includes(':')
      const bIsV6 = b.includes(':')
      if (aIsV6 !== bIsV6) return aIsV6 ? 1 : -1
      return a.localeCompare(b)
    }

    return {
      src_ip: Array.from(values.src_ip).sort(sortIp),
      dst_ip: Array.from(values.dst_ip).sort(sortIp),
      src_as: Array.from(values.src_as).sort((a, b) => Number(a) - Number(b)),
      router_id: Array.from(values.router_id).sort(),
      asn: Array.from(values.asn).sort((a, b) => Number(a) - Number(b)),
      next_hop: Array.from(values.next_hop).sort(sortIp),
      prefix: Array.from(values.prefix).sort(sortIp),
      withdrawn: Array.from(values.withdrawn).sort(sortIp),
      community: Array.from(values.community).sort(),
      capability: Array.from(values.capability).sort(),
    }
  }, [packets])

  // Convert rules to query string
  const rulesToQuery = useCallback((filterRules: FilterRule[]): string => {
    const validRules = filterRules.filter(r => r.field && r.value)
    if (validRules.length === 0) return ''
    return validRules
      .map(r => `${r.field}${r.operator}${r.value}`)
      .join(' and ')
  }, [])

  // Update query when rules change (in simple mode)
  useEffect(() => {
    if (filterMode === 'simple') {
      setQuery(rulesToQuery(rules))
    }
  }, [rules, filterMode, rulesToQuery, setQuery])

  // Rule management functions
  const addRule = () => {
    setRules([...rules, { id: crypto.randomUUID(), field: '', operator: '=', value: '' }])
  }

  const updateRule = (id: string, updates: Partial<FilterRule>) => {
    setRules(rules.map(r => r.id === id ? { ...r, ...updates } : r))
  }

  const removeRule = (id: string) => {
    setRules(rules.filter(r => r.id !== id))
  }

  // Get values for a field
  const getFieldValues = (field: FilterFieldName | ''): string[] => {
    if (!field) return []
    const fieldDef = FILTER_FIELDS[field]
    // Static values from field definition
    if (fieldDef.values.length > 0) {
      return fieldDef.values as string[]
    }
    // Dynamic values from packets
    const dv = dynamicValues[field as keyof typeof dynamicValues]
    if (dv) {
      // Limit to 100 items for performance
      return dv.slice(0, 100)
    }
    return []
  }

  // Handle mode switch
  const handleModeSwitch = (mode: FilterMode) => {
    if (mode === 'advanced' && filterMode === 'simple') {
      // Simple -> Advanced: carry over the query (already synced via rulesToQuery)
      setFilterMode('advanced')
    } else if (mode === 'simple' && filterMode === 'advanced') {
      // Advanced -> Simple: clear rules (don't parse query back)
      setRules([])
      setQuery('')
      setFilterMode('simple')
    }
  }

  const clearFilter = () => {
    if (filterMode === 'simple') {
      setRules([])
    }
    setQuery('')
  }

  // Available filter fields for dropdown
  const filterFields = Object.keys(FILTER_FIELDS) as FilterFieldName[]

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white">
      {/* Filter Bar */}
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 space-y-2">
        {/* Header row with mode toggle and packet display toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Filter mode toggle */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-500">Filter:</span>
              <button
                onClick={() => handleModeSwitch('simple')}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  filterMode === 'simple'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Simple
              </button>
              <button
                onClick={() => handleModeSwitch('advanced')}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  filterMode === 'advanced'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Advanced
              </button>
            </div>

            <div className="h-4 w-px bg-gray-300" />

            {/* Packet display toggle */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-500">Show:</span>
              <button
                onClick={() => { setShowAllPackets(false); selectPacket(null) }}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  !showAllPackets
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                BGP Only
              </button>
              <button
                onClick={() => { setShowAllPackets(true); selectPacket(null) }}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  showAllPackets
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                All Packets
              </button>
            </div>
          </div>

          {/* Clear button */}
          {(query || rules.length > 0) && (
            <button
              onClick={clearFilter}
              className="px-3 py-1 text-xs text-gray-600 hover:bg-gray-200 rounded transition-colors"
            >
              Clear Filter
            </button>
          )}
        </div>

        {/* Filter input area */}
        {filterMode === 'advanced' ? (
          /* Advanced mode - text query input */
          <div className="flex items-center gap-2">
            <span className="text-gray-400 text-sm">Query:</span>
            <div className="flex-1">
              <QueryInput
                value={query}
                onChange={setQuery}
                packets={packets}
                hasError={hasParseErrors}
              />
            </div>
          </div>
        ) : (
          /* Simple mode - rule builder */
          <div className="space-y-2">
            {rules.length === 0 ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">No filters applied.</span>
                <button
                  onClick={addRule}
                  className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Filter
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                {rules.map((rule, index) => (
                  <div key={rule.id} className="flex items-center gap-2">
                    {index > 0 && (
                      <span className="text-xs text-gray-400 w-8 text-center">AND</span>
                    )}
                    {index === 0 && <span className="w-8" />}

                    {/* Field selector */}
                    <select
                      value={rule.field}
                      onChange={(e) => updateRule(rule.id, { field: e.target.value as FilterFieldName | '', value: '' })}
                      className="px-2 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 min-w-[100px]"
                    >
                      <option value="">Select field...</option>
                      {filterFields.map((field) => (
                        <option key={field} value={field}>{field}</option>
                      ))}
                    </select>

                    {/* Operator selector */}
                    <select
                      value={rule.operator}
                      onChange={(e) => updateRule(rule.id, { operator: e.target.value as Operator })}
                      className="px-2 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 w-16"
                    >
                      <option value="=">=</option>
                      <option value="!=">!=</option>
                    </select>

                    {/* Value selector */}
                    {(() => {
                      const values = getFieldValues(rule.field)
                      if (values.length > 0) {
                        return (
                          <select
                            value={rule.value}
                            onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                            className="px-2 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 min-w-[120px]"
                          >
                            <option value="">Select value...</option>
                            {values.map((v) => (
                              <option key={v} value={v}>{v}</option>
                            ))}
                          </select>
                        )
                      }
                      return (
                        <input
                          type="text"
                          value={rule.value}
                          onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                          placeholder="Enter value..."
                          className="px-2 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 min-w-[120px]"
                        />
                      )
                    })()}

                    {/* Remove button */}
                    <button
                      onClick={() => removeRule(rule.id)}
                      className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                      title="Remove filter"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}

                {/* Add rule button */}
                <button
                  onClick={addRule}
                  className="ml-8 px-2 py-1 text-xs text-gray-500 hover:text-blue-500 transition-colors flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Filter
                </button>
              </div>
            )}
          </div>
        )}

        {/* Status bar */}
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>
            Showing {displayPackets.length} of {showAllPackets ? allPackets.length : packets.length} packets
            {showAllPackets && ` (${packets.length} BGP)`}
          </span>
          {isFiltering && <span>filtering...</span>}
          {hasParseErrors && (
            <span className="text-red-500" title={parseErrors.map(e => e.message).join('; ')}>
              {parseErrors[0]?.message}
            </span>
          )}
        </div>
      </div>

      {/* Main content - split view */}
      <div ref={containerRef} className="flex-1 flex min-h-0">
        {/* Packet List */}
        <div className="w-1/2 border-r border-gray-200 flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            <PacketList
              packets={displayPackets}
              selectedIndex={selectedPacketIndex}
              onSelect={selectPacket}
              highlightedIndex={highlightedIndex}
            />
          </div>
        </div>

        {/* Packet Detail */}
        <div className="w-1/2 flex flex-col min-h-0 bg-white">
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between shrink-0">
            <span className="text-sm font-semibold text-gray-700">
              {selectedPacketIndex !== null ? `Packet #${displayPackets[selectedPacketIndex]?.packet.frameIndex}` : 'Packet Detail'}
            </span>
            {selectedBgpPacket && (
              <span className="text-xs text-gray-500">
                {selectedBgpPacket.messages.map(m => m.type).join(', ')}
              </span>
            )}
            {selectedGenericPacket && (
              <span className="text-xs text-gray-500">
                {selectedGenericPacket.protocol}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-auto">
            {selectedBgpPacket ? (
              <PacketDetail packet={selectedBgpPacket} />
            ) : selectedGenericPacket ? (
              <GenericPacketDetail packet={selectedGenericPacket} />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                Select a packet to view details
              </div>
            )}
          </div>
        </div>
      </div>
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
          <div className="col-span-2">
            <span className="text-gray-500">Timestamp:</span>
            <span className="ml-2 font-mono">{packet.timestamp.toISOString()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
