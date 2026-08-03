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
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>👥</span>
          <h2 className="font-semibold text-gray-700">BGP Neighbors</h2>
        </div>
        <button
          onClick={() => navigate('/neighbors')}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          View All Neighbors →
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-gray-400 text-sm">No neighbor pairs observed</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-gray-600">
                <th className="px-4 py-2 font-medium">Neighbor Pair</th>
                <th className="px-4 py-2 font-medium text-right">Pkts</th>
                <th className="px-4 py-2 font-medium text-right">OPEN</th>
                <th className="px-4 py-2 font-medium text-right">UPD</th>
                <th className="px-4 py-2 font-medium text-right">NOTIF</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr
                  key={row.pairKey}
                  onClick={() => handleRowClick(row)}
                  className="cursor-pointer hover:bg-gray-50"
                >
                  <td className="px-4 py-2 font-mono text-gray-800">{row.ipA} ↔ {row.ipB}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{row.total}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{row.counts.OPEN}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{row.counts.UPDATE}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{row.counts.NOTIFICATION}</td>
                  <td className="px-4 py-2">
                    {row.hasNotification ? (
                      <span className="text-red-600">⚠ Alert</span>
                    ) : (
                      <span className="text-emerald-600">✓ OK</span>
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
