import type { BgpNotificationMessage } from '../../lib/bgp/types'
import type { NotificationData } from '../../lib/bgp/notification-data'
import { getErrorHint } from '../../lib/bgp/errors'
import { HexDump } from '../common/HexDump'
import type { HoldTimerContext } from '../../lib/bgp/hold-timer'
import { formatTimeOfDayUtc } from '../../lib/format-time'
import { useI18n } from '../../i18n'

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
  const { t } = useI18n()
  const nt = t.packetDetail.notification
  const { lastHeard, negotiatedHoldTime, silenceReachedHoldTime, peer } = context

  const line = lastHeard
    ? nt.silenceLine(
        seconds(lastHeard.silenceSeconds),
        lastHeard.type,
        peer,
        formatTimeOfDayUtc(lastHeard.timestamp),
        negotiatedHoldTime
      )
    : null

  return (
    <div className="rounded border border-hair bg-surface-sunken p-3">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-dim">
        {nt.silenceHeading}
      </h4>

      {line ? (
        <div className="space-y-1 text-xs text-body">
          <p>
            <span className="font-mono font-medium text-strong">{line.duration}</span>
            {line.afterDuration}
            <span className="font-mono">{line.peer}</span>
            {line.atTime}
            <span className="font-mono">{line.time}</span>
            {line.againstHold && line.holdTimeStr && (
              <>
                {line.againstHold}
                <span className="font-mono font-medium text-strong">{line.holdTimeStr}</span>
              </>
            )}
            {line.suffix}
          </p>

          {silenceReachedHoldTime === true && (
            <p className="text-muted">{nt.silenceReached}</p>
          )}
          {silenceReachedHoldTime === false && (
            <p className="text-muted">{nt.silenceShort}</p>
          )}
          {negotiatedHoldTime === undefined && (
            <p className="text-muted">{nt.silenceUnknownHold}</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-body">{nt.silenceNoneBefore(peer)}</p>
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
  const { t } = useI18n()
  const nt = t.packetDetail.notification

  switch (decoded.kind) {
    case 'attribute': {
      const { attribute } = decoded
      return (
        <Decoded label={nt.offendingAttribute}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium text-strong">{attribute.typeName}</span>
            <span className="text-xs text-muted">{nt.attrType(attribute.typeCode)}</span>
            <span className="text-xs text-muted">{t.common.bytes(attribute.length)}</span>
            {/* The flags are often the fault itself — an unknown type code with
                the optional bit clear is precisely error 3/2, "Unrecognized
                Well-known Attribute". Rendering only the flags that are set
                would leave that one legible by its absence, so the optional
                bit is named either way, in the words the subcode uses. */}
            <Flag>{attribute.flags.optional ? nt.flagOptional : nt.flagWellKnown}</Flag>
            {attribute.flags.transitive && <Flag>{nt.flagTransitive}</Flag>}
            {attribute.flags.partial && <Flag>{nt.flagPartial}</Flag>}
            {attribute.flags.extendedLength && <Flag>{nt.flagExtendedLength}</Flag>}
          </div>
        </Decoded>
      )
    }
    case 'version':
      return (
        <Decoded label={nt.highestVersion}>
          <span className="font-mono font-medium text-strong">BGP-{decoded.version}</span>
        </Decoded>
      )
    case 'as':
      return (
        <Decoded label={nt.asInData}>
          <span className="font-mono font-medium text-strong">AS{decoded.asNumber}</span>
          <p className="mt-1 text-xs text-muted">{nt.asInDataHint}</p>
        </Decoded>
      )
    case 'capabilities':
      return (
        <Decoded label={nt.unsupportedCapabilities(decoded.capabilities.length)}>
          <ul className="space-y-1">
            {decoded.capabilities.map((capability, index) => (
              <li key={index} className="flex items-center gap-2">
                <span className="font-mono font-medium text-strong">{capability.name}</span>
                <span className="text-xs text-muted">{nt.capCode(capability.code)}</span>
              </li>
            ))}
          </ul>
        </Decoded>
      )
    case 'length':
      return (
        <Decoded label={nt.rejectedLength}>
          <span className="font-mono font-medium text-strong">{t.common.bytes(decoded.length)}</span>
          <p className="mt-1 text-xs text-muted">{nt.validLengthHint}</p>
        </Decoded>
      )
    case 'messageType':
      return (
        <Decoded label={nt.unrecognisedType}>
          <span className="font-mono font-medium text-strong">{decoded.typeName}</span>
          <span className="ml-2 text-xs text-muted">{nt.attrType(decoded.typeCode)}</span>
        </Decoded>
      )
    case 'shutdownMessage':
      return (
        <Decoded label={nt.shutdownCommunication}>
          {/* The one place BGP lets the far end explain itself in words. */}
          <p className="whitespace-pre-wrap font-medium text-strong">{decoded.message}</p>
        </Decoded>
      )
  }
}

function Decoded({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-hair bg-surface-sunken p-3">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-dim">{label}</h4>
      <div className="text-xs text-body">{children}</div>
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
  const { locale, t } = useI18n()
  const nt = t.packetDetail.notification
  const hint = message.hint ? getErrorHint(message.errorCode, message.errorSubcode, locale) : null

  return (
    <div className="space-y-3">
      {/* Error Info */}
      <div className="bg-critical-subtle border border-critical/30 rounded p-3 text-xs space-y-2">
        <div className="flex justify-between">
          <span className="text-critical">{nt.errorCode}</span>
          <span className="font-mono font-medium text-critical">
            {message.errorCode} ({message.errorCodeName})
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-critical">{nt.errorSubcode}</span>
          <span className="font-mono font-medium text-critical">
            {message.errorSubcode} ({message.errorSubcodeName})
          </span>
        </div>
      </div>

      {/* How long the silence actually was, which is what decides the
          diagnosis and is the one number the message does not carry. */}
      {holdTimer && <HoldTimer context={holdTimer} />}

      {/* Hint */}
      {hint && (
        <div className="bg-accent-subtle border border-accent/30 rounded p-3">
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
              <h4 className="text-xs font-medium text-strong mb-1">{nt.troubleshootingHint}</h4>
              <p className="text-xs text-body">{hint}</p>
            </div>
          </div>
        </div>
      )}

      {/* What the data field says, then the bytes it says it with. */}
      {message.decodedData && <DecodedData decoded={message.decodedData} />}

      {/* Error Data */}
      {message.data.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-strong mb-2">
            {nt.errorData(message.data.length)}
          </h4>
          <HexDump data={message.data} />
        </div>
      )}
    </div>
  )
}
