import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { extractNeighbors, getLatestOpen } from '../lib/bgp/neighbor'
import type { BgpPacket } from '../lib/bgp/types'
import { minMax } from '../lib/range'
import {
  SummaryCards,
  AlertList,
  NeighborSummaryTable,
  MessageTimeline,
  computeAlerts,
  computeTransportAlerts,
} from '../components/dashboard'
import type { SummaryData, NeighborRow, TimelineData, MessageTypeCounts } from '../components/dashboard'

const TIMELINE_BUCKET_COUNT = 40

function emptyCounts(): MessageTypeCounts {
  return { OPEN: 0, UPDATE: 0, NOTIFICATION: 0, KEEPALIVE: 0, ROUTE_REFRESH: 0 }
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
  // packets is non-empty here, so minMax cannot return null.
  const { min: startMs, max: endMs } = minMax(timestamps) ?? { min: 0, max: 0 }
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
      packets.length > 0 ? computeAlerts(packets, allPackets) : computeTransportAlerts(allPackets),
    [packets, allPackets]
  )
  const neighborRows = useMemo(() => {
    const rows = computeNeighborRows(packets)
    // A session that never came up must not be listed as OK next to a critical
    // alert saying it never came up. The alerts already decided this; reading
    // their pair keys keeps one judgement rather than two that can disagree.
    const troubled = new Set(alerts.map((alert) => alert.pairKey).filter(Boolean))
    return rows.map((row) =>
      troubled.has(row.pairKey) ? { ...row, neverEstablished: true } : row
    )
  }, [packets, alerts])
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
