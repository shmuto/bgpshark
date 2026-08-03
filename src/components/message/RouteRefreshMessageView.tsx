import type { BgpRouteRefreshMessage } from '../../lib/bgp/types'

interface RouteRefreshMessageViewProps {
  message: BgpRouteRefreshMessage
}

export function RouteRefreshMessageView({ message }: RouteRefreshMessageViewProps) {
  return (
    <div className="bg-bgp-route-refresh/10 border border-bgp-route-refresh/30 rounded-lg p-3 text-sm space-y-2 text-bgp-route-refresh">
      <div className="flex justify-between">
        <span>AFI</span>
        <span className="font-mono">
          {message.afi} ({message.afiName})
        </span>
      </div>
      <div className="flex justify-between">
        <span>SAFI</span>
        <span className="font-mono">
          {message.safi} ({message.safiName})
        </span>
      </div>
    </div>
  )
}
