import type { BgpMessageTypeName } from '../../lib/bgp/types'

export type MessageTypeCounts = Record<BgpMessageTypeName, number>

export interface SummaryData {
  total: number
  counts: MessageTypeCounts
}

export type AlertSeverity = 'critical' | 'warning'

export interface DashboardAlert {
  id: string
  severity: AlertSeverity
  title: string
  detail: string
  /** The occurrence this row links to. For a grouped row that is the earliest one. */
  timestamp: Date | null
  filter: string
  packetIndex?: number
  /**
   * Occurrences rolled into this row. Absent or 1 is a single event and is
   * rendered exactly as an ungrouped alert — no count, no time range.
   */
  count?: number
  /** First and last occurrence, set only when the row stands for more than one. */
  timeSpan?: { start: Date; end: Date }
  /**
   * The peer pair this row is about, as `sortedPairKey` writes it. Set only by
   * the rules that judge a whole session rather than a message, so the
   * neighbour table can mark the same pair without deriving the finding twice.
   */
  pairKey?: string
}

export interface NeighborRow {
  pairKey: string
  ipA: string
  ipB: string
  routerId: string
  peerIp: string
  total: number
  counts: MessageTypeCounts
  hasNotification: boolean
  /**
   * The session never got going — one direction only, or a connection accepted
   * and never answered. Distinct from `hasNotification`, which is a session
   * that came up and then failed.
   */
  neverEstablished?: boolean
  lastActivity: Date
}

export interface TimelineBucket {
  start: Date
  updateCount: number
  notificationCount: number
}

export interface TimelineNotificationMarker {
  ratio: number
  timestamp: Date
  packetIndex: number
}

export interface TimelineData {
  buckets: TimelineBucket[]
  notifications: TimelineNotificationMarker[]
  start: Date | null
  end: Date | null
  maxUpdateCount: number
}
