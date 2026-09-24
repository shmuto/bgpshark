import type { LoadProgress } from '../../lib/load-progress'

/**
 * The gauge shown while a capture loads.
 *
 * It replaces a spinner, and the difference is the point: a spinner looks the
 * same at second two and at minute two, so a slow load and a hung one are
 * indistinguishable. This one says which stage is running and, in the
 * database stage, how many rows are in — so "slow" reads as slow.
 *
 * A real `progressbar` with its value exposed, because the value is the
 * information; the end-to-end suite reads it the same way assistive technology
 * does.
 */
export function LoadProgressBar({ progress }: { progress: LoadProgress }) {
  const percent = Math.round(progress.fraction * 100)

  return (
    <div className="w-full max-w-sm flex flex-col gap-2">
      <div
        role="progressbar"
        aria-label="Loading capture"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={progress.label}
        data-stage={progress.stage}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken border border-hair"
      >
        <div
          className="h-full bg-accent transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between gap-4 text-xs text-muted">
        <span>{progress.label}</span>
        <span className="font-mono tabular-nums">{percent}%</span>
      </div>
    </div>
  )
}
