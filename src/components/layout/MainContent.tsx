import type { BgpPacket } from '../../lib/bgp/types'
import { PacketList } from '../common/PacketList'
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
  const selectedPacket = selectedIndex !== null ? packets[selectedIndex] : null

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0">
      {/* Packet List */}
      <div className="lg:w-1/2 xl:w-3/5 border-b lg:border-b-0 lg:border-r border-gray-200 flex flex-col min-h-0">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <span className="text-sm text-gray-600">
            {fileName && <span className="font-medium">{fileName}</span>}
            {' - '}
            {packets.length} BGP message{packets.length !== 1 ? 's' : ''}
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
            packets={packets}
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
  )
}
