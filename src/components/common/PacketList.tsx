import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BgpMessage, BgpPacket, BgpUpdateMessage } from '../../lib/bgp/types'
import type { GenericPacket } from '../../lib/pcap'

/**
 * A row in the packet list: either a packet the BGP parser understood, or a
 * plain IP packet shown in "All Packets" mode.
 */
export type DisplayPacket =
  | { kind: 'bgp'; packet: BgpPacket; timestamp: Date }
  | { kind: 'generic'; packet: GenericPacket; timestamp: Date }

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
      return <span className="text-muted font-mono">{frameIndex}</span>
    },
  },
  {
    id: 'time',
    label: 'Relative',
    width: 'w-20',
    getValue: (dp, _, base) => (
      <span className="font-mono text-muted">{formatRelativeTime(dp.timestamp, base)}</span>
    ),
  },
  {
    id: 'absTime',
    label: 'Absolute',
    width: 'w-28',
    getValue: (dp) => (
      <span className="font-mono text-muted">{formatAbsoluteTime(dp.timestamp)}</span>
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
      return <span className="font-mono text-muted">{port ?? '-'}</span>
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
      return <span className="font-mono text-muted">{port ?? '-'}</span>
    },
  },
  {
    id: 'protocol',
    label: 'Proto',
    width: 'w-16',
    getValue: (dp) => {
      // Protocol is a category, not a state, so it is ranked by prominence
      // rather than hue. Tinting UDP green and ICMP amber would read as health
      // and warning in a tool people open to find faults; and the severity and
      // msg-* palettes have to keep meaning what they say. BGP rows carry the
      // subject of the app, so they stay prominent while the rest recede.
      if (dp.kind === 'bgp') {
        return <span className="text-xs font-semibold text-strong">BGP</span>
      }
      return <span className="text-xs font-medium text-dim">{dp.packet.protocol}</span>
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
          const typeClass = messageTypeColors[messages[0].type] ?? 'bg-surface-sunken text-muted'
          return (
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${typeClass}`}>
              {messages[0].type}
            </span>
          )
        }
        // Multiple messages - show count and primary type
        const primaryType = messages[0].type
        const typeClass = messageTypeColors[primaryType] ?? 'bg-surface-sunken text-muted'
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
        return <span className="font-mono text-xs text-muted">[{flags.join('')}]</span>
      }
      return <span className="text-dim">-</span>
    },
  },
  {
    id: 'info',
    label: 'Info',
    getValue: (dp) => {
      if (dp.kind === 'bgp') {
        const messages = dp.packet.messages
        if (messages.length === 1) {
          return <span className="text-muted truncate">{getMessageSummary(messages[0])}</span>
        }
        // Multiple messages - show count
        return <span className="text-muted truncate">{messages.length} msgs</span>
      }
      // For generic packets, show port info
      const src = dp.packet.srcPort ?? '?'
      const dst = dp.packet.dstPort ?? '?'
      return <span className="text-muted truncate">{src} → {dst}</span>
    },
  },
  {
    id: 'length',
    label: 'Len',
    width: 'w-14',
    getValue: (dp) => {
      if (dp.kind === 'generic') {
        return <span className="font-mono text-muted">{dp.packet.payloadLength}</span>
      }
      return <span className="font-mono text-muted">-</span>
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
        return <span className="font-mono text-xs text-muted">{asns.join(' ')}</span>
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
      return total > 0 ? <span className="font-mono text-ok">{total}</span> : null
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
      return total > 0 ? <span className="font-mono text-critical">{total}</span> : null
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

// Message-type badges use a tinted background derived from the message colour
// itself (opacity modifier) rather than a solid fill: the msg-* tokens are
// calibrated as *text* colours that stay legible on the canvas in both
// palettes (e.g. msg-open flips from a dark green in light mode to a bright
// green in dark mode). A solid fill with a fixed white foreground would lose
// contrast in dark mode once the token brightens, so text stays the message
// colour and only the background gets a low-opacity tint of the same colour.
const messageTypeColors: Record<string, string> = {
  OPEN: 'bg-bgp-open/15 text-bgp-open',
  UPDATE: 'bg-bgp-update/15 text-bgp-update',
  NOTIFICATION: 'bg-bgp-notification/15 text-bgp-notification',
  KEEPALIVE: 'bg-bgp-keepalive/15 text-bgp-keepalive',
  ROUTE_REFRESH: 'bg-bgp-route-refresh/15 text-bgp-route-refresh',
}

// Virtualization tuning. Row/header heights are measured from the live DOM
// once rows exist; these are just first-paint estimates so the initial
// windowed range is roughly right before real measurements land.
const ESTIMATED_ROW_HEIGHT = 29
const ESTIMATED_HEADER_HEIGHT = 33
const OVERSCAN_ROWS = 8

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
  // The scroll container (listRef) and the grid (gridRef) are separate elements:
  // scrolling happens on the div, focus and grid semantics live on the table.
  const gridRef = useRef<HTMLTableElement>(null)
  const columnPickerRef = useRef<HTMLDivElement>(null)
  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(loadSavedColumns)
  const [showColumnPicker, setShowColumnPicker] = useState(false)
  const [rowHeight, setRowHeight] = useState(ESTIMATED_ROW_HEIGHT)
  const [headerHeight, setHeaderHeight] = useState(ESTIMATED_HEADER_HEIGHT)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const base = baseTimestamp ?? packets[0]?.timestamp
  const totalCount = packets.length

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

  // Track the scrollable viewport's height synchronously (before paint) so the
  // very first windowed render already covers the visible area, then keep it
  // updated as the container is resized (e.g. pane resizing, window resize).
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setViewportHeight(entry.contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (el) setScrollTop(el.scrollTop)
  }, [])

  // Measure the real rendered row/header height from the DOM instead of
  // trusting the estimate forever - fonts/zoom/DPI can shift it slightly.
  // Only updates state when the measurement actually differs, so this
  // converges after one or two renders rather than looping.
  const measureRowRef = useCallback((el: HTMLTableRowElement | null) => {
    if (!el) return
    const measured = el.getBoundingClientRect().height
    if (measured > 0) {
      setRowHeight((prev) => (Math.abs(prev - measured) > 0.5 ? measured : prev))
    }
  }, [])

  const measureHeaderRef = useCallback((el: HTMLTableSectionElement | null) => {
    if (!el) return
    const measured = el.getBoundingClientRect().height
    if (measured > 0) {
      setHeaderHeight((prev) => (Math.abs(prev - measured) > 0.5 ? measured : prev))
    }
  }, [])

  // Windowing: only rows within [startIndex, endIndex) are mounted, padded
  // above/below with spacer rows so the scrollbar length/position stays
  // correct for the full (unwindowed) dataset.
  const availableHeight = Math.max(0, viewportHeight - headerHeight)
  const rawStartIndex = Math.floor(scrollTop / rowHeight)
  const visibleRowCount = Math.ceil(availableHeight / rowHeight) + 1
  const startIndex = Math.max(0, rawStartIndex - OVERSCAN_ROWS)
  const endIndex = Math.min(totalCount, rawStartIndex + visibleRowCount + OVERSCAN_ROWS)
  const topSpacerHeight = startIndex * rowHeight
  const bottomSpacerHeight = Math.max(0, (totalCount - endIndex) * rowHeight)

  // If the dataset shrinks (new capture, filter applied) while scrolled far
  // down, clamp back into range instead of leaving an empty overscroll.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const maxScrollTop = Math.max(0, totalCount * rowHeight - availableHeight)
    if (el.scrollTop > maxScrollTop) {
      el.scrollTop = maxScrollTop
      setScrollTop(maxScrollTop)
    }
  }, [totalCount, rowHeight, availableHeight])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
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

  // Keep the selected row scrolled into view, whether it moved via keyboard
  // navigation or an external prop change (e.g. jumping to a packet from
  // elsewhere in the UI). This works purely from index/height math rather
  // than querying the DOM, since a keyboard-selected row may currently be
  // outside the windowed range and thus not mounted at all. Runs in a layout
  // effect so the resulting scrollTop update lands before paint.
  useLayoutEffect(() => {
    const el = listRef.current
    if (selectedIndex === null || !el) return

    const rowTop = selectedIndex * rowHeight
    const rowBottom = rowTop + rowHeight
    const viewTop = el.scrollTop
    const viewBottom = el.scrollTop + el.clientHeight - headerHeight

    let nextScrollTop: number | null = null
    if (rowTop < viewTop) {
      nextScrollTop = rowTop
    } else if (rowBottom > viewBottom) {
      nextScrollTop = rowBottom - el.clientHeight + headerHeight
    }

    if (nextScrollTop !== null) {
      el.scrollTop = nextScrollTop
      setScrollTop(nextScrollTop)
    }
  }, [selectedIndex, rowHeight, headerHeight])

  const handleRowClick = useCallback(
    (index: number) => {
      onSelect(index)
      // Keep the grid focused so keyboard navigation continues to work
      // right after a mouse selection.
      gridRef.current?.focus()
    },
    [onSelect]
  )

  return (
    <div
      ref={listRef}
      className="h-full overflow-auto relative focus-within:ring-2 focus-within:ring-accent focus-within:ring-inset"
      onScroll={handleScroll}
    >
      {/* The grid role belongs on the table itself: a role="grid" wrapper around a
          plain <table> leaves the grid owning no rows, so aria-rowcount and
          aria-activedescendant would refer to nothing. The div is scroll-only. */}
      <table
        ref={gridRef}
        className="w-full text-sm focus:outline-none"
        tabIndex={0}
        role="grid"
        aria-rowcount={totalCount}
        aria-colcount={columns.length + 1}
        aria-multiselectable="false"
        aria-activedescendant={selectedIndex !== null ? `packet-row-${selectedIndex}` : undefined}
        onKeyDown={handleKeyDown}
      >
        <thead ref={measureHeaderRef} className="bg-surface-sunken sticky top-0 z-10" role="rowgroup">
          <tr className="text-left text-muted" role="row">
            {columns.map((col) => (
              <th key={col.id} role="columnheader" className={`px-2 py-2 font-medium ${col.width ?? ''}`}>
                {col.label}
              </th>
            ))}
            <th role="columnheader" className="px-2 py-2 w-8">
              <button
                onClick={() => setShowColumnPicker(!showColumnPicker)}
                className="text-dim hover:text-muted p-0.5 rounded hover:bg-surface-sunken"
                title="Configure columns"
                aria-label="Configure columns"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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
        <tbody role="rowgroup">
          {topSpacerHeight > 0 && (
            <tr role="presentation" aria-hidden="true" style={{ height: topSpacerHeight }}>
              <td colSpan={columns.length + 1} style={{ padding: 0, border: 0 }} />
            </tr>
          )}
          {packets.slice(startIndex, endIndex).map((dp, i) => {
            const index = startIndex + i
            const isSelected = index === selectedIndex
            const isHighlighted = index === highlightedIndex
            const isBgp = dp.kind === 'bgp'

            return (
              <tr
                key={index}
                id={`packet-row-${index}`}
                data-index={index}
                ref={index === startIndex ? measureRowRef : undefined}
                role="row"
                aria-selected={isSelected}
                aria-rowindex={index + 1}
                onClick={() => handleRowClick(index)}
                className={`
                  cursor-pointer border-b border-hair transition-colors duration-300
                  ${isHighlighted ? 'animate-flash' : ''}
                  ${isSelected ? 'bg-accent-subtle' : isBgp ? 'hover:bg-surface-sunken' : 'bg-surface-sunken/50 hover:bg-surface-raised'}
                `}
              >
                {columns.map((col) => (
                  <td key={col.id} role="gridcell" className={`px-2 py-1.5 ${col.width ?? ''}`}>
                    {col.getValue(dp, index, base)}
                  </td>
                ))}
                <td role="gridcell" className="px-2 py-1.5 w-8" />
              </tr>
            )
          })}
          {bottomSpacerHeight > 0 && (
            <tr role="presentation" aria-hidden="true" style={{ height: bottomSpacerHeight }}>
              <td colSpan={columns.length + 1} style={{ padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>

      {/* Column Picker Dropdown */}
      {showColumnPicker && (
        <div
          ref={columnPickerRef}
          className="absolute top-8 right-2 bg-surface-raised border border-hair rounded-lg shadow-lg p-2 z-20 min-w-48"
        >
          <div className="text-xs font-medium text-dim uppercase tracking-wide mb-2 px-2">
            Visible Columns
          </div>
          {ALL_COLUMNS.map((col) => (
            <label
              key={col.id}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-surface-sunken rounded cursor-pointer"
            >
              <input
                type="checkbox"
                checked={visibleColumns.includes(col.id)}
                onChange={() => toggleColumn(col.id)}
                className="rounded border-hair-strong text-accent focus:ring-accent"
              />
              <span className="text-sm text-body">{col.label}</span>
            </label>
          ))}
          <div className="border-t border-hair mt-2 pt-2 px-2">
            <button
              onClick={() => setVisibleColumns(DEFAULT_COLUMNS)}
              className="text-xs text-accent hover:text-accent-hover"
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
