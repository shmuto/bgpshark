import { useCallback, useEffect, useRef, useState } from 'react'
import type { BgpMessage, BgpUpdateMessage } from '../../lib/bgp/types'
import type { DisplayPacket } from '../layout/MainContent'

// Column definitions
type ColumnId = 'index' | 'time' | 'absTime' | 'src' | 'dst' | 'srcPort' | 'dstPort' | 'protocol' | 'type' | 'info' | 'asPath' | 'nlriCount' | 'withdrawnCount' | 'length'

const STORAGE_KEY = 'bgpshark-visible-columns'

interface ColumnDef {
  id: ColumnId
  label: string
  width?: string
  getValue: (dp: DisplayPacket, index: number, baseTime?: Date) => React.ReactNode
}

const ALL_COLUMNS: ColumnDef[] = [
  {
    id: 'index',
    label: '#',
    width: 'w-12',
    getValue: (dp) => {
      const frameIndex = dp.kind === 'bgp' ? dp.packet.frameIndex : dp.packet.frameIndex
      return <span className="text-gray-500 font-mono">{frameIndex}</span>
    },
  },
  {
    id: 'time',
    label: 'Relative',
    width: 'w-20',
    getValue: (dp, _, base) => (
      <span className="font-mono text-gray-600">{formatRelativeTime(dp.timestamp, base)}</span>
    ),
  },
  {
    id: 'absTime',
    label: 'Absolute',
    width: 'w-28',
    getValue: (dp) => (
      <span className="font-mono text-gray-600">{formatAbsoluteTime(dp.timestamp)}</span>
    ),
  },
  {
    id: 'src',
    label: 'Source',
    getValue: (dp) => {
      const ip = dp.kind === 'bgp' ? dp.packet.srcIp : dp.packet.srcIp
      return <span className="font-mono">{ip}</span>
    },
  },
  {
    id: 'srcPort',
    label: 'Src Port',
    width: 'w-16',
    getValue: (dp) => {
      const port = dp.kind === 'bgp' ? dp.packet.srcPort : dp.packet.srcPort
      return <span className="font-mono text-gray-500">{port ?? '-'}</span>
    },
  },
  {
    id: 'dst',
    label: 'Destination',
    getValue: (dp) => {
      const ip = dp.kind === 'bgp' ? dp.packet.dstIp : dp.packet.dstIp
      return <span className="font-mono">{ip}</span>
    },
  },
  {
    id: 'dstPort',
    label: 'Dst Port',
    width: 'w-16',
    getValue: (dp) => {
      const port = dp.kind === 'bgp' ? dp.packet.dstPort : dp.packet.dstPort
      return <span className="font-mono text-gray-500">{port ?? '-'}</span>
    },
  },
  {
    id: 'protocol',
    label: 'Proto',
    width: 'w-16',
    getValue: (dp) => {
      if (dp.kind === 'bgp') {
        return <span className="text-xs font-medium text-purple-700">BGP</span>
      }
      const proto = dp.packet.protocol
      const colorClass = proto === 'TCP' ? 'text-blue-600' :
                        proto === 'UDP' ? 'text-green-600' :
                        proto === 'ICMP' ? 'text-yellow-600' : 'text-gray-600'
      return <span className={`text-xs font-medium ${colorClass}`}>{proto}</span>
    },
  },
  {
    id: 'type',
    label: 'Type',
    width: 'w-28',
    getValue: (dp) => {
      if (dp.kind === 'bgp') {
        const messages = dp.packet.messages
        if (messages.length === 1) {
          const typeClass = messageTypeColors[messages[0].type] ?? 'bg-gray-500 text-white'
          return (
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${typeClass}`}>
              {messages[0].type}
            </span>
          )
        }
        // Multiple messages - show count and primary type
        const primaryType = messages[0].type
        const typeClass = messageTypeColors[primaryType] ?? 'bg-gray-500 text-white'
        return (
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${typeClass}`}>
            {primaryType} +{messages.length - 1}
          </span>
        )
      }
      // For generic packets, show TCP flags if available
      if (dp.packet.tcpFlags) {
        const flags: string[] = []
        if (dp.packet.tcpFlags.syn) flags.push('S')
        if (dp.packet.tcpFlags.ack) flags.push('A')
        if (dp.packet.tcpFlags.fin) flags.push('F')
        if (dp.packet.tcpFlags.rst) flags.push('R')
        if (dp.packet.tcpFlags.psh) flags.push('P')
        return <span className="font-mono text-xs text-gray-500">[{flags.join('')}]</span>
      }
      return <span className="text-gray-400">-</span>
    },
  },
  {
    id: 'info',
    label: 'Info',
    getValue: (dp) => {
      if (dp.kind === 'bgp') {
        const messages = dp.packet.messages
        if (messages.length === 1) {
          return <span className="text-gray-600 truncate">{getMessageSummary(messages[0])}</span>
        }
        // Multiple messages - show count
        return <span className="text-gray-600 truncate">{messages.length} msgs</span>
      }
      // For generic packets, show port info
      const src = dp.packet.srcPort ?? '?'
      const dst = dp.packet.dstPort ?? '?'
      return <span className="text-gray-500 truncate">{src} → {dst}</span>
    },
  },
  {
    id: 'length',
    label: 'Len',
    width: 'w-14',
    getValue: (dp) => {
      if (dp.kind === 'generic') {
        return <span className="font-mono text-gray-500">{dp.packet.payloadLength}</span>
      }
      return <span className="font-mono text-gray-500">-</span>
    },
  },
  {
    id: 'asPath',
    label: 'AS Path',
    getValue: (dp) => {
      if (dp.kind !== 'bgp') return null
      // Find first UPDATE message with AS_PATH
      for (const msg of dp.packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const update = msg as BgpUpdateMessage
        const asPathAttr = update.pathAttributes?.find((a) => a.typeName === 'AS_PATH')
        if (!asPathAttr?.parsed || asPathAttr.parsed.type !== 'AS_PATH') continue
        const asns = asPathAttr.parsed.segments.flatMap((s) => s.asNumbers)
        return <span className="font-mono text-xs text-gray-600">{asns.join(' ')}</span>
      }
      return null
    },
  },
  {
    id: 'nlriCount',
    label: 'NLRI',
    width: 'w-12',
    getValue: (dp) => {
      if (dp.kind !== 'bgp') return null
      // Sum NLRI from all UPDATE messages
      let total = 0
      for (const msg of dp.packet.messages) {
        if (msg.type === 'UPDATE') {
          total += (msg as BgpUpdateMessage).nlri?.length ?? 0
        }
      }
      return total > 0 ? <span className="font-mono text-green-600">{total}</span> : null
    },
  },
  {
    id: 'withdrawnCount',
    label: 'WR',
    width: 'w-12',
    getValue: (dp) => {
      if (dp.kind !== 'bgp') return null
      // Sum withdrawn routes from all UPDATE messages
      let total = 0
      for (const msg of dp.packet.messages) {
        if (msg.type === 'UPDATE') {
          total += (msg as BgpUpdateMessage).withdrawnRoutes?.length ?? 0
        }
      }
      return total > 0 ? <span className="font-mono text-red-600">{total}</span> : null
    },
  },
]

