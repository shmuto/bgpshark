import type { BgpMessageTypeName } from '../../lib/bgp/types'

const TONE: Record<BgpMessageTypeName, string> = {
  OPEN: 'text-bgp-open',
  UPDATE: 'text-bgp-update',
  NOTIFICATION: 'text-bgp-notification',
  KEEPALIVE: 'text-bgp-keepalive',
  ROUTE_REFRESH: 'text-bgp-route-refresh',
}

/**
 * A message type as a small square in the type's colour and the name beside
 * it, in the same colour.
 *
 * Filled badges made every row of the list a coloured block, and with
 * KEEPALIVEs most of the rows of most captures, the colour stopped meaning
 * anything. A mark and a word carry the type at a glance and leave the rows
 * that matter — a NOTIFICATION among keepalives — to stand out on their own.
 * The msg-* tokens are text colours tuned for both themes, so text and mark
 * share one token rather than a fill needing its own foreground.
 */
export function MessageTypeLabel({ type, extra }: { type: BgpMessageTypeName; extra?: number }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] font-medium ${TONE[type]}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-current" aria-hidden="true" />
      {type}
      {extra !== undefined && extra > 0 && <span className="font-normal text-dim">+{extra}</span>}
    </span>
  )
}
