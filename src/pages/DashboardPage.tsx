import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { extractNeighbors, getLatestOpen } from '../lib/bgp/neighbor'
import type { BgpPacket, BgpNotificationMessage, BgpUpdateMessage, MpUnreachNlriAttribute } from '../lib/bgp/types'
import type { GenericPacket } from '../lib/pcap'
import {
  SummaryCards,
  AlertList,
  NeighborSummaryTable,
  MessageTimeline,
} from '../components/dashboard'
import type { SummaryData, DashboardAlert, NeighborRow, TimelineData, MessageTypeCounts } from '../components/dashboard'

// A pair of peers is considered "flapped" once we see more than one full
// OPEN handshake (2 OPENs = one handshake) between the same two IPs.
const FLAP_OPEN_THRESHOLD = 4

// This many withdrawn prefixes inside a single 10s window counts as a burst.
const WITHDRAWN_BURST_WINDOW_MS = 10_000
const WITHDRAWN_BURST_THRESHOLD = 10

const TIMELINE_BUCKET_COUNT = 40

function emptyCounts(): MessageTypeCounts {
  return { OPEN: 0, UPDATE: 0, NOTIFICATION: 0, KEEPALIVE: 0, ROUTE_REFRESH: 0 }
}

function sortedPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function getWithdrawnCount(update: BgpUpdateMessage): number {
  let count = update.withdrawnRoutes.length
  for (const attr of update.pathAttributes) {
    if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
      count += (attr.parsed as MpUnreachNlriAttribute).withdrawnRoutes.length
    }
  }
  return count
}

function computeSummary(packets: BgpPacket[]): SummaryData {
  const counts = emptyCounts()
  for (const packet of packets) {
    for (const msg of packet.messages) {
      counts[msg.type]++
    }
  }
  return { total: packets.length, counts }
}

function computeAlerts(packets: BgpPacket[]): DashboardAlert[] {
  const alerts: DashboardAlert[] = []

  // 1. Every NOTIFICATION is a critical alert.
  packets.forEach((packet, packetIndex) => {
    for (const msg of packet.messages) {
      if (msg.type !== 'NOTIFICATION') continue
      const notif = msg as BgpNotificationMessage
      alerts.push({
        id: `notif-${packetIndex}`,
        severity: 'critical',
        title: `NOTIFICATION: ${notif.errorCodeName} / ${notif.errorSubcodeName}`,
        detail: `${packet.srcIp} → ${packet.dstIp}`,
        timestamp: packet.timestamp,
        filter: `(src=${packet.srcIp} and dst=${packet.dstIp}) or (src=${packet.dstIp} and dst=${packet.srcIp})`,
        packetIndex,
      })
    }
  })

  // 2. Flapping sessions: repeated OPEN exchanges between the same peer pair.
  const opensByPair = new Map<string, { timestamp: Date; packetIndex: number }[]>()
  packets.forEach((packet, packetIndex) => {
    for (const msg of packet.messages) {
      if (msg.type !== 'OPEN') continue
      const key = sortedPairKey(packet.srcIp, packet.dstIp)
      if (!opensByPair.has(key)) opensByPair.set(key, [])
      opensByPair.get(key)!.push({ timestamp: packet.timestamp, packetIndex })
    }
  })
  for (const [key, opens] of opensByPair) {
    if (opens.length < FLAP_OPEN_THRESHOLD) continue
    const [ipA, ipB] = key.split('|')
    const establishments = Math.floor(opens.length / 2)
    alerts.push({
      id: `flap-${key}`,
      severity: 'warning',
      title: 'Session flapping detected',
      detail: `${ipA} ↔ ${ipB} — ${opens.length} OPEN messages (~${establishments} establishments)`,
      timestamp: opens[opens.length - 1].timestamp,
      filter: `(src=${ipA} and dst=${ipB}) or (src=${ipB} and dst=${ipA})`,
      packetIndex: opens[0].packetIndex,
    })
  }

  // 3. Bursts of withdrawn prefixes within a short time window.
  const withdrawEvents: { timestamp: Date; count: number; packetIndex: number }[] = []
  packets.forEach((packet, packetIndex) => {
    for (const msg of packet.messages) {
      if (msg.type !== 'UPDATE') continue
      const count = getWithdrawnCount(msg as BgpUpdateMessage)
      if (count > 0) withdrawEvents.push({ timestamp: packet.timestamp, count, packetIndex })
    }
  })
  withdrawEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

  let cursor = 0
  while (cursor < withdrawEvents.length) {
    const windowStartTime = withdrawEvents[cursor].timestamp.getTime()
    let windowEnd = cursor
    let windowTotal = 0
    while (
      windowEnd < withdrawEvents.length &&
      withdrawEvents[windowEnd].timestamp.getTime() - windowStartTime <= WITHDRAWN_BURST_WINDOW_MS
    ) {
      windowTotal += withdrawEvents[windowEnd].count
      windowEnd++
    }
    if (windowTotal >= WITHDRAWN_BURST_THRESHOLD) {
      alerts.push({
        id: `withdraw-burst-${cursor}`,
        severity: 'warning',
        title: 'Burst of withdrawn prefixes',
        detail: `${windowTotal} prefixes withdrawn within ${WITHDRAWN_BURST_WINDOW_MS / 1000}s`,
        timestamp: withdrawEvents[cursor].timestamp,
        filter: 'type=UPDATE',
        packetIndex: withdrawEvents[cursor].packetIndex,
      })
      cursor = windowEnd // move past this burst instead of re-triggering on overlapping windows
    } else {
      cursor++
    }
  }

  // Most severe first, then most recent first within the same severity.
  const severityRank: Record<DashboardAlert['severity'], number> = { critical: 0, warning: 1 }
  return alerts.sort((a, b) => {
    if (severityRank[a.severity] !== severityRank[b.severity]) {
      return severityRank[a.severity] - severityRank[b.severity]
    }
    return (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0)
  })
}

