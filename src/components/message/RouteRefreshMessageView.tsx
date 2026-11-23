import type { BgpRouteRefreshMessage } from '../../lib/bgp/types'
import type { RouteChange, RouteRefreshDiff } from '../../lib/bgp/route-refresh'
import { useI18n } from '../../i18n'

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
  const { t } = useI18n()
  const rt = t.packetDetail.routeRefresh
  const total = diff.added.length + diff.removed.length + diff.changed.length

  return (
    <div className="rounded border border-hair bg-surface-sunken p-3">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-dim">
        {rt.heading}
      </h4>

      <p className="text-xs text-body">
        <span className="font-mono">{diff.peer}</span> {rt.reAdvertisedVerb} {diff.afiName}{' '}
        {diff.safiName}
        {total === 0 ? rt.nothingChanged(diff.unchanged) : rt.someChanged(diff.unchanged)}
      </p>

      {total > 0 && (
        <div className="mt-2 space-y-2">
          <ChangeList
            title={rt.added}
            tone="text-ok"
            changes={diff.added}
            onSelectPacket={onSelectPacket}
          />
          <ChangeList
            title={rt.removed}
            tone="text-critical"
            changes={diff.removed}
            onSelectPacket={onSelectPacket}
          />
          <ChangeList
            title={rt.changed}
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
        <p className="mt-2 text-xs text-muted">{rt.beforeIncomplete}</p>
      )}
      {diff.afterIncomplete && (
        <p className="mt-2 text-xs text-muted">{rt.afterIncomplete}</p>
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
      <ul className="mt-1 space-y-0.5 text-xs text-body">
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
      <div className="bg-bgp-route-refresh/10 border border-bgp-route-refresh/30 rounded p-3 text-xs space-y-2 text-bgp-route-refresh">
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
