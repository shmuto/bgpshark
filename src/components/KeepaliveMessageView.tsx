export function KeepaliveMessageView() {
  return (
    <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
      <p className="text-sm text-purple-700">
        KEEPALIVE messages have no content beyond the BGP header (19 bytes total).
        They are used to maintain the session and confirm the peer is still reachable.
      </p>
    </div>
  )
}
