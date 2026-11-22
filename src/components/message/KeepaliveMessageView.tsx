import type { KeepaliveContext } from '../../lib/bgp/hold-timer'
import { formatDelta } from '../../lib/format-time'
import { useI18n } from '../../i18n'

/**
 * A KEEPALIVE carries nothing but its header, so what is worth showing is
 * where it falls on the sender's clock: how long since that end last said
 * anything to this one, and how much of the negotiated hold time that gap
 * used up. The RFC 4271 §10 default sends one every third of the hold time;
 * gaps approaching the whole of it are a session about to expire.
 */
export function KeepaliveMessageView({ context }: { context?: KeepaliveContext | null }) {
  const { t } = useI18n()

  if (!context) {
    return (
      <div className="bg-bgp-keepalive/10 border border-bgp-keepalive/30 rounded-lg p-3 text-sm text-bgp-keepalive">
        {t.packetDetail.keepalive.headerOnly}
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
        <span className="text-muted" title={t.packetDetail.keepalive.sincePreviousTitle}>
          {t.packetDetail.keepalive.sincePrevious(sender, receiver)}
        </span>
        <span className="font-mono">
          {previous
            ? `${formatDelta(previous.gapSeconds * 1000)} (${previous.type})`
            : t.packetDetail.keepalive.firstInCapture}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted">{t.packetDetail.keepalive.negotiatedHoldTime}</span>
        <span className="font-mono">
          {negotiatedHoldTime !== undefined
            ? `${negotiatedHoldTime}s`
            : t.packetDetail.keepalive.noOpensInCapture}
        </span>
      </div>
      {percent !== undefined && (
        <div className="flex justify-between gap-4">
          <span className="text-muted">{t.packetDetail.keepalive.holdTimeUsed}</span>
          <span className={`font-mono font-medium ${tone}`}>{percent}%</span>
        </div>
      )}
    </div>
  )
}