/**
 * When a capture holds no BGP at all, the interesting question is *why* — and
 * the answer is usually visible at the TCP layer. A capture of SYNs answered
 * by RSTs is a session failing to establish (filter, MD5/TCP-AO mismatch,
 * BGP not running), and presenting that as "no issues detected" sends the
 * engineer away from the evidence.
 */
function computeTransportAlerts(allPackets: GenericPacket[]): DashboardAlert[] {
  const port179 = allPackets.filter(
    (p) => p.protocol === 'TCP' && (p.srcPort === 179 || p.dstPort === 179)
  )

  if (port179.length === 0) {
    const tcpCount = allPackets.filter((p) => p.protocol === 'TCP').length
    return [
      {
        id: 'transport-no-179',
        severity: 'warning',
        title: 'No BGP messages and no TCP port 179 traffic',
        detail:
          tcpCount > 0
            ? `${tcpCount} TCP packets on other ports — non-standard-port sessions are decoded only when BGP message markers are visible in the flow`
            : 'The capture contains no TCP traffic',
        timestamp: allPackets[0]?.timestamp ?? null,
        filter: '',
      },
    ]
  }

  const syns = port179.filter((p) => p.dstPort === 179 && p.tcpFlags?.syn && !p.tcpFlags?.ack)
  const synAcks = port179.filter((p) => p.srcPort === 179 && p.tcpFlags?.syn && p.tcpFlags?.ack)
  const rsts = port179.filter((p) => p.srcPort === 179 && p.tcpFlags?.rst)
  const withPayload = port179.filter((p) => p.payloadLength > 0)

  if (withPayload.length === 0 && syns.length > 0 && rsts.length > 0) {
    return [
      {
        id: 'transport-refused',
        severity: 'critical',
        title: 'TCP connections to port 179 are being refused',
        detail: `${syns.length} SYNs answered by RST — the session never reaches BGP. Check ACLs/filters, MD5 (TCP-AO) configuration, or whether BGP is running on the peer`,
        timestamp: syns[0].timestamp,
        filter: '',
      },
    ]
  }

  if (withPayload.length === 0 && syns.length > 0 && synAcks.length === 0) {
    return [
      {
        id: 'transport-unanswered',
        severity: 'critical',
        title: 'TCP SYNs to port 179 go unanswered',
        detail: `${syns.length} SYNs with no SYN-ACK — traffic filtered in transit or the peer is unreachable`,
        timestamp: syns[0].timestamp,
        filter: '',
      },
    ]
  }

  return [
    {
      id: 'transport-no-bgp-payload',
      severity: 'warning',
      title: 'TCP port 179 traffic carries no decodable BGP',
      detail: `${port179.length} packets on port 179 but no BGP messages could be decoded`,
      timestamp: port179[0].timestamp,
      filter: '',
    },
  ]
}

