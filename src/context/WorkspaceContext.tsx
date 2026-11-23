import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useApp } from './AppContext'
import { useI18n } from '../i18n'
import { computeAlerts, computeTransportAlerts } from '../components/dashboard/alerts'
import type { AlertSeverity, DashboardAlert } from '../components/dashboard/types'
import { peeringKey, peeringAddresses } from '../lib/bgp/peering'
import type { BgpOpenMessage, BgpPacket } from '../lib/bgp/types'
import type { GenericPacket } from '../lib/pcap'

/** One row of the session list. */
export interface SessionSummary {
  /** `peeringKey` of the two addresses. */
  key: string
  ipA: string
  ipB: string
  /** AS each address announced in its latest OPEN, when the capture has one. */
  asA: number | null
  asB: number | null
  /** BGP messages exchanged, both directions. */
  messages: number
  /** Worst finding raised against the session, or null when there is none. */
  severity: AlertSeverity | null
}

interface WorkspaceValue {
  /** The session every view is narrowed to, or null for the whole capture. */
  scope: string | null
  setScope: (key: string | null) => void
  alerts: DashboardAlert[]
  sessions: SessionSummary[]
  /**
   * The time window every view is narrowed to, as epoch milliseconds
   * (inclusive), or null for the whole capture.
   */
  range: [number, number] | null
  setRange: (range: [number, number] | null) => void
  /** The capture's BGP packets, narrowed to the scope and the time window. */
  scopedPackets: BgpPacket[]
  /** Every frame, narrowed to the scope and the time window. */
  scopedAllPackets: GenericPacket[]
  /** The scope's BGP packets over the whole capture, for drawing the time strip. */
  sessionPackets: BgpPacket[]
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null)

function inRange(timestamp: Date, [from, to]: [number, number]): boolean {
  const ms = timestamp.getTime()
  return ms >= from && ms <= to
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }

function latestAsByAddress(packets: BgpPacket[]): Map<string, number> {
  const asByIp = new Map<string, number>()
  for (const packet of packets) {
    for (const msg of packet.messages) {
      if (msg.type !== 'OPEN') continue
      const open = msg as BgpOpenMessage
      asByIp.set(packet.srcIp, open.fourByteAs ?? open.myAs)
    }
  }
  return asByIp
}

/**
 * Sessions are pairs of addresses, not routers: the unit a NOTIFICATION, a hold
 * timer or a capability mismatch belongs to. TCP-only peerings on port 179 are
 * listed too, because a session that never got as far as BGP is exactly the one
 * someone opened the capture to look at.
 */
function summarizeSessions(
  packets: BgpPacket[],
  allPackets: GenericPacket[],
  alerts: DashboardAlert[]
): SessionSummary[] {
  const messages = new Map<string, number>()
  for (const packet of packets) {
    const key = peeringKey(packet.srcIp, packet.dstIp)
    messages.set(key, (messages.get(key) ?? 0) + packet.messages.length)
  }
  for (const frame of allPackets) {
    if (frame.protocol !== 'TCP' || (frame.srcPort !== 179 && frame.dstPort !== 179)) continue
    const key = peeringKey(frame.srcIp, frame.dstIp)
    if (!messages.has(key)) messages.set(key, 0)
  }

  const worst = new Map<string, AlertSeverity>()
  for (const alert of alerts) {
    if (!alert.peering || alert.severity === 'info') continue
    const current = worst.get(alert.peering)
    if (!current || SEVERITY_RANK[alert.severity] < SEVERITY_RANK[current]) {
      worst.set(alert.peering, alert.severity)
    }
  }

  const asByIp = latestAsByAddress(packets)
  return Array.from(messages.entries())
    .map(([key, count]): SessionSummary => {
      const [ipA, ipB] = peeringAddresses(key)
      return {
        key,
        ipA,
        ipB,
        asA: asByIp.get(ipA) ?? null,
        asB: asByIp.get(ipB) ?? null,
        messages: count,
        severity: worst.get(key) ?? null,
      }
    })
    .sort(
      (a, b) =>
        (a.severity ? SEVERITY_RANK[a.severity] : 3) - (b.severity ? SEVERITY_RANK[b.severity] : 3) ||
        b.messages - a.messages ||
        a.key.localeCompare(b.key, undefined, { numeric: true })
    )
}

/**
 * State the analysis tabs share: which session the reader has narrowed to, and
 * the findings and session list every tab's sidebar shows.
 *
 * Held by the workspace layout, which stays mounted while the reader moves
 * between tabs, so the scope survives a tab change and is dropped with the
 * capture.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { packets, allPackets } = useApp()
  const { locale } = useI18n()
  const [scope, setScope] = useState<string | null>(null)

  // A link can open the workspace on a session by carrying it in navigation
  // state (`{ scope: key }`) — how old /neighbors links keep their meaning.
  const requestedScope = (useLocation().state as { scope?: string } | null)?.scope
  useEffect(() => {
    if (requestedScope) setScope(requestedScope)
  }, [requestedScope])

  const alerts = useMemo(
    () =>
      packets.length > 0
        ? computeAlerts(packets, allPackets, locale)
        : computeTransportAlerts(allPackets, locale),
    [packets, allPackets, locale]
  )
  const sessions = useMemo(
    () => summarizeSessions(packets, allPackets, alerts),
    [packets, allPackets, alerts]
  )

  const [range, setRange] = useState<[number, number] | null>(null)

  const sessionPackets = useMemo(
    () => (scope ? packets.filter((p) => peeringKey(p.srcIp, p.dstIp) === scope) : packets),
    [packets, scope]
  )
  const scopedPackets = useMemo(
    () => (range ? sessionPackets.filter((p) => inRange(p.timestamp, range)) : sessionPackets),
    [sessionPackets, range]
  )
  const scopedAllPackets = useMemo(
    () =>
      scope || range
        ? allPackets.filter(
            (p) => (!scope || peeringKey(p.srcIp, p.dstIp) === scope) && (!range || inRange(p.timestamp, range))
          )
        : allPackets,
    [allPackets, scope, range]
  )

  const value = useMemo(
    () => ({ scope, setScope, alerts, sessions, range, setRange, scopedPackets, scopedAllPackets, sessionPackets }),
    [scope, alerts, sessions, range, scopedPackets, scopedAllPackets, sessionPackets]
  )
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceValue {
  const context = useContext(WorkspaceContext)
  if (!context) throw new Error('useWorkspace must be used within a WorkspaceProvider')
  return context
}
