import type { BgpPacket, BgpMessage } from '../../lib/bgp/types'
import { OpenMessageView } from './OpenMessageView'
import { NotificationMessageView } from './NotificationMessageView'
import { KeepaliveMessageView } from './KeepaliveMessageView'
import { UpdateMessageView } from './UpdateMessageView'
import { RouteRefreshMessageView } from './RouteRefreshMessageView'
import { HexDump } from '../common/HexDump'
import type { HoldTimerContext } from '../../lib/bgp/hold-timer'
import type { RouteRefreshDiff } from '../../lib/bgp/route-refresh'

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
}

export function PacketDetail({
  packet,
  holdTimer,
  refreshDiff,
  onSelectPacket,
}: PacketDetailProps) {
  const { messages, rawData, parseWarnings } = packet

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      {/* Packet Info */}
      <section>
        <h3 className="text-sm font-semibold text-dim uppercase tracking-wide mb-2">
          Packet Info
        </h3>
        <div className="bg-surface-sunken rounded-lg p-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-muted">Time</span>
            <span className="font-mono">{packet.timestamp.toISOString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Source</span>
            <span className="font-mono">
              {packet.srcIp}:{packet.srcPort}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Destination</span>
            <span className="font-mono">
              {packet.dstIp}:{packet.dstPort}
            </span>
          </div>
          {messages.length > 1 && (
            <div className="flex justify-between">
              <span className="text-muted">Messages</span>
              <span className="font-mono">{messages.length}</span>
            </div>
          )}
        </div>
      </section>

      {/* Parse Warnings */}
      {parseWarnings.length > 0 && (
        <section>
          <div className="bg-warning-subtle border border-warning/30 rounded-lg p-3">
            <h4 className="text-sm font-medium text-warning mb-1">Parse Warnings</h4>
            <ul className="text-sm text-warning space-y-1">
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
          onSelectPacket={onSelectPacket}
        />
      ))}

      {/* Hex Dump */}
      <section>
        <h3 className="text-sm font-semibold text-dim uppercase tracking-wide mb-2">
          Raw Data ({rawData.length} bytes)
        </h3>
        <HexDump data={rawData} />
      </section>
    </div>
  )
}

function MessageSection({
  message,
  index,
  total,
  holdTimer,
  refreshDiff,
  onSelectPacket,
}: {
  message: BgpMessage
  index: number
  total: number
  holdTimer?: HoldTimerContext | null
  refreshDiff?: RouteRefreshDiff | null
  onSelectPacket?: (packetIndex: number) => void
}) {
  const title = total > 1 ? `BGP ${message.type} Message (${index + 1}/${total})` : `BGP ${message.type} Message`

  return (
    <section>
      <h3 className="text-sm font-semibold text-dim uppercase tracking-wide mb-2">
        {title}
      </h3>
      {message.type === 'OPEN' && <OpenMessageView message={message} />}
      {message.type === 'NOTIFICATION' && (
        <NotificationMessageView message={message} holdTimer={holdTimer} />
      )}
      {message.type === 'KEEPALIVE' && <KeepaliveMessageView />}
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
