import { useEffect, useRef, useState } from 'react'
import { PACKET_COLUMNS, type PacketColumnId } from '../../hooks/usePacketColumns'

interface ColumnPickerProps {
  visibleColumns: PacketColumnId[]
  onToggle: (id: PacketColumnId) => void
  onReset: () => void
}

/**
 * The packet list's Columns button and its menu.
 *
 * The button carries a word: which columns exist is the whole answer to
 * "where are the prefixes / the AS path", and an unlabelled icon does not
 * offer it.
 */
export function ColumnPicker({ visibleColumns, onToggle, onReset }: ColumnPickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-muted hover:text-strong px-1.5 py-0.5 rounded hover:bg-surface-raised"
        title="Configure columns"
        aria-label="Configure columns"
        aria-expanded={open}
      >
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
          />
        </svg>
        <span className="text-xs font-medium">Columns</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 bg-surface-raised border border-hair rounded-lg shadow-lg p-2 z-30 min-w-48">
          <div className="text-xs font-medium text-dim uppercase tracking-wide mb-2 px-2">Visible Columns</div>
          {PACKET_COLUMNS.map((col) => (
            <label
              key={col.id}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-surface-sunken rounded cursor-pointer"
            >
              <input
                type="checkbox"
                checked={visibleColumns.includes(col.id)}
                onChange={() => onToggle(col.id)}
                className="rounded border-hair-strong text-accent focus:ring-accent"
              />
              <span className="text-sm text-body">{col.label}</span>
            </label>
          ))}
          <div className="border-t border-hair mt-2 pt-2 px-2">
            <button onClick={onReset} className="text-xs text-accent hover:text-accent-hover">
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
