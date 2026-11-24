import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useApp } from './AppContext'
import { useI18n } from '../i18n'
import {
  alertsFor,
  alertsForAsync,
  computeTransportAlerts,
  hasAlerts,
  hasScopedAlerts,
  scopedAlertsFor,
  scopedAlertsForAsync,
} from '../components/dashboard/alerts'
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
  /**
   * The findings for the scope: its session's own, and route findings counted
   * over its packets alone. The whole capture's when nothing is chosen.
   */
  scopedAlerts: DashboardAlert[]
  /**
   * True while a large capture's findings are still being worked out in the
   * background; they are empty until they are, which is not the same as
   * there being none.
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
 * From how many BGP packets the findings are worked out in the background.
 *
 * The rules read every packet, frame and route in the capture, and computing
 * them in one go held the page frozen for seconds after a large capture
 * loaded — the packet list drawn but unusable. Above this size the route
 * statistics and then the rules run in slices that leave the page responsive,
 * and the findings appear when they are done. Below it they take
 * milliseconds, and the findings are there with the list, as they always were.
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

/** What the session list counts per peering, which does not change with the findings. */
interface SessionCounts {
  /** BGP messages per `peeringKey`, with TCP-only peerings on port 179 at 0. */
  messages: Map<string, number>
  asByIp: Map<string, number>
}

/**
 * The per-packet half of the session list, worked out once per capture.
 *
 * It walks every packet and every frame, and it used to run again each time
 * the findings changed — once with none while they were pending, once when
 * they arrived — which on a sparse 200MB capture was two more freezes of over
 * half a second. Consecutive packets nearly always belong to the peering
 * before them, so the key is only rebuilt when the addresses change: it was
 * one string concatenated per packet, most of the time spent here.
 */
function countSessions(packets: BgpPacket[], allPackets: GenericPacket[]): SessionCounts {
  const messages = new Map<string, number>()
  let lastSrc: string | null = null
  let lastDst: string | null = null
  let key = ''
  for (const packet of packets) {
    if (packet.srcIp !== lastSrc || packet.dstIp !== lastDst) {
      lastSrc = packet.srcIp
      lastDst = packet.dstIp
      key = peeringKey(lastSrc, lastDst)
    }
    messages.set(key, (messages.get(key) ?? 0) + packet.messages.length)
  }
  lastSrc = lastDst = null
  for (const frame of allPackets) {
    if (frame.protocol !== 'TCP' || (frame.srcPort !== 179 && frame.dstPort !== 179)) continue
    if (frame.srcIp !== lastSrc || frame.dstIp !== lastDst) {
      lastSrc = frame.srcIp
      lastDst = frame.dstIp
      key = peeringKey(lastSrc, lastDst)
    }
    if (!messages.has(key)) messages.set(key, 0)
  }
  return { messages, asByIp: latestAsByAddress(packets) }
}

/**
 * Sessions are pairs of addresses, not routers: the unit a NOTIFICATION, a hold
 * timer or a capability mismatch belongs to. TCP-only peerings on port 179 are
 * listed too, because a session that never got as far as BGP is exactly the one
 * someone opened the capture to look at.
 */
function summarizeSessions({ messages, asByIp }: SessionCounts, alerts: DashboardAlert[]): SessionSummary[] {
  const worst = new Map<string, AlertSeverity>()
  for (const alert of alerts) {
    if (!alert.peering || alert.severity === 'info') continue
    const current = worst.get(alert.peering)
    if (!current || SEVERITY_RANK[alert.severity] < SEVERITY_RANK[current]) {
      worst.set(alert.peering, alert.severity)
    }
  }

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

  // On a large capture, work the findings out in the background — the whole
  // capture's, and the chosen session's — and only then read them, from the
  // cache, at once.
  const background = packets.length > BACKGROUND_FINDINGS_MIN_PACKETS
  const [, setFindingsVersion] = useState(0)
  const capturePending = background && !hasAlerts(packets, allPackets, locale)

  const alerts = useMemo(
    () =>
      capturePending
        ? []
        : packets.length > 0
          ? alertsFor(packets, allPackets, locale)
          : computeTransportAlerts(allPackets, locale),
    [capturePending, packets, allPackets, locale]
  )
  const scopePending =
    background &&
    scope !== null &&
    (capturePending || !hasScopedAlerts(alerts, packets, scope, locale, sessionPackets))

  useEffect(() => {
    if (!capturePending && !scopePending) return
    const controller = new AbortController()
    void (async () => {
      const all = await alertsForAsync(packets, allPackets, locale, controller.signal)
      if (!all) return
      const scoped = await scopedAlertsForAsync(all, packets, scope, locale, sessionPackets, controller.signal)
      if (!scoped) return
      setFindingsVersion((version) => version + 1)
    })()
    return () => controller.abort()
  }, [capturePending, scopePending, packets, allPackets, locale, scope, sessionPackets])

  const sessionCounts = useMemo(() => countSessions(packets, allPackets), [packets, allPackets])
  const sessions = useMemo(() => summarizeSessions(sessionCounts, alerts), [sessionCounts, alerts])

  const [range, setRange] = useState<[number, number] | null>(null)

  const scopedAlerts = useMemo(
    () =>
      capturePending || scopePending ? [] : scopedAlertsFor(alerts, packets, scope, locale, sessionPackets),
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
