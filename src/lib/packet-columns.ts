/**
 * Pure helpers behind the packet list's Prefix and Delta columns.
 *
 * They live outside the component because both encode judgement calls that are
 * worth testing on their own — how much of a large UPDATE a single table cell
 * can honestly show, and at what magnitude a gap between packets stops being
 * readable as a decimal number of seconds.
 */
import type { BgpMessage, BgpPrefix, BgpUpdateMessage } from './bgp/types'
import { countUpdatePrefixes, endOfRibMarker } from './bgp/update'
import { formatPrefix } from './net/prefix'
import { formatEvpnShort } from './bgp/evpn'

/**
 * Prefixes shown per direction before the rest become a `+N` tail.
 *
 * A table row is not the place to read a full-table dump: two prefixes are
 * enough to recognise what an UPDATE is about (and to tell one row from the
 * next while scrolling a filtered list), and the count carries the rest.
 */
export const PREFIX_DISPLAY_LIMIT = 2

export interface PrefixGroup {
  /** Formatted `prefix/length` strings, at most `limit` of them. */
  shown: string[]
  /** How many further prefixes exist beyond `shown`. */
  overflow: number
}

export interface PacketPrefixSummary {
  announced: PrefixGroup
  withdrawn: PrefixGroup
  /**
   * At least one UPDATE in the packet is an End-of-RIB marker. Only meaningful
   * when nothing is announced or withdrawn, which is the definition of one.
   */
  endOfRib: boolean
}

/**
 * Summarise the NLRI of every UPDATE in one packet, MP_REACH/MP_UNREACH
 * included.
 *
 * Returns null when the packet carries no UPDATE at all, so the caller renders
 * an empty cell rather than an empty-looking one.
 *
 * Totals come from `countUpdatePrefixes` so this cell can never disagree with
 * the Info column's counts, and only the first few prefixes are ever formatted:
 * a full-table UPDATE carries thousands, and this runs per rendered row.
 */
export function summarizePacketPrefixes(
  messages: BgpMessage[],
  limit: number = PREFIX_DISPLAY_LIMIT
): PacketPrefixSummary | null {
  const announced: string[] = []
  const withdrawn: string[] = []
  let announcedTotal = 0
  let withdrawnTotal = 0
  let endOfRib = false
  let sawUpdate = false

  const take = (into: string[], prefixes: BgpPrefix[]) => {
    for (const prefix of prefixes) {
      if (into.length >= limit) return
      // An EVPN route's full description carries its RD and VNI as well, which
      // is more than a column can hold; the detail view has room for those.
      into.push(prefix.evpn ? formatEvpnShort(prefix.evpn) : formatPrefix(prefix))
    }
  }

  for (const message of messages) {
    if (message.type !== 'UPDATE') continue
    const update = message as BgpUpdateMessage
    sawUpdate = true

    if (endOfRibMarker(update)) endOfRib = true

    const counts = countUpdatePrefixes(update)
    announcedTotal += counts.announced
    withdrawnTotal += counts.withdrawn

    take(announced, update.nlri)
    take(withdrawn, update.withdrawnRoutes)
    for (const attr of update.pathAttributes) {
      if (attr.parsed?.type === 'MP_REACH_NLRI') take(announced, attr.parsed.nlri)
      if (attr.parsed?.type === 'MP_UNREACH_NLRI') take(withdrawn, attr.parsed.withdrawnRoutes)
    }
  }

  if (!sawUpdate) return null

  return {
    announced: { shown: announced, overflow: announcedTotal - announced.length },
    withdrawn: { shown: withdrawn, overflow: withdrawnTotal - withdrawn.length },
    endOfRib,
  }
}
