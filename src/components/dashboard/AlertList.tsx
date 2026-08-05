import { useNavigate } from 'react-router-dom'
import type { DashboardAlert } from './types'
import { formatTimeOfDayUtc } from '../../lib/format-time'

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
    <div className="bg-surface rounded-lg shadow-sm border border-hair">
      <div className="px-4 py-3 border-b border-hair flex items-center gap-2">
        <span>⚠️</span>
        <h2 className="font-semibold text-strong">Alerts{alerts.length > 0 ? ` (${alerts.length})` : ''}</h2>
      </div>
      {alerts.length === 0 ? (
        <div className="px-4 py-6 text-center text-ok text-sm flex items-center justify-center gap-2">
          <span>✓</span>
          <span>No issues detected — every session looks healthy.</span>
        </div>
      ) : (
        <ul className="divide-y divide-hair">
          {alerts.map((alert) => (
            <li key={alert.id} className="px-4 py-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span>{alert.severity === 'critical' ? '🔴' : '🟡'}</span>
                  <span className={`font-medium ${alert.severity === 'critical' ? 'text-critical' : 'text-warning'}`}>
                    {alert.title}
                    {alert.count !== undefined && alert.count > 1 && ` ×${alert.count}`}
                  </span>
                </div>
                <div className="text-xs text-muted mt-0.5 flex items-center gap-2 flex-wrap">
                  <span className="font-mono">{alert.detail}</span>
                  {alert.timeSpan ? (
                    <span>
                      {formatTimeOfDayUtc(alert.timeSpan.start)} – {formatTimeOfDayUtc(alert.timeSpan.end)} UTC
                    </span>
                  ) : (
                    alert.timestamp && <span>{formatTimeOfDayUtc(alert.timestamp)} UTC</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleView(alert)}
                className="shrink-0 text-xs text-accent hover:text-accent-hover whitespace-nowrap"
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
