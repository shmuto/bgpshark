import type { DatabaseState } from '../../hooks/useBgpAnalyzer'
import { databaseProgress } from '../../lib/load-progress'

/**
 * The DuckDB load, while it runs behind a capture that is already on screen.
 *
 * Small on purpose. Nothing the reader is looking at is waiting on it — the
 * screens filter in memory until it is done, and get the same answers — so it
 * is a status, not a blocker. It exists so that the one thing that *does* wait,
 * the SQL console, is not a mystery, and so that a load that takes most of a
 * minute on a 50MB capture is visibly moving rather than silently absent.
 *
 * Renders nothing unless a load is running. The bar carries its value the way
 * the capture gauge does, as a `progressbar`, under its own name so the two
 * cannot be confused.
 */
export function DatabaseProgress({ database, className = '' }: { database: DatabaseState; className?: string }) {
  if (database.status !== 'loading') return null
  const { fraction, label } = databaseProgress(database.done, database.total)
  const percent = Math.round(fraction * 100)

  return (
    <div className={`flex items-center gap-2 text-xs text-muted ${className}`} title={label}>
      <div
        role="progressbar"
        aria-label="Loading into DuckDB"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={label}
        className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-sunken border border-hair"
      >
        <div className="h-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${percent}%` }} />
      </div>
      <span className="font-mono tabular-nums">SQL {percent}%</span>
    </div>
  )
}
