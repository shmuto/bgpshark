import { useNavigate } from 'react-router-dom'
import type { NeighborRow } from './types'

interface NeighborSummaryTableProps {
  rows: NeighborRow[]
}

export function NeighborSummaryTable({ rows }: NeighborSummaryTableProps) {
  const navigate = useNavigate()

  const handleRowClick = (row: NeighborRow) => {
    navigate(`/neighbors?router=${encodeURIComponent(row.routerId)}&peer=${encodeURIComponent(row.peerIp)}`)
  }

  return (
    <div className="bg-surface rounded-lg shadow-sm border border-hair">
      <div className="px-4 py-3 border-b border-hair flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>👥</span>
          <h2 className="font-semibold text-strong">BGP Neighbors</h2>
        </div>
        <button
          onClick={() => navigate('/neighbors')}
          className="text-xs text-accent hover:text-accent-hover"
        >
          View All Neighbors →
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-dim text-sm">No neighbor pairs observed</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken">
              <tr className="text-left text-muted">
                <th className="px-4 py-2 font-medium">Neighbor Pair</th>
                <th className="px-4 py-2 font-medium text-right">Pkts</th>
                <th className="px-4 py-2 font-medium text-right">OPEN</th>
                <th className="px-4 py-2 font-medium text-right">UPD</th>
                <th className="px-4 py-2 font-medium text-right">NOTIF</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hair">
              {rows.map((row) => (
                <tr
                  key={row.pairKey}
                  onClick={() => handleRowClick(row)}
                  className="cursor-pointer hover:bg-surface-sunken"
                >
                  <td className="px-4 py-2 font-mono text-strong">{row.ipA} ↔ {row.ipB}</td>
                  <td className="px-4 py-2 text-right text-muted">{row.total}</td>
                  <td className="px-4 py-2 text-right text-muted">{row.counts.OPEN}</td>
                  <td className="px-4 py-2 text-right text-muted">{row.counts.UPDATE}</td>
                  <td className="px-4 py-2 text-right text-muted">{row.counts.NOTIFICATION}</td>
                  <td className="px-4 py-2">
                    {row.hasNotification ? (
                      <span className="text-critical">⚠ Alert</span>
                    ) : (
                      <span className="text-ok">✓ OK</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
