import { useNavigate } from 'react-router-dom'
import type { DashboardAlert } from './types'

interface AlertListProps {
  alerts: DashboardAlert[]
}

export function AlertList({ alerts }: AlertListProps) {
  const navigate = useNavigate()

  const handleView = (alert: DashboardAlert) => {
    const filterPart = alert.filter ? `filter=${encodeURIComponent(alert.filter)}` : ''
    const selectedPart = alert.packetIndex !== undefined ? `selected=${alert.packetIndex}` : ''
    const query = [filterPart, selectedPart].filter(Boolean).join('&')
    navigate(`/messages${query ? `?${query}` : ''}`)
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
        <span>⚠️</span>
        <h2 className="font-semibold text-gray-700">Alerts{alerts.length > 0 ? ` (${alerts.length})` : ''}</h2>
      </div>
      {alerts.length === 0 ? (
        <div className="px-4 py-6 text-center text-emerald-600 text-sm flex items-center justify-center gap-2">
          <span>✓</span>
          <span>No issues detected — every session looks healthy.</span>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {alerts.map((alert) => (
            <li key={alert.id} className="px-4 py-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span>{alert.severity === 'critical' ? '🔴' : '🟡'}</span>
                  <span className="font-medium text-gray-800">{alert.title}</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
                  <span className="font-mono">{alert.detail}</span>
                  {alert.timestamp && <span>{formatTime(alert.timestamp)}</span>}
                </div>
              </div>
              <button
                onClick={() => handleView(alert)}
                className="shrink-0 text-xs text-blue-600 hover:text-blue-800 whitespace-nowrap"
              >
                View →
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}
