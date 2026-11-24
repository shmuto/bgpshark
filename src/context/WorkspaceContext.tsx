import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useApp } from './AppContext'
import { useI18n } from '../i18n'
import { computeAlerts, computeTransportAlerts, scopeAlerts } from '../components/dashboard/alerts'
import type { AlertSeverity, DashboardAlert } from '../components/dashboard/types'
import { peeringKey, peeringAddresses } from '../lib/bgp/peering'
import { hasPrefixStats, prefixStatsForAsync } from '../lib/bgp/prefix-stats'
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
  /**
   * The findings for the scope: its session's own, and route findings counted
   * over its packets alone. The whole capture's when nothing is chosen.
   */
  scopedAlerts: DashboardAlert[]
  /**
   * True while a large capture's route statistics are still being worked out
   * in the background; the findings are empty until they are, which is not
   * the same as there being none.
   */
  findingsPending: boolean
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

/**
 * From how many BGP packets the findings wait for route statistics worked out
 * in the background.
 *
 * The route rules read statistics over every route in the capture, and
 * computing them in one go held the page frozen for seconds after a large
 * capture loaded — the packet list drawn but unusable. Above this size the
 * statistics are built in slices that leave the page responsive, and the
 * findings appear when they are done. Below it they take milliseconds, and
 * the findings are there with the list, as they always were.
 */
export const BACKGROUND_FINDINGS_MIN_PACKETS = 20_000

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

  const sessionPackets = useMemo(
    () => (scope ? packets.filter((p) => peeringKey(p.srcIp, p.dstIp) === scope) : packets),
    [packets, scope]
  )

  // On a large capture, work the route statistics out in the background —
  // the whole capture's, and the chosen session's — and only then the
  // findings, which read them from the cache at once.
  const background = packets.length > BACKGROUND_FINDINGS_MIN_PACKETS
  const [, setStatsVersion] = useState(0)
  const capturePending = background && !hasPrefixStats(packets)
  const scopePending = background && scope !== null && !hasPrefixStats(sessionPackets)
  useEffect(() => {
    if (!capturePending && !scopePending) return
    const controller = new AbortController()
    void (async () => {
      if (capturePending && !(await prefixStatsForAsync(packets, controller.signal))) return
      if (scopePending && !(await prefixStatsForAsync(sessionPackets, controller.signal))) return
      setStatsVersion((version) => version + 1)
    })()
    return () => controller.abort()
  }, [capturePending, scopePending, packets, sessionPackets])

  const alerts = useMemo(
    () =>
      capturePending
        ? []
        : packets.length > 0
          ? computeAlerts(packets, allPackets, locale)
          : computeTransportAlerts(allPackets, locale),
    [capturePending, packets, allPackets, locale]
  )
  const sessions = useMemo(
    () => summarizeSessions(packets, allPackets, alerts),
    [packets, allPackets, alerts]
  )

  const [range, setRange] = useState<[number, number] | null>(null)

  const scopedAlerts = useMemo(
    () => (capturePending || scopePending ? [] : scopeAlerts(alerts, packets, scope, locale, sessionPackets)),
    [capturePending, scopePending, alerts, packets, scope, locale, sessionPackets]
  )
  const findingsPending = capturePending || scopePending
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
    () => ({
      scope,
      setScope,
      alerts,
      scopedAlerts,
      findingsPending,
      sessions,
      range,
      setRange,
      scopedPackets,
      scopedAllPackets,
      sessionPackets,
    }),
    [scope, alerts, scopedAlerts, findingsPending, sessions, range, scopedPackets, scopedAllPackets, sessionPackets]
  )
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceValue {
  const context = useContext(WorkspaceContext)
  if (!context) throw new Error('useWorkspace must be used within a WorkspaceProvider')
  return context
}
