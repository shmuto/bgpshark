import type { BgpRouteRefreshMessage } from '../../lib/bgp/types'
import type { RouteChange, RouteRefreshDiff } from '../../lib/bgp/route-refresh'

interface RouteRefreshMessageViewProps {
  message: BgpRouteRefreshMessage
  diff?: RouteRefreshDiff | null
  /** Opens the packet a changed route was last announced in. */
  onSelectPacket?: (packetIndex: number) => void
}

/**
 * What the re-advertisement brought back, against what was there before.
 *
 * Anyone sending a ROUTE-REFRESH has just changed a policy and wants to know
 * whether the routes that came back are the ones they expected. Both halves are
 * in the capture; this is the subtraction that was being left to the reader.
 */
function RefreshDiff({
  diff,
  onSelectPacket,
}: {
  diff: RouteRefreshDiff
  onSelectPacket?: (packetIndex: number) => void
}) {
  const total = diff.added.length + diff.removed.length + diff.changed.length

  return (
    <div className="rounded-lg border border-hair bg-surface-sunken p-3">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-dim">
        What the refresh changed
      </h4>

      <p className="text-sm text-body">
        <span className="font-mono">{diff.peer}</span> re-advertised {diff.afiName}{' '}
        {diff.safiName}
        {total === 0 ? (
          <>
            {' '}
            and nothing changed: {diff.unchanged} route{diff.unchanged === 1 ? '' : 's'} came
            back exactly as before.
          </>
        ) : (
          <>
            . {diff.unchanged} route{diff.unchanged === 1 ? '' : 's'} came back unchanged.
          </>
        )}
      </p>

      {total > 0 && (
        <div className="mt-2 space-y-2">
          <ChangeList
            title="Added"
            tone="text-ok"
            changes={diff.added}
            onSelectPacket={onSelectPacket}
          />
          <ChangeList
            title="No longer advertised"
            tone="text-critical"
            changes={diff.removed}
            onSelectPacket={onSelectPacket}
          />
          <ChangeList
            title="Attributes changed"
            tone="text-warning"
            changes={diff.changed}
            onSelectPacket={onSelectPacket}
          />
        </div>
      )}

      {/* What the capture cannot settle, said rather than glossed. A diff drawn
          from a partial window is still worth showing — it is the only one
          available — but not without saying which half is partial. */}
      {diff.beforeIncomplete && (
        <p className="mt-2 text-sm text-muted">
          The capture does not hold this session starting, so the &ldquo;before&rdquo; side is
          only what it happened to catch. A route listed as no longer advertised may be one
          that was announced before the capture began — or one that was never there.
        </p>
      )}
      {diff.afterIncomplete && (
        <p className="mt-2 text-sm text-muted">
          No End-of-RIB closed the re-advertisement in this capture, so the answer may be
          incomplete: anything not re-sent before the capture ended is listed as no longer
          advertised whether or not it was on its way.
        </p>
      )}
    </div>
  )
}

function ChangeList({
  title,
  tone,
  changes,
  onSelectPacket,
}: {
  title: string
  tone: string
  changes: RouteChange[]
  onSelectPacket?: (packetIndex: number) => void
}) {
  if (changes.length === 0) return null

  return (
    <div>
      <div className={`text-xs font-medium ${tone}`}>
        {title} ({changes.length})
      </div>
      <ul className="mt-1 space-y-0.5 text-sm text-body">
        {changes.map((change) => (
          <li key={`${title}-${change.key}`}>
            <button
              type="button"
              onClick={() => onSelectPacket?.(change.packetIndex)}
              className="text-left font-mono underline-offset-2 hover:underline"
            >
              {change.key}
            </button>{' '}
            <span className="text-muted">— {change.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function RouteRefreshMessageView({
  message,
  diff,
  onSelectPacket,
}: RouteRefreshMessageViewProps) {
  return (
    <div className="space-y-3">
      <div className="bg-bgp-route-refresh/10 border border-bgp-route-refresh/30 rounded-lg p-3 text-sm space-y-2 text-bgp-route-refresh">
        <div className="flex justify-between">
          <span>AFI</span>
          <span className="font-mono">
            {message.afi} ({message.afiName})
          </span>
        </div>
        <div className="flex justify-between">
          <span>SAFI</span>
          <span className="font-mono">
            {message.safi} ({message.safiName})
          </span>
        </div>
      </div>

      {diff && <RefreshDiff diff={diff} onSelectPacket={onSelectPacket} />}
    </div>
  )
}
