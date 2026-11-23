import type { DashboardAlert } from './types'

/**
 * Where a finding's evidence is: the Messages screen, filtered and with the
 * packet selected.
 *
 * A row whose evidence is a bare TCP frame needs both halves of `frame=` and
 * `all=1`: the list switched to All Packets, and the frame addressed by its
 * index in the capture, since an RST is not in the BGP packet array that
 * `selected=` indexes.
 */
export function alertLink(alert: DashboardAlert): string {
  const params = new URLSearchParams()
  if (alert.filter) params.set('filter', alert.filter)
  if (alert.packetIndex !== undefined) params.set('selected', String(alert.packetIndex))
  if (alert.frameIndex !== undefined) params.set('frame', String(alert.frameIndex))
  if (alert.showAllPackets) params.set('all', '1')
  const query = params.toString()
  return `/messages${query ? `?${query}` : ''}`
}
