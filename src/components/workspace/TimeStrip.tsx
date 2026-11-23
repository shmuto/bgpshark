import { useMemo, useRef, useState } from 'react'
import { useApp } from '../../context/AppContext'
import { useWorkspace } from '../../context/WorkspaceContext'
import { useI18n } from '../../i18n'

/** Columns in the histogram. Fixed, so a bar is the same share of time at any width. */
const BINS = 160

/** A drag shorter than this share of the strip is a click, and clears the window. */
const MIN_DRAG = 0.004

interface Bin {
  keepalive: number
  open: number
  update: number
}

/**
 * The capture's message volume over time, across the top of the workspace.
 *
 * It replaces the dashboard's timeline, and does one thing that one could not:
 * dragging across it narrows every view to that window, the way choosing a
 * session narrows them to a peering. The bars follow the session scope, so the
 * strip shows when *this* session was busy; NOTIFICATIONs are drawn as rules
 * through the bars because a teardown is the moment people go looking for.
 *
 * Time is counted from the start of the capture, the same zero the packet
 * list's Relative column uses, so a window read off the strip can be found in
 * the list.
 */
export function TimeStrip() {
  const { packets, allPackets } = useApp()
  const { sessionPackets, range, setRange } = useWorkspace()
  const { t } = useI18n()
  const chartRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)

  // The axis spans the whole capture whatever the scope, so the strip does
  // not rescale under the reader when they pick a session.
  const start = (allPackets[0] ?? packets[0])?.timestamp.getTime() ?? 0
  const lastFrame = allPackets[allPackets.length - 1] ?? packets[packets.length - 1]
  const span = Math.max((lastFrame?.timestamp.getTime() ?? start) - start, 1)

  const { bins, max, notifications } = useMemo(() => {
    const bins: Bin[] = Array.from({ length: BINS }, () => ({ keepalive: 0, open: 0, update: 0 }))
    const notifications: number[] = []
    for (const packet of sessionPackets) {
      const ratio = (packet.timestamp.getTime() - start) / span
      const bin = bins[Math.min(BINS - 1, Math.max(0, Math.floor(ratio * BINS)))]
      for (const msg of packet.messages) {
        if (msg.type === 'UPDATE') bin.update++
        else if (msg.type === 'OPEN') bin.open++
        else if (msg.type === 'KEEPALIVE') bin.keepalive++
        else if (msg.type === 'NOTIFICATION') notifications.push(ratio)
      }
    }
    const max = Math.max(1, ...bins.map((b) => b.keepalive + b.open + b.update))
    return { bins, max, notifications }
  }, [sessionPackets, start, span])

  const ratioAt = (clientX: number) => {
    const box = chartRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return 0
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width))
  }

  const shown = drag
    ? { from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) }
    : range
      ? { from: (range[0] - start) / span, to: (range[1] - start) / span }
      : null

  const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 3 : 1)}s`
  const { ticks, step } = useMemo(() => niceTicks(span), [span])

  // Log scale: a burst of a hundred UPDATEs and a lone KEEPALIVE both stay
  // visible, which is the point of a strip this short.
  const h = (n: number) => (n === 0 ? 0 : Math.max(3, (30 * Math.log1p(n)) / Math.log1p(max)))

  // The scale is applied to the bin's total and the bar then split by share.
  // Scaling each type on its own and stacking the results overflowed the
  // strip: log1p(a) + log1p(b) is more than log1p(a + b), so a bin holding
  // all three types could stand taller than the busiest bin and be clipped.
  const segments = (bin: Bin) => {
    const total = bin.keepalive + bin.open + bin.update
    const height = h(total)
    return ([
      [bin.keepalive, 'fill-bgp-keepalive/50'],
      [bin.open, 'fill-bgp-open'],
      [bin.update, 'fill-bgp-update'],
    ] as const)
      .filter(([n]) => n > 0)
      .map(([n, cls]) => ({ height: (height * n) / total, cls }))
  }

  return (
    <div className="flex h-14 shrink-0 items-stretch gap-3 border-b border-hair bg-surface px-3">
      <div className="flex w-24 shrink-0 flex-col justify-center text-[11px] leading-tight">
        {range ? (
          <>
            <span className="font-mono tabular-nums text-strong" data-testid="time-window">
              {seconds(range[0] - start)}–{seconds(range[1] - start)}
            </span>
            <button type="button" onClick={() => setRange(null)} className="self-start text-accent hover:text-accent-hover">
              {t.workspace.clearRange}
            </button>
          </>
        ) : (
          <>
            <span className="font-medium text-strong">{t.workspace.wholeCapture}</span>
            <span className="text-dim">{t.workspace.dragToNarrow}</span>
          </>
        )}
      </div>

      <div
        ref={chartRef}
        role="group"
        aria-label={t.workspace.timeStripAria}
        className="relative min-w-0 flex-1 cursor-crosshair touch-none select-none"
        onPointerDown={(e) => {
          // Only the primary button selects; a right click is the reader
          // reaching for the context menu, not starting a window.
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          const r = ratioAt(e.clientX)
          setDrag({ from: r, to: r })
        }}
        onPointerMove={(e) => drag && setDrag({ ...drag, to: ratioAt(e.clientX) })}
        onPointerUp={(e) => {
          if (!drag) return
          const to = ratioAt(e.clientX)
          const from = Math.min(drag.from, to)
          const until = Math.max(drag.from, to)
          setDrag(null)
          if (until - from < MIN_DRAG) setRange(null)
          else setRange([start + from * span, start + until * span])
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <svg
          className="absolute inset-x-0 top-1.5 h-[34px] w-full"
          viewBox={`0 0 ${BINS} 34`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {bins.map((bin, i) => {
            let y = 34
            return (
              <g key={i}>
                {segments(bin).map(({ height, cls }, j) => {
                  y -= height
                  return <rect key={j} x={i + 0.1} y={y} width={0.8} height={height} className={cls} />
                })}
              </g>
            )
          })}
          {notifications.map((ratio, i) => (
            <rect key={`n${i}`} x={ratio * BINS - 0.15} y={0} width={0.3} height={34} className="fill-bgp-notification" />
          ))}
        </svg>
        <div className="absolute inset-x-0 top-[40px] border-t border-hair-strong" aria-hidden="true" />
        {ticks.map((ms) => (
          <span
            key={ms}
            className="absolute top-[41px] -translate-x-1/2 font-mono text-[10px] text-dim first:translate-x-0"
            style={{ left: `${(ms / span) * 100}%` }}
            aria-hidden="true"
          >
            {tickLabel(ms, step)}
          </span>
        ))}

        {shown && (
          <>
            <div className="absolute inset-y-0 left-0 bg-surface/70" style={{ width: `${shown.from * 100}%` }} aria-hidden="true" />
            <div className="absolute inset-y-0 right-0 bg-surface/70" style={{ width: `${(1 - shown.to) * 100}%` }} aria-hidden="true" />
            <div
              className="absolute inset-y-0 border-x border-accent bg-accent/5"
              style={{ left: `${shown.from * 100}%`, width: `${(shown.to - shown.from) * 100}%` }}
              aria-hidden="true"
            />
          </>
        )}
      </div>
    </div>
  )
}

/** Round tick positions in milliseconds: 1, 2 or 5 times a power of ten, about six of them. */
function niceTicks(span: number): { ticks: number[]; step: number } {
  const raw = span / 6
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  // Stop short of the end so the last label does not hang off the strip.
  // Counted by index rather than by adding the step, which drifts in floating
  // point once the step is a fraction of a millisecond.
  for (let i = 0; i * step <= span * 0.96; i++) ticks.push(i * step)
  return { ticks, step }
}

/**
 * A tick in seconds, with as many decimals as the step needs. A fixed two
 * decimals printed every tick of a capture shorter than 50 ms as "0s", one
 * on top of the other; a sub-millisecond span is labelled in milliseconds.
 */
function tickLabel(ms: number, step: number): string {
  if (ms === 0) return '0s'
  if (step < 1) {
    const decimals = Math.min(3, Math.max(0, -Math.floor(Math.log10(step))))
    return `${+ms.toFixed(decimals)}ms`
  }
  const decimals = Math.min(3, Math.max(0, 3 - Math.floor(Math.log10(step))))
  return `${+(ms / 1000).toFixed(decimals)}s`
}
