import type { BgpNotificationMessage } from '../../lib/bgp/types'
import type { NotificationData } from '../../lib/bgp/notification-data'
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

/**
 * What the data field says, when the error code defines it.
 *
 * Shown above the hex rather than instead of it: the decode is the answer, the
 * bytes are what lets someone check the answer, and a NOTIFICATION is exactly
 * the message where people want to do that.
 */
function DecodedData({ decoded }: { decoded: NotificationData }) {
  switch (decoded.kind) {
    case 'attribute': {
      const { attribute } = decoded
      return (
        <Decoded label="Offending attribute">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium text-strong">{attribute.typeName}</span>
            <span className="text-xs text-muted">type {attribute.typeCode}</span>
            <span className="text-xs text-muted">{attribute.length} bytes</span>
            {/* The flags are often the fault itself — an unknown type code with
                the optional bit clear is precisely error 3/2, "Unrecognized
                Well-known Attribute". Rendering only the flags that are set
                would leave that one legible by its absence, so the optional
                bit is named either way, in the words the subcode uses. */}
            <Flag>{attribute.flags.optional ? 'Optional' : 'Well-known'}</Flag>
            {attribute.flags.transitive && <Flag>Transitive</Flag>}
            {attribute.flags.partial && <Flag>Partial</Flag>}
            {attribute.flags.extendedLength && <Flag>Extended length</Flag>}
          </div>
        </Decoded>
      )
    }
    case 'version':
      return (
        <Decoded label="Highest version the peer supports">
          <span className="font-mono font-medium text-strong">BGP-{decoded.version}</span>
        </Decoded>
      )
    case 'as':
      return (
        <Decoded label="AS number in the data field">
          <span className="font-mono font-medium text-strong">AS{decoded.asNumber}</span>
          <p className="mt-1 text-xs text-muted">
            Compare this against your neighbor statement and the peer's router bgp line.
          </p>
        </Decoded>
      )
    case 'capabilities':
      return (
        <Decoded label={`Unsupported ${decoded.capabilities.length === 1 ? 'capability' : 'capabilities'}`}>
          <ul className="space-y-1">
            {decoded.capabilities.map((capability, index) => (
              <li key={index} className="flex items-center gap-2">
                <span className="font-mono font-medium text-strong">{capability.name}</span>
                <span className="text-xs text-muted">code {capability.code}</span>
              </li>
            ))}
          </ul>
        </Decoded>
      )
    case 'length':
      return (
        <Decoded label="Rejected message length">
          <span className="font-mono font-medium text-strong">{decoded.length} bytes</span>
          <p className="mt-1 text-xs text-muted">Valid BGP messages are 19–4096 bytes.</p>
        </Decoded>
      )
    case 'messageType':
      return (
        <Decoded label="Unrecognised message type">
          <span className="font-mono font-medium text-strong">{decoded.typeName}</span>
          <span className="ml-2 text-xs text-muted">type {decoded.typeCode}</span>
        </Decoded>
      )
    case 'shutdownMessage':
      return (
        <Decoded label="Shutdown communication">
          {/* The one place BGP lets the far end explain itself in words. */}
          <p className="whitespace-pre-wrap font-medium text-strong">{decoded.message}</p>
        </Decoded>
      )
  }
}

function Decoded({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-hair bg-surface-sunken p-3">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-dim">{label}</h4>
      <div className="text-sm text-body">{children}</div>
    </div>
  )
}

function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-surface-raised px-1.5 py-0.5 text-xs text-muted">{children}</span>
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

      {/* What the data field says, then the bytes it says it with. */}
      {message.decodedData && <DecodedData decoded={message.decodedData} />}

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
