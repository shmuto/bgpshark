import type { TimelineData } from './types'

interface MessageTimelineProps {
  data: TimelineData
  onSelectNotification: (packetIndex: number) => void
}

const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 180
const BASELINE_Y = 140
const BAR_AREA_HEIGHT = 120

export function MessageTimeline({ data, onSelectNotification }: MessageTimelineProps) {
  const { buckets, notifications, start, end, maxUpdateCount } = data

  if (buckets.length === 0 || !start || !end) {
    return (
      <div className="bg-surface rounded-lg shadow-sm border border-hair">
        <div className="px-4 py-3 border-b border-hair flex items-center gap-2">
          <span>📈</span>
          <h2 className="font-semibold text-strong">Timeline</h2>
        </div>
        <div className="text-center text-dim text-sm py-8">No timeline data</div>
      </div>
    )
  }

  const spanMs = end.getTime() - start.getTime()
  const bucketSlot = VIEW_WIDTH / buckets.length

  return (
    <div className="bg-surface rounded-lg shadow-sm border border-hair">
      <div className="px-4 py-3 border-b border-hair flex items-center gap-2">
        <span>📈</span>
        <h2 className="font-semibold text-strong">Timeline</h2>
      </div>
      <div className="p-4">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          className="w-full h-40"
          preserveAspectRatio="none"
          role="img"
          aria-label="BGP message volume over the capture duration"
        >
          <line x1={0} y1={BASELINE_Y} x2={VIEW_WIDTH} y2={BASELINE_Y} stroke="rgb(var(--hair))" strokeWidth={1} />

          {buckets.map((bucket, i) => {
            const barWidth = bucketSlot * 0.7
            const x = i * bucketSlot + bucketSlot * 0.15
            const height = maxUpdateCount > 0 ? (bucket.updateCount / maxUpdateCount) * BAR_AREA_HEIGHT : 0
            return (
              <rect
                key={i}
                x={x}
                y={BASELINE_Y - height}
                width={barWidth}
                height={height}
                fill="rgb(var(--msg-update))"
                opacity={0.85}
              >
                <title>{`${bucket.updateCount} UPDATE`}</title>
              </rect>
            )
          })}

          {notifications.map((n, i) => {
            const cx = n.ratio * VIEW_WIDTH
            return (
              <g
                key={i}
                onClick={() => onSelectNotification(n.packetIndex)}
                className="cursor-pointer"
              >
                <line x1={cx} y1={26} x2={cx} y2={BASELINE_Y} stroke="rgb(var(--critical))" strokeWidth={1} strokeDasharray="4 3" opacity={0.5} />
                <circle cx={cx} cy={16} r={6} fill="rgb(var(--critical))">
                  <title>{`NOTIFICATION at ${formatElapsed(n.timestamp.getTime() - start.getTime())}`}</title>
                </circle>
              </g>
            )
          })}
        </svg>

        <div className="flex justify-between text-xs text-dim mt-1 font-mono">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f}>{formatElapsed(f * spanMs)}</span>
          ))}
        </div>

        <div className="flex items-center gap-4 text-xs text-muted mt-3">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-bgp-update inline-block" /> UPDATE
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-critical inline-block" /> NOTIFICATION
          </span>
        </div>
      </div>
    </div>
  )
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
