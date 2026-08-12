import type { BgpNotificationMessage } from '../../lib/bgp/types'
import { HexDump } from '../common/HexDump'
import type { HoldTimerContext } from '../../lib/bgp/hold-timer'
import { formatTimeOfDayUtc } from '../../lib/format-time'

/**
 * A duration in the terms this panel compares: seconds against a hold time
 * configured in seconds, so tenths are the useful precision, with minutes
 * added once the number stops being readable as seconds.
 */
function seconds(value: number): string {
  if (value < 600) return `${value.toFixed(1)}s`
  const minutes = Math.floor(value / 60)
  return `${minutes}m${Math.round(value % 60).toString().padStart(2, '0')}s (${value.toFixed(0)}s)`
}

/**
 * How long the peer had been quiet, and whether that is the whole story.
 *
 * A silence that ran the full hold time means the session did exactly what it
 * is specified to do, and the thing to chase is why the peer's packets stopped
 * arriving — one-way reachability, below BGP. A silence shorter than the hold
 * time means the timer fired early, which is a different problem and usually
 * means the capture is missing what the timer was counting.
 */
function HoldTimer({ context }: { context: HoldTimerContext }) {
  const { lastHeard, negotiatedHoldTime, silenceReachedHoldTime, peer } = context

  return (
    <div className="rounded-lg border border-hair bg-surface-sunken p-3">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-dim">
        Silence before the teardown
      </h4>

      {lastHeard ? (
        <div className="space-y-1 text-sm text-body">
          <p>
            <span className="font-mono font-medium text-strong">
              {seconds(lastHeard.silenceSeconds)}
            </span>{' '}
            since the last {lastHeard.type} from <span className="font-mono">{peer}</span> at{' '}
            <span className="font-mono">{formatTimeOfDayUtc(lastHeard.timestamp)}</span>
            {negotiatedHoldTime !== undefined && (
              <>
                , against a negotiated hold time of{' '}
                <span className="font-mono font-medium text-strong">{negotiatedHoldTime}s</span>
              </>
            )}
            .
          </p>

          {silenceReachedHoldTime === true && (
            <p className="text-muted">
              The peer was quiet for the whole hold time, so the session timed out as
              specified. What to chase is why its packets stopped arriving — one-way
              reachability, a filter in one direction, an overloaded control plane —
              rather than BGP itself.
            </p>
          )}
          {silenceReachedHoldTime === false && (
            <p className="text-muted">
              That is shorter than the hold time, so the timer fired before the silence
              could have run it out. Either this capture is missing packets that did
              arrive, or the hold time in force was not the one these OPENs agreed.
            </p>
          )}
          {negotiatedHoldTime === undefined && (
            <p className="text-muted">
              The hold time is unknown because the capture does not hold an OPEN from
              both ends — compare the silence against the configured value yourself.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-body">
          Nothing from <span className="font-mono">{peer}</span> appears in this capture
          before the teardown, so the silence cannot be measured — and a capture with
          nothing from one end is worth checking before drawing conclusions from it.
        </p>
      )}
    </div>
  )
}

interface NotificationMessageViewProps {
  message: BgpNotificationMessage
  holdTimer?: HoldTimerContext | null
}

export function NotificationMessageView({ message, holdTimer }: NotificationMessageViewProps) {
  return (
    <div className="space-y-3">
      {/* Error Info */}
      <div className="bg-critical-subtle border border-critical/30 rounded-lg p-3 text-sm space-y-2">
        <div className="flex justify-between">
          <span className="text-critical">Error Code</span>
          <span className="font-mono font-medium text-critical">
            {message.errorCode} ({message.errorCodeName})
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-critical">Error Subcode</span>
          <span className="font-mono font-medium text-critical">
            {message.errorSubcode} ({message.errorSubcodeName})
          </span>
        </div>
      </div>

      {/* How long the silence actually was, which is what decides the
          diagnosis and is the one number the message does not carry. */}
      {holdTimer && <HoldTimer context={holdTimer} />}

      {/* Hint */}
      {message.hint && (
        <div className="bg-accent-subtle border border-accent/30 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <svg
              className="w-5 h-5 text-accent flex-shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div>
              <h4 className="text-sm font-medium text-strong mb-1">Troubleshooting Hint</h4>
              <p className="text-sm text-body">{message.hint}</p>
            </div>
          </div>
        </div>
      )}

      {/* Error Data */}
      {message.data.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-strong mb-2">
            Error Data ({message.data.length} bytes)
          </h4>
          <HexDump data={message.data} />
        </div>
      )}
    </div>
  )
}
