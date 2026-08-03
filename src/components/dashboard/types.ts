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
  timestamp: Date | null
  filter: string
  packetIndex?: number
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