function computeNeighborRows(packets: BgpPacket[]): NeighborRow[] {
  const neighborsByIp = extractNeighbors(packets)

  const routerIdFor = (ip: string): string => {
    const info = neighborsByIp.get(ip)
    const latest = info ? getLatestOpen(info) : null
    return latest?.routerId ?? `unknown-${ip}`
  }

  const rows = new Map<string, NeighborRow>()

  for (const packet of packets) {
    const ipA = packet.srcIp < packet.dstIp ? packet.srcIp : packet.dstIp
    const ipB = packet.srcIp < packet.dstIp ? packet.dstIp : packet.srcIp
    const pairKey = `${ipA}|${ipB}`

    if (!rows.has(pairKey)) {
      rows.set(pairKey, {
        pairKey,
        ipA,
        ipB,
        routerId: routerIdFor(ipA),
        peerIp: ipB,
        total: 0,
        counts: emptyCounts(),
        hasNotification: false,
        lastActivity: packet.timestamp,
      })
    }

    const row = rows.get(pairKey)!
    if (packet.timestamp > row.lastActivity) row.lastActivity = packet.timestamp
    for (const msg of packet.messages) {
      row.total++
      row.counts[msg.type]++
      if (msg.type === 'NOTIFICATION') row.hasNotification = true
    }
  }

  return Array.from(rows.values()).sort((a, b) => b.total - a.total)
}

function computeTimeline(packets: BgpPacket[]): TimelineData {
  if (packets.length === 0) {
    return { buckets: [], notifications: [], start: null, end: null, maxUpdateCount: 0 }
  }

  const timestamps = packets.map((p) => p.timestamp.getTime())
  const startMs = Math.min(...timestamps)
  const endMs = Math.max(...timestamps)
  const span = Math.max(endMs - startMs, 1) // avoid divide-by-zero for single-packet or instant captures

  const buckets = Array.from({ length: TIMELINE_BUCKET_COUNT }, (_, i) => ({
    start: new Date(startMs + (i * span) / TIMELINE_BUCKET_COUNT),
    updateCount: 0,
    notificationCount: 0,
  }))

  const notifications: TimelineData['notifications'] = []

  packets.forEach((packet, packetIndex) => {
    const ratio = (packet.timestamp.getTime() - startMs) / span
    const bucketIndex = Math.min(TIMELINE_BUCKET_COUNT - 1, Math.floor(ratio * TIMELINE_BUCKET_COUNT))
    for (const msg of packet.messages) {
      if (msg.type === 'UPDATE') buckets[bucketIndex].updateCount++
      if (msg.type === 'NOTIFICATION') {
        buckets[bucketIndex].notificationCount++
        notifications.push({ ratio, timestamp: packet.timestamp, packetIndex })
      }
    }
  })

  const maxUpdateCount = Math.max(0, ...buckets.map((b) => b.updateCount))

  return { buckets, notifications, start: new Date(startMs), end: new Date(endMs), maxUpdateCount }
}

export function DashboardPage() {
  const { packets, allPackets, fileName } = useApp()
  const navigate = useNavigate()

  const summary = useMemo(() => computeSummary(packets), [packets])
  const alerts = useMemo(
    () =>
      packets.length > 0 ? computeAlerts(packets) : computeTransportAlerts(allPackets),
    [packets, allPackets]
  )
  const neighborRows = useMemo(() => computeNeighborRows(packets), [packets])
  const timeline = useMemo(() => computeTimeline(packets), [packets])

  const handleSummarySelect = (filter: string | null) => {
    navigate(filter ? `/messages?filter=${encodeURIComponent(filter)}` : '/messages')
  }

  const handleSelectNotification = (packetIndex: number) => {
    navigate(`/messages?filter=${encodeURIComponent('type=NOTIFICATION')}&selected=${packetIndex}`)
  }

  return (
    <div className="flex-1 overflow-auto bg-canvas">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">📊</span>
            <h1 className="text-lg font-semibold text-strong">Dashboard</h1>
          </div>
          {fileName && <span className="text-sm text-muted">📁 {fileName}</span>}
        </div>

        <SummaryCards summary={summary} onSelect={handleSummarySelect} />
        <AlertList alerts={alerts} />
        <NeighborSummaryTable rows={neighborRows} />
        <MessageTimeline data={timeline} onSelectNotification={handleSelectNotification} />
      </div>
    </div>
  )
}
