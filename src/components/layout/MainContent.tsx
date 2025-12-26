import { useState } from 'react'
import type { BgpPacket } from '../../lib/bgp/types'
import { useFilter } from '../../hooks/useFilter'
import { PacketList, QueryInput } from '../common'
import { PacketDetail } from '../message/PacketDetail'
import { NeighborSummary } from '../neighbor'

type ViewMode = 'packets' | 'neighbors'

interface MainContentProps {
  packets: BgpPacket[]
  selectedIndex: number | null
  onSelectPacket: (index: number | null) => void
  fileName: string | null
}

export function MainContent({
  packets,
  selectedIndex,
  onSelectPacket,
  fileName,
}: MainContentProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('packets')
  const { query, setQuery, filteredPackets, hasActiveFilter } = useFilter(packets)

  const selectedPacket = selectedIndex !== null ? filteredPackets[selectedIndex] : null

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center gap-4">
        {/* View Toggle */}
        <div className="flex rounded-md overflow-hidden border border-gray-300">
          <button
            onClick={() => setViewMode('packets')}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === 'packets'
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}
          >
            Packets
          </button>
          <button
            onClick={() => setViewMode('neighbors')}
            className={`px-3 py-1 text-xs font-medium transition-colors border-l border-gray-300 ${
              viewMode === 'neighbors'
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}
          >
            Neighbors
          </button>
        </div>

        {/* Query Input (only in packets view) */}
        {viewMode === 'packets' && (
          <>
            <QueryInput value={query} onChange={setQuery} packets={packets} />
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {hasActiveFilter
                ? `${filteredPackets.length} / ${packets.length} packets`
                : `${packets.length} packets`}
            </span>
          </>
        )}

        {/* File name (in neighbors view) */}
        {viewMode === 'neighbors' && fileName && (
          <span className="text-sm text-gray-600 font-medium">{fileName}</span>
        )}
      </div>

      {/* Content */}
      {viewMode === 'packets' ? (
        <div className="flex-1 flex flex-col lg:flex-row min-h-0">
          {/* Packet List */}
          <div className="lg:w-1/2 xl:w-3/5 border-b lg:border-b-0 lg:border-r border-gray-200 flex flex-col min-h-0">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
              <span className="text-sm text-gray-600">
                {fileName && <span className="font-medium">{fileName}</span>}
                {' - '}
                {filteredPackets.length} BGP message{filteredPackets.length !== 1 ? 's' : ''}
                {hasActiveFilter && ` (filtered from ${packets.length})`}
              </span>
              {selectedIndex !== null && (
                <button
                  onClick={() => onSelectPacket(null)}
                  className="text-xs text-gray-500 hover:text-gray-700 lg:hidden"
                >
                  Clear Selection
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              <PacketList
                packets={filteredPackets}
                selectedIndex={selectedIndex}
                onSelect={onSelectPacket}
              />
            </div>
          </div>

          {/* Packet Detail */}
          <div className="lg:w-1/2 xl:w-2/5 flex flex-col min-h-0 bg-white">
            {selectedPacket ? (
              <PacketDetail packet={selectedPacket} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                Select a packet to view details
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <NeighborSummary packets={packets} />
        </div>
      )}
    </div>
  )
}
