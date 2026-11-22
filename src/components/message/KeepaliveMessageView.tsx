import type { KeepaliveContext } from '../../lib/bgp/hold-timer'
import { formatDelta } from '../../lib/format-time'

/**
 * A KEEPALIVE carries nothing but its header, so what is worth showing is
 * where it falls on the sender's clock: how long since that end last said
 * anything to this one, and how much of the negotiated hold time that gap
 * used up. The RFC 4271 §10 default sends one every third of the hold time;
 * gaps approaching the whole of it are a session about to expire.
 */
export function KeepaliveMessageView({ context }: { context?: KeepaliveContext | null }) {
  if (!context) {
    return (
      <div className="bg-bgp-keepalive/10 border border-bgp-keepalive/30 rounded-lg p-3 text-sm text-bgp-keepalive">
        KEEPALIVE — header only (19 bytes).
      </div>
    )
  }

  const { sender, receiver, previous, negotiatedHoldTime, holdTimeFraction } = context
  const percent = holdTimeFraction !== undefined ? Math.round(holdTimeFraction * 100) : undefined
  // Above two thirds the peer has missed at least one of its own intervals.
  const tone =
    holdTimeFraction === undefined
      ? 'text-body'
      : holdTimeFraction >= 1
        ? 'text-critical'
        : holdTimeFraction > 2 / 3
          ? 'text-warning'
          : 'text-ok'

  return (
    <div className="bg-surface-sunken rounded-lg p-3 text-sm space-y-1">
      <div className="flex justify-between gap-4">
        <span className="text-muted" title="Each end's hold timer is reset by messages from the other end">
          Since {sender}'s previous message to {receiver}
        </span>
        <span className="font-mono">
          {previous
            ? `${formatDelta(previous.gapSeconds * 1000)} (${previous.type})`
            : '- (first from this end in the capture)'}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted">Negotiated hold time</span>
        <span className="font-mono">
          {negotiatedHoldTime !== undefined ? `${negotiatedHoldTime}s` : '- (OPENs not in the capture)'}
        </span>
      </div>
      {percent !== undefined && (
        <div className="flex justify-between gap-4">
          <span className="text-muted">Hold time used</span>
          <span className={`font-mono font-medium ${tone}`}>{percent}%</span>
        </div>
      )}
    </div>
  )
}
