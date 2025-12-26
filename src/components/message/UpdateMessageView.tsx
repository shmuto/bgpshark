import type { BgpUpdateMessage } from '../../lib/bgp/types'

interface UpdateMessageViewProps {
  message: BgpUpdateMessage
}

export function UpdateMessageView({ message }: UpdateMessageViewProps) {
  return (
    <div className="space-y-3">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm space-y-2">
        <div className="flex justify-between">
          <span className="text-blue-700">Withdrawn Routes Length</span>
          <span className="font-mono">{message.withdrawnRoutesLength} bytes</span>
        </div>
        <div className="flex justify-between">
          <span className="text-blue-700">Path Attributes Length</span>
          <span className="font-mono">{message.totalPathAttrLength} bytes</span>
        </div>
      </div>

      <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-500">
        Detailed UPDATE message parsing (AS_PATH, NLRI, etc.) will be available in a future version.
      </div>
    </div>
  )
}
