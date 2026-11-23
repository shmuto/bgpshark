import type { BgpPacket, BgpMessage } from '../../lib/bgp/types'
import { OpenMessageView } from './OpenMessageView'
import { NotificationMessageView } from './NotificationMessageView'
import { KeepaliveMessageView } from './KeepaliveMessageView'
import { UpdateMessageView } from './UpdateMessageView'
import { RouteRefreshMessageView } from './RouteRefreshMessageView'
import { HexDump } from '../common/HexDump'
import { usePersistentFlag } from '../../hooks/usePersistentFlag'
import { FilterableValue } from './FilterableValue'
import type { HoldTimerContext, KeepaliveContext } from '../../lib/bgp/hold-timer'
import type { RouteRefreshDiff } from '../../lib/bgp/route-refresh'
import { formatDelta } from '../../lib/format-time'
import { useI18n } from '../../i18n'

interface PacketDetailProps {
  packet: BgpPacket
  /**
   * How long the peer had been quiet, for a Hold Timer Expired NOTIFICATION.
   * Computed by the caller because it is a fact about the packets *around*
   * this one, which is the one thing a detail view cannot see for itself.
   */
  holdTimer?: HoldTimerContext | null
  refreshDiff?: RouteRefreshDiff | null
  onSelectPacket?: (packetIndex: number) => void
  /**
   * First frame of the capture, so the detail states the same relative time
   * the list does — whichever filter is applied.
   */
  captureStart?: Date
  /**
   * The previous BGP packet on the same TCP session (either direction), for
   * the gap that hold timers and convergence are measured in. Null when this
   * is the first one the capture holds.
   */
  sessionPrevious?: BgpPacket | null
  /** Gap since the sender's previous message, against the hold time, for a KEEPALIVE. */
  keepalive?: KeepaliveContext | null
}

export function PacketDetail({
  packet,
  holdTimer,
  refreshDiff,
  onSelectPacket,
  captureStart,
  sessionPrevious,
  keepalive,
}: PacketDetailProps) {
  const { t } = useI18n()
  const { messages, rawData, parseWarnings } = packet
  const [rawOpen, setRawOpen] = usePersistentFlag('bgpshark-raw-data-open', false)

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      {/* Packet Info */}
      <section>
        <h3 className="text-xs font-semibold text-dim uppercase tracking-wide mb-2">
          {t.packetDetail.packetInfo}
        </h3>
        <div className="bg-surface-sunken rounded p-3 text-xs space-y-1">
          <div className="flex justify-between">
            <span className="text-muted">{t.packetDetail.timeUtc}</span>
            <span className="font-mono">{packet.timestamp.toISOString()}</span>
          </div>
          {captureStart && (
            <div className="flex justify-between">
              <span className="text-muted">{t.packetDetail.sinceCaptureStart}</span>
              <span className="font-mono">
                {((packet.timestamp.getTime() - captureStart.getTime()) / 1000).toFixed(3)}s
              </span>
            </div>
          )}
          {sessionPrevious !== undefined && (
            <div className="flex justify-between">
              <span
                className="text-muted"
                title={t.packetDetail.deltaPreviousTitle}
              >
                {t.packetDetail.deltaPrevious}
              </span>
              <span className="font-mono">
                {sessionPrevious
                  ? `${formatDelta(packet.timestamp.getTime() - sessionPrevious.timestamp.getTime())} (#${sessionPrevious.frameIndex})`
                  : t.packetDetail.firstOnSession}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted">{t.packetDetail.source}</span>
            <span className="font-mono">
              <FilterableValue field="src_ip" value={packet.srcIp} align="left">{packet.srcIp}</FilterableValue>:{packet.srcPort}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">{t.packetDetail.destination}</span>
            <span className="font-mono">
              <FilterableValue field="dst_ip" value={packet.dstIp} align="left">{packet.dstIp}</FilterableValue>:{packet.dstPort}
            </span>
          </div>
          {messages.length > 1 && (
            <div className="flex justify-between">
              <span className="text-muted">{t.packetDetail.messages}</span>
              <span className="font-mono">{messages.length}</span>
            </div>
          )}
        </div>
      </section>

      {/* Parse Warnings */}
      {parseWarnings.length > 0 && (
        <section>
          <div className="bg-warning-subtle border border-warning/30 rounded p-3">
            <h4 className="text-xs font-medium text-warning mb-1">{t.packetDetail.parseWarnings}</h4>
            <ul className="text-xs text-warning space-y-1">
              {parseWarnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Message Content - render all messages */}
      {messages.map((message, index) => (
        <MessageSection
          key={index}
          message={message}
          index={index}
          total={messages.length}
          holdTimer={holdTimer}
          refreshDiff={refreshDiff}
          keepalive={keepalive}
          onSelectPacket={onSelectPacket}
        />
      ))}

      {/* Hex Dump — folded by default. Almost no BGP question is answered
          from the bytes once the decode above has read them, and an open dump
          under every packet is the tallest thing on the pane. A reader who
          does work from the bytes opens it once and it stays open. */}
      <details
        open={rawOpen}
        onToggle={(e) => setRawOpen(e.currentTarget.open)}
        className="group"
      >
        <summary className="cursor-pointer select-none text-xs font-semibold text-dim uppercase tracking-wide mb-2 hover:text-muted">
          {t.packetDetail.rawData(rawData.length)}
        </summary>
        {rawOpen && <HexDump data={rawData} />}
      </details>
    </div>
  )
}

function MessageSection({
  message,
  index,
  total,
  holdTimer,
  refreshDiff,
  keepalive,
  onSelectPacket,
}: {
  message: BgpMessage
  index: number
  total: number
  holdTimer?: HoldTimerContext | null
  keepalive?: KeepaliveContext | null
  refreshDiff?: RouteRefreshDiff | null
  onSelectPacket?: (packetIndex: number) => void
}) {
  const { t } = useI18n()
  const title =
    total > 1
      ? t.packetDetail.messageTitleIndexed(message.type, index + 1, total)
      : t.packetDetail.messageTitle(message.type)

  return (
    <section>
      <h3 className="text-xs font-semibold text-dim uppercase tracking-wide mb-2">
        {title}
      </h3>
      {message.type === 'OPEN' && <OpenMessageView message={message} />}
      {message.type === 'NOTIFICATION' && (
        <NotificationMessageView message={message} holdTimer={holdTimer} />
      )}
      {message.type === 'KEEPALIVE' && <KeepaliveMessageView context={keepalive} />}
      {message.type === 'UPDATE' && <UpdateMessageView message={message} />}
      {message.type === 'ROUTE_REFRESH' && (
        <RouteRefreshMessageView
          message={message}
          diff={refreshDiff}
          onSelectPacket={onSelectPacket}
        />
      )}
    </section>
  )
}
