import type { BgpRouteRefreshMessage } from '../../lib/bgp/types'

interface RouteRefreshMessageViewProps {
  message: BgpRouteRefreshMessage
}

export function RouteRefreshMessageView({ message }: RouteRefreshMessageViewProps) {
  return (
    <div className="bg-cyan-50 border border-cyan-200 rounded-lg p-3 text-sm space-y-2">
      <div className="flex justify-between">
        <span className="text-cyan-700">AFI</span>
        <span className="font-mono">
          {message.afi} ({message.afiName})
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-cyan-700">SAFI</span>
        <span className="font-mono">
          {message.safi} ({message.safiName})
        </span>
      </div>
    </div>
  )
}
