import { useCallback, useEffect, useState } from 'react'

/**
 * Which columns the packet list shows, and in what order.
 *
 * Lives apart from the list because the control that changes it does not sit
 * in the list any more: a Columns button inside the table's last header cell
 * scrolled out of view as soon as the table was wider than its pane, which at
 * 1280–1440px it usually was. The list renders whatever this says; the button
 * lives in the status bar, where horizontal scrolling cannot reach it.
 */
export type PacketColumnId =
  | 'index'
  | 'time'
  | 'delta'
  | 'absTime'
  | 'src'
  | 'dst'
  | 'srcPort'
  | 'dstPort'
  | 'protocol'
  | 'type'
  | 'info'
  | 'asPath'
  | 'nlriCount'
  | 'withdrawnCount'
  | 'length'

/** Every column, in the order the list lays them out, with its header text. */
export const PACKET_COLUMNS: { id: PacketColumnId; label: string }[] = [
  { id: 'index', label: '#' },
  { id: 'time', label: 'Relative' },
  { id: 'delta', label: 'Delta' },
  { id: 'absTime', label: 'Absolute (UTC)' },
  { id: 'src', label: 'Source' },
  { id: 'srcPort', label: 'Src Port' },
  { id: 'dst', label: 'Destination' },
  { id: 'dstPort', label: 'Dst Port' },
  { id: 'protocol', label: 'Proto' },
  { id: 'type', label: 'Type' },
  { id: 'info', label: 'Info' },
  { id: 'length', label: 'Len' },
  { id: 'asPath', label: 'AS Path' },
  { id: 'nlriCount', label: 'NLRI' },
  { id: 'withdrawnCount', label: 'WR' },
]

/**
 * Info carries an UPDATE's prefixes, so the question people open a BGP capture
 * with — which routes moved — is answered without the column picker. The rest
 * are the frame identity columns.
 */
export const DEFAULT_PACKET_COLUMNS: PacketColumnId[] = ['index', 'time', 'src', 'dst', 'type', 'info']

const STORAGE_KEY = 'bgpshark-visible-columns'

/**
 * A saved set is dropped only for ids that no longer exist, never for ids it
 * is missing: adding a column (or a default) must leave everyone who has
 * already arranged their columns exactly as they were.
 */
function loadSavedColumns(): PacketColumnId[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      // The Prefix column was folded into Info. Someone who kept Prefix but
      // hid Info still wants to see prefixes, so the one becomes the other.
      const parsed = (JSON.parse(saved) as string[]).map((id) => (id === 'prefix' ? 'info' : id))
      const valid = parsed.filter((id): id is PacketColumnId => PACKET_COLUMNS.some((col) => col.id === id))
      if (valid.length > 0) return [...new Set(valid)]
    }
  } catch {
    // Unreadable or blocked storage falls back to the defaults.
  }
  return DEFAULT_PACKET_COLUMNS
}

export function usePacketColumns() {
  const [visibleColumns, setVisibleColumns] = useState<PacketColumnId[]>(loadSavedColumns)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(visibleColumns))
    } catch {
      // Not remembering the columns is not a reason to refuse to change them.
    }
  }, [visibleColumns])

  const toggleColumn = useCallback((columnId: PacketColumnId) => {
    setVisibleColumns((prev) => {
      if (prev.includes(columnId)) {
        // Never leave the list with no columns at all.
        if (prev.length <= 1) return prev
        return prev.filter((id) => id !== columnId)
      }
      const next = [...prev, columnId]
      return PACKET_COLUMNS.filter((c) => next.includes(c.id)).map((c) => c.id)
    })
  }, [])

  const resetColumns = useCallback(() => setVisibleColumns(DEFAULT_PACKET_COLUMNS), [])

  return { visibleColumns, toggleColumn, resetColumns }
}
