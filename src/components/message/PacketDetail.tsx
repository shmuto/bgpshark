import type { BgpPacket, BgpMessage } from '../../lib/bgp/types'
import { OpenMessageView } from './OpenMessageView'
import { NotificationMessageView } from './NotificationMessageView'
import { KeepaliveMessageView } from './KeepaliveMessageView'
import { UpdateMessageView } from './UpdateMessageView'
import { RouteRefreshMessageView } from './RouteRefreshMessageView'
import { HexDump } from '../common/HexDump'

interface PacketDetailProps {
  packet: BgpPacket
}

export function PacketDetail({ packet }: PacketDetailProps) {
  const { messages, rawData, parseWarnings } = packet

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      {/* Packet Info */}
      <section>
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Packet Info
        </h3>
        <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-gray-500">Time</span>
            <span className="font-mono">{packet.timestamp.toISOString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Source</span>
            <span className="font-mono">
              {packet.srcIp}:{packet.srcPort}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Destination</span>
            <span className="font-mono">
              {packet.dstIp}:{packet.dstPort}
            </span>
          </div>
          {messages.length > 1 && (
            <div className="flex justify-between">
              <span className="text-gray-500">Messages</span>
              <span className="font-mono">{messages.length}</span>
            </div>
          )}
        </div>
      </section>

      {/* Parse Warnings */}
      {parseWarnings.length > 0 && (
        <section>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <h4 className="text-sm font-medium text-amber-700 mb-1">Parse Warnings</h4>
            <ul className="text-sm text-amber-600 space-y-1">
              {parseWarnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Message Content - render all messages */}
      {messages.map((message, index) => (
        <MessageSection key={index} message={message} index={index} total={messages.length} />
      ))}

      {/* Hex Dump */}
      <section>
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Raw Data ({rawData.length} bytes)
        </h3>
        <HexDump data={rawData} />
      </section>
    </div>
  )
}

function MessageSection({ message, index, total }: { message: BgpMessage; index: number; total: number }) {
  const title = total > 1 ? `BGP ${message.type} Message (${index + 1}/${total})` : `BGP ${message.type} Message`

  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        {title}
      </h3>
      {message.type === 'OPEN' && <OpenMessageView message={message} />}
      {message.type === 'NOTIFICATION' && <NotificationMessageView message={message} />}
      {message.type === 'KEEPALIVE' && <KeepaliveMessageView />}
      {message.type === 'UPDATE' && <UpdateMessageView message={message} />}
      {message.type === 'ROUTE_REFRESH' && <RouteRefreshMessageView message={message} />}
    </section>
  )
}
