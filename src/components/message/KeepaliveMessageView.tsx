export function KeepaliveMessageView() {
  return (
    <div className="bg-bgp-keepalive/10 border border-bgp-keepalive/30 rounded-lg p-3">
      <p className="text-sm text-bgp-keepalive">
        KEEPALIVE messages have no content beyond the BGP header (19 bytes total).
        They are used to maintain the session and confirm the peer is still reachable.
      </p>
    </div>
  )
}
