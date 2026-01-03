import type { BgpPacket, BgpMessage, BgpOpenMessage, BgpNotificationMessage, BgpCapability } from './types'

export interface OpenMessageRecord {
  timestamp: Date
  routerId: string
  asNumber: number
  holdTime: number
  capabilities: BgpCapability[]
}

export interface NeighborInfo {
  localAddress: string
  remoteAddress: string
  openHistory: OpenMessageRecord[]
  messageCount: {
    open: number
    update: number
    notification: number
    keepalive: number
    routeRefresh: number
  }
  lastSeen: Date
  hasNotification: boolean
  notificationInfo?: {
    errorCode: string
    errorSubcode: string
    hint: string
  }
}

export interface NeighborPair {
  local: NeighborInfo
  remote: NeighborInfo | null
  established: boolean
}

// New structure: one source IP with multiple destination IPs
export interface SessionInfo {
  srcIp: string
  dstIp: string
  openHistory: OpenMessageRecord[]
  messageCount: {
    open: number
    update: number
    notification: number
    keepalive: number
    routeRefresh: number
  }
  lastSeen: Date
  hasNotification: boolean
  notificationInfo?: {
    errorCode: string
    errorSubcode: string
    hint: string
  }
}

export interface NeighborGroup {
  srcIp: string
  sessions: SessionInfo[]
}

export function extractNeighbors(packets: BgpPacket[]): Map<string, NeighborInfo> {
  const neighbors = new Map<string, NeighborInfo>()

  for (const packet of packets) {
    const key = packet.srcIp

    if (!neighbors.has(key)) {
      neighbors.set(key, {
        localAddress: packet.srcIp,
        remoteAddress: packet.dstIp,
        openHistory: [],
        messageCount: {
          open: 0,
          update: 0,
          notification: 0,
          keepalive: 0,
          routeRefresh: 0,
        },
        lastSeen: packet.timestamp,
        hasNotification: false,
      })
    }

    const neighbor = neighbors.get(key)!
    neighbor.lastSeen = packet.timestamp

    for (const message of packet.messages) {
      processMessage(message, neighbor, packet.timestamp)
    }
  }

  return neighbors
}

function processMessage(
  message: BgpMessage,
  target: { openHistory: OpenMessageRecord[]; messageCount: NeighborInfo['messageCount']; hasNotification: boolean; notificationInfo?: NeighborInfo['notificationInfo'] },
  timestamp: Date
): void {
  switch (message.type) {
    case 'OPEN': {
      const openMsg = message as BgpOpenMessage
      target.openHistory.push({
        timestamp,
        routerId: openMsg.bgpIdentifier,
        asNumber: openMsg.fourByteAs ?? openMsg.myAs,
        holdTime: openMsg.holdTime,
        capabilities: openMsg.capabilities,
      })
      target.messageCount.open++
      break
    }
    case 'UPDATE':
      target.messageCount.update++
      break
    case 'NOTIFICATION': {
      const notifMsg = message as BgpNotificationMessage
      target.messageCount.notification++
      target.hasNotification = true
      target.notificationInfo = {
        errorCode: notifMsg.errorCodeName,
        errorSubcode: notifMsg.errorSubcodeName,
        hint: notifMsg.hint,
      }
      break
    }
    case 'KEEPALIVE':
      target.messageCount.keepalive++
      break
    case 'ROUTE_REFRESH':
      target.messageCount.routeRefresh++
      break
  }
}

export function pairNeighbors(neighbors: Map<string, NeighborInfo>): NeighborPair[] {
  const pairs: NeighborPair[] = []
  const processed = new Set<string>()

  for (const [ip, neighbor] of neighbors) {
    if (processed.has(ip)) continue

    const remoteIp = neighbor.remoteAddress
    const remote = neighbors.get(remoteIp)

    if (remote && !processed.has(remoteIp)) {
      pairs.push({
        local: neighbor,
        remote,
        established:
          neighbor.openHistory.length > 0 &&
          remote.openHistory.length > 0 &&
          !neighbor.hasNotification &&
          !remote.hasNotification,
      })
      processed.add(ip)
      processed.add(remoteIp)
    } else {
      pairs.push({
        local: neighbor,
        remote: null,
        established: false,
      })
      processed.add(ip)
    }
  }

  return pairs
}

// Extract sessions grouped by source IP
export function extractNeighborGroups(packets: BgpPacket[]): NeighborGroup[] {
  // Map: srcIp -> Map<dstIp -> SessionInfo>
  const sessionMap = new Map<string, Map<string, SessionInfo>>()

  for (const packet of packets) {
    const { srcIp, dstIp } = packet

    if (!sessionMap.has(srcIp)) {
      sessionMap.set(srcIp, new Map())
    }

    const dstMap = sessionMap.get(srcIp)!
    if (!dstMap.has(dstIp)) {
      dstMap.set(dstIp, {
        srcIp,
        dstIp,
        openHistory: [],
        messageCount: {
          open: 0,
          update: 0,
          notification: 0,
          keepalive: 0,
          routeRefresh: 0,
        },
        lastSeen: packet.timestamp,
        hasNotification: false,
      })
    }

    const session = dstMap.get(dstIp)!
    session.lastSeen = packet.timestamp

    for (const message of packet.messages) {
      processMessage(message, session, packet.timestamp)
    }
  }

  // Convert to array of NeighborGroups
  const groups: NeighborGroup[] = []
  for (const [srcIp, dstMap] of sessionMap) {
    groups.push({
      srcIp,
      sessions: Array.from(dstMap.values()),
    })
  }

  // Sort by srcIp
  groups.sort((a, b) => a.srcIp.localeCompare(b.srcIp))

  return groups
}

// Get session info (like getLatestOpen but for SessionInfo)
export function getSessionLatestOpen(session: SessionInfo): OpenMessageRecord | null {
  return session.openHistory.length > 0 ? session.openHistory[session.openHistory.length - 1] : null
}

export function getCapabilitySummary(capabilities: BgpCapability[]): string[] {
  return capabilities.map((cap) => {
    if (cap.parsed?.type === 'MULTIPROTOCOL') {
      return `${cap.parsed.afiName}/${cap.parsed.safiName}`
    }
    if (cap.parsed?.type === 'FOUR_OCTET_AS') {
      return `4-byte AS (${cap.parsed.asNumber})`
    }
    return cap.name
  })
}

// Get the latest OPEN message info (for backward compatibility)
export function getLatestOpen(neighbor: NeighborInfo): OpenMessageRecord | null {
  return neighbor.openHistory.length > 0 ? neighbor.openHistory[neighbor.openHistory.length - 1] : null
}

// Check if capabilities changed between OPEN messages
export function hasCapabilityChanges(neighbor: NeighborInfo): boolean {
  if (neighbor.openHistory.length < 2) return false

  const first = neighbor.openHistory[0]
  const last = neighbor.openHistory[neighbor.openHistory.length - 1]

  const firstCaps = new Set(first.capabilities.map((c) => c.name))
  const lastCaps = new Set(last.capabilities.map((c) => c.name))

  if (firstCaps.size !== lastCaps.size) return true

  for (const cap of firstCaps) {
    if (!lastCaps.has(cap)) return true
  }

  return false
}
