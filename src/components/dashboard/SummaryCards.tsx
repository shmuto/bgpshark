import type { BgpMessageTypeName } from '../../lib/bgp/types'
import type { SummaryData } from './types'

interface TypeBadgeDef {
  type: BgpMessageTypeName
  label: string
  colorClass: string
  /**
   * Whether a zero is worth showing. "No NOTIFICATION" is a finding — the
   * sessions did not tear down — so the badge stays, dimmed. A capture without
   * ROUTE-REFRESH says nothing at all, and is most captures, so the badge goes.
   */
  showZero: boolean
}

const TYPE_BADGES: TypeBadgeDef[] = [
  { type: 'OPEN', label: 'OPEN', colorClass: 'bg-bgp-open/15 text-bgp-open', showZero: true },
  { type: 'UPDATE', label: 'UPDATE', colorClass: 'bg-bgp-update/15 text-bgp-update', showZero: true },
  { type: 'NOTIFICATION', label: 'NOTIFICATION', colorClass: 'bg-bgp-notification/15 text-bgp-notification', showZero: true },
  { type: 'KEEPALIVE', label: 'KEEPALIVE', colorClass: 'bg-bgp-keepalive/15 text-bgp-keepalive', showZero: true },
  { type: 'ROUTE_REFRESH', label: 'ROUTE-REFRESH', colorClass: 'bg-bgp-route-refresh/15 text-bgp-route-refresh', showZero: false },
]

interface SummaryCardsProps {
  summary: SummaryData
  onSelect: (filter: string | null) => void
}

/**
 * The capture's size and message mix, as one strip.
 *
 * This used to be six equal cards, with "Packets" standing beside the per-type
 * counts as if it were their total. It is not — one TCP segment can carry
 * several BGP messages — so the counts never added up to it and every reader
 * stopped to wonder why. Packets and messages are now stated side by side in
 * one sentence, and the per-type badges read as a breakdown of the messages.
 */
export function SummaryCards({ summary, onSelect }: SummaryCardsProps) {
  const messageTotal = Object.values(summary.counts).reduce((a, b) => a + b, 0)

  return (
    <div
      data-testid="summary-strip"
      className="bg-surface rounded-lg shadow-sm border border-hair px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <button
        onClick={() => onSelect(null)}
        className="flex items-baseline gap-1.5 rounded hover:text-accent transition-colors"
      >
        <span className="text-xl font-bold font-mono text-strong">{summary.total.toLocaleString()}</span>
        <span className="text-sm text-muted">BGP packets</span>
        <span className="text-sm text-dim">({messageTotal.toLocaleString()} messages)</span>
      </button>
      <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
        {TYPE_BADGES.map(({ type, label, colorClass, showZero }) => {
          const value = summary.counts[type]
          if (value === 0 && !showZero) return null
          return (
            <button
              key={type}
              onClick={() => onSelect(`type=${type}`)}
              className={`px-2 py-1 rounded text-xs font-medium hover:brightness-95 transition ${colorClass} ${
                value === 0 ? 'opacity-50' : ''
              }`}
            >
              {label} <span className="font-mono font-bold">{value.toLocaleString()}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
