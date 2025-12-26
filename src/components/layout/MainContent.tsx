import type { BgpPacket } from '../../lib/bgp/types'
import { useFilter } from '../../hooks/useFilter'
import { PacketList, QueryInput } from '../common'
import { PacketDetail } from '../message/PacketDetail'

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
  const { query, setQuery, filteredPackets, hasActiveFilter } = useFilter(packets)

  const selectedPacket = selectedIndex !== null ? filteredPackets[selectedIndex] : null

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Query Filter Bar */}
      <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center gap-4">
        <QueryInput value={query} onChange={setQuery} packets={packets} />
        <span className="text-xs text-gray-500 whitespace-nowrap">
          {hasActiveFilter
            ? `${filteredPackets.length} / ${packets.length} packets`
            : `${packets.length} packets`}
        </span>
      </div>

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
    </div>
  )
}
