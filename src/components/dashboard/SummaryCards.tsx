import type { SummaryData } from './types'

interface SummaryCardDef {
  key: keyof SummaryData['counts'] | 'total'
  label: string
  colorClass: string
}

const CARD_DEFS: SummaryCardDef[] = [
  { key: 'total', label: 'Packets', colorClass: 'text-gray-800' },
  { key: 'OPEN', label: 'OPEN', colorClass: 'text-bgp-open' },
  { key: 'UPDATE', label: 'UPDATE', colorClass: 'text-bgp-update' },
  { key: 'NOTIFICATION', label: 'NOTIFICATION', colorClass: 'text-bgp-notification' },
  { key: 'KEEPALIVE', label: 'KEEPALIVE', colorClass: 'text-bgp-keepalive' },
  { key: 'ROUTE_REFRESH', label: 'ROUTE REFRESH', colorClass: 'text-gray-600' },
]

interface SummaryCardsProps {
  summary: SummaryData
  onSelect: (filter: string | null) => void
}

export function SummaryCards({ summary, onSelect }: SummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {CARD_DEFS.map(({ key, label, colorClass }) => {
        const value = key === 'total' ? summary.total : summary.counts[key]
        const filter = key === 'total' ? null : `type=${key}`
        return (
          <button
            key={label}
            onClick={() => onSelect(filter)}
            className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 text-left hover:border-blue-400 hover:shadow-md transition-all"
          >
            <div className={`text-2xl font-bold font-mono ${colorClass}`}>{value.toLocaleString()}</div>
            <div className="text-xs text-gray-500 mt-1 uppercase tracking-wide">{label}</div>
          </button>
        )
      })}
    </div>
  )
}
