import type { BgpNotificationMessage } from '../../lib/bgp/types'
import { HexDump } from '../common/HexDump'

interface NotificationMessageViewProps {
  message: BgpNotificationMessage
}

export function NotificationMessageView({ message }: NotificationMessageViewProps) {
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
