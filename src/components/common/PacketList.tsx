import { useCallback, useEffect, useRef } from 'react'
import type { BgpPacket, BgpMessage } from '../../lib/bgp/types'

interface PacketListProps {
  packets: BgpPacket[]
  selectedIndex: number | null
  onSelect: (index: number) => void
  baseTimestamp?: Date
}

const messageTypeColors: Record<string, string> = {
  OPEN: 'bg-bgp-open text-white',
  UPDATE: 'bg-bgp-update text-white',
  NOTIFICATION: 'bg-bgp-notification text-white',
  KEEPALIVE: 'bg-bgp-keepalive text-white',
  ROUTE_REFRESH: 'bg-cyan-500 text-white',
}

function formatTime(timestamp: Date, base?: Date): string {
  if (base) {
    const diff = timestamp.getTime() - base.getTime()
    const seconds = diff / 1000
    const minutes = Math.floor(seconds / 60)
    const secs = (seconds % 60).toFixed(3)
    return `${minutes.toString().padStart(2, '0')}:${secs.padStart(6, '0')}`
  }
  return timestamp.toISOString().slice(11, 23)
}

function getMessageSummary(message: BgpMessage): string {
  switch (message.type) {
    case 'OPEN':
      const as = message.fourByteAs ?? message.myAs
      return `AS${as} Hold=${message.holdTime}`
    case 'UPDATE':
      return `WR=${message.withdrawnRoutesLength} PA=${message.totalPathAttrLength}`
    case 'NOTIFICATION':
      return `${message.errorCodeName}/${message.errorSubcodeName}`
    case 'KEEPALIVE':
      return ''
    case 'ROUTE_REFRESH':
      return `${message.afiName}/${message.safiName}`
    default:
      return ''
  }
}

export function PacketList({ packets, selectedIndex, onSelect, baseTimestamp }: PacketListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const base = baseTimestamp ?? packets[0]?.timestamp

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (packets.length === 0) return

      const current = selectedIndex ?? -1

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.min(current + 1, packets.length - 1)
        onSelect(next)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = Math.max(current - 1, 0)
        onSelect(prev)
      } else if (e.key === 'Escape') {
        e.preventDefault()
      }
    },
    [packets.length, selectedIndex, onSelect]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex !== null && listRef.current) {
      const item = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
      item?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  return (
    <div ref={listRef} className="h-full overflow-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 sticky top-0">
          <tr className="text-left text-gray-600">
            <th className="px-2 py-2 w-12 font-medium">#</th>
            <th className="px-2 py-2 w-24 font-medium">Time</th>
            <th className="px-2 py-2 font-medium">Source</th>
            <th className="px-2 py-2 font-medium">Destination</th>
            <th className="px-2 py-2 w-28 font-medium">Type</th>
            <th className="px-2 py-2 font-medium">Info</th>
          </tr>
        </thead>
        <tbody>
          {packets.map((packet, index) => {
            const isSelected = index === selectedIndex
            const typeClass = messageTypeColors[packet.message.type] ?? 'bg-gray-500 text-white'

            return (
              <tr
                key={index}
                data-index={index}
                onClick={() => onSelect(index)}
                className={`
                  cursor-pointer border-b border-gray-100
                  ${isSelected ? 'bg-blue-100' : 'hover:bg-gray-50'}
                `}
              >
                <td className="px-2 py-1.5 text-gray-500 font-mono">{index + 1}</td>
                <td className="px-2 py-1.5 font-mono text-gray-600">
                  {formatTime(packet.timestamp, base)}
                </td>
                <td className="px-2 py-1.5 font-mono">
                  {packet.srcIp}:{packet.srcPort}
                </td>
                <td className="px-2 py-1.5 font-mono">
                  {packet.dstIp}:{packet.dstPort}
                </td>
                <td className="px-2 py-1.5">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${typeClass}`}>
                    {packet.message.type}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-gray-600 truncate max-w-xs">
                  {getMessageSummary(packet.message)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
