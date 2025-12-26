import type { BgpPacket, BgpOpenMessage, BgpCapability } from './types'

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

    switch (packet.message.type) {
      case 'OPEN': {
        const openMsg = packet.message as BgpOpenMessage
        neighbor.openHistory.push({
          timestamp: packet.timestamp,
          routerId: openMsg.bgpIdentifier,
          asNumber: openMsg.fourByteAs ?? openMsg.myAs,
          holdTime: openMsg.holdTime,
          capabilities: openMsg.capabilities,
        })
        neighbor.messageCount.open++
        break
      }
      case 'UPDATE':
        neighbor.messageCount.update++
        break
      case 'NOTIFICATION':
        neighbor.messageCount.notification++
        neighbor.hasNotification = true
        neighbor.notificationInfo = {
          errorCode: packet.message.errorCodeName,
          errorSubcode: packet.message.errorSubcodeName,
          hint: packet.message.hint,
        }
        break
      case 'KEEPALIVE':
        neighbor.messageCount.keepalive++
        break
      case 'ROUTE_REFRESH':
        neighbor.messageCount.routeRefresh++
        break
    }
  }

  return neighbors
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