const DEFAULT_COLUMNS: ColumnId[] = ['index', 'time', 'src', 'dst', 'type', 'info']

interface PacketListProps {
  packets: DisplayPacket[]
  selectedIndex: number | null
  onSelect: (index: number) => void
  baseTimestamp?: Date
  highlightedIndex?: number | null
}

const messageTypeColors: Record<string, string> = {
  OPEN: 'bg-bgp-open text-white',
  UPDATE: 'bg-bgp-update text-white',
  NOTIFICATION: 'bg-bgp-notification text-white',
  KEEPALIVE: 'bg-bgp-keepalive text-white',
  ROUTE_REFRESH: 'bg-cyan-500 text-white',
}

function formatRelativeTime(timestamp: Date, base?: Date): string {
  if (base) {
    const diff = timestamp.getTime() - base.getTime()
    const seconds = diff / 1000
    return seconds.toFixed(3)
  }
  return '0.000'
}

function formatAbsoluteTime(timestamp: Date): string {
  return timestamp.toISOString().slice(11, 23)
}

function getMessageSummary(message: BgpMessage): string {
  switch (message.type) {
    case 'OPEN': {
      const as = message.fourByteAs ?? message.myAs
      return `AS${as} Hold=${message.holdTime}`
    }
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

function loadSavedColumns(): ColumnId[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as string[]
      // Validate that all saved columns still exist
      const validColumns = parsed.filter((id): id is ColumnId =>
        ALL_COLUMNS.some((col) => col.id === id)
      )
      if (validColumns.length > 0) {
        return validColumns
      }
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_COLUMNS
}

export function PacketList({ packets, selectedIndex, onSelect, baseTimestamp, highlightedIndex }: PacketListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const columnPickerRef = useRef<HTMLDivElement>(null)
  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(loadSavedColumns)
  const [showColumnPicker, setShowColumnPicker] = useState(false)
  const base = baseTimestamp ?? packets[0]?.timestamp

  // Save columns to localStorage when they change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visibleColumns))
  }, [visibleColumns])

  const columns = visibleColumns
    .map((id) => ALL_COLUMNS.find((c) => c.id === id))
    .filter((c): c is ColumnDef => c !== undefined)

  const toggleColumn = useCallback((columnId: ColumnId) => {
    setVisibleColumns((prev) => {
      if (prev.includes(columnId)) {
        // Don't allow removing all columns
        if (prev.length <= 1) return prev
        return prev.filter((id) => id !== columnId)
      } else {
        // Add in the order defined in ALL_COLUMNS
        const newColumns = [...prev, columnId]
        return ALL_COLUMNS.filter((c) => newColumns.includes(c.id)).map((c) => c.id)
      }
    })
  }, [])

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
        setShowColumnPicker(false)
      }
    },
    [packets.length, selectedIndex, onSelect]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Close column picker when clicking outside
  useEffect(() => {
    if (!showColumnPicker) return

    const handleClickOutside = (e: MouseEvent) => {
      if (columnPickerRef.current && !columnPickerRef.current.contains(e.target as Node)) {
        setShowColumnPicker(false)
      }
    }

    // Add listener with a small delay to avoid closing immediately on the same click that opened it
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClickOutside)
    }
  }, [showColumnPicker])

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex !== null && listRef.current) {
      const item = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
      item?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  return (
    <div ref={listRef} className="h-full overflow-auto relative">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 sticky top-0 z-10">
          <tr className="text-left text-gray-600">
            {columns.map((col) => (
              <th key={col.id} className={`px-2 py-2 font-medium ${col.width ?? ''}`}>
                {col.label}
              </th>
            ))}
            <th className="px-2 py-2 w-8">
              <button
                onClick={() => setShowColumnPicker(!showColumnPicker)}
                className="text-gray-400 hover:text-gray-600 p-0.5 rounded hover:bg-gray-200"
                title="Configure columns"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                  />
                </svg>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {packets.map((dp, index) => {
            const isSelected = index === selectedIndex
            const isHighlighted = index === highlightedIndex
            const isBgp = dp.kind === 'bgp'

            return (
              <tr
                key={index}
                data-index={index}
                onClick={() => onSelect(index)}
                className={`
                  cursor-pointer border-b border-gray-100 transition-colors duration-300
                  ${isHighlighted ? 'animate-flash bg-yellow-200' : ''}
                  ${isSelected ? 'bg-blue-100' : isBgp ? 'hover:bg-gray-50' : 'hover:bg-gray-50 bg-gray-50/50'}
                `}
              >
                {columns.map((col) => (
                  <td key={col.id} className={`px-2 py-1.5 ${col.width ?? ''}`}>
                    {col.getValue(dp, index, base)}
                  </td>
                ))}
                <td className="px-2 py-1.5 w-8" />
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* Column Picker Dropdown */}
      {showColumnPicker && (
        <div
          ref={columnPickerRef}
          className="absolute top-8 right-2 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-20 min-w-48"
        >
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 px-2">
            Visible Columns
          </div>
          {ALL_COLUMNS.map((col) => (
            <label
              key={col.id}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 rounded cursor-pointer"
            >
              <input
                type="checkbox"
                checked={visibleColumns.includes(col.id)}
                onChange={() => toggleColumn(col.id)}
                className="rounded border-gray-300 text-blue-500 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">{col.label}</span>
            </label>
          ))}
          <div className="border-t border-gray-200 mt-2 pt-2 px-2">
            <button
              onClick={() => setVisibleColumns(DEFAULT_COLUMNS)}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
