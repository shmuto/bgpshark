/**
 * Extract session state change events from BGP packets
 * for timeline visualization
 */
import type { BgpPacket, BgpOpenMessage, BgpNotificationMessage } from './types'

export type SessionState = 'Idle' | 'Connect' | 'OpenSent' | 'OpenConfirm' | 'Established' | 'Down'

export interface SessionEvent {
  timestamp: Date
  sessionKey: string // "srcIp -> dstIp"
  srcIp: string
  dstIp: string
  eventType: 'OPEN_SENT' | 'OPEN_RECEIVED' | 'KEEPALIVE' | 'NOTIFICATION' | 'UPDATE'
  state: SessionState
  details?: {
    routerId?: string
    asNumber?: number
    errorCode?: string
    errorSubcode?: string
    hint?: string
  }
}

export interface SessionStateTrack {
  sessionKey: string
  srcIp: string
  dstIp: string
  events: SessionEvent[]
  currentState: SessionState
  establishedAt?: Date
  downAt?: Date
}

/**
 * Extract session events from packets
 * Returns events sorted by timestamp
 */
export function extractSessionEvents(packets: BgpPacket[]): SessionEvent[] {
  const events: SessionEvent[] = []

  // Track state for each unidirectional session
  const sessionStates = new Map<string, SessionState>()

  // Track bidirectional session state (have we seen OPEN from both sides?)
  const bidirectionalState = new Map<string, { srcOpen: boolean; dstOpen: boolean; established: boolean }>()

  for (const packet of packets) {
    const { srcIp, dstIp, timestamp } = packet
    const sessionKey = `${srcIp} → ${dstIp}`
    const reverseKey = `${dstIp} → ${srcIp}`
    const pairKey = [srcIp, dstIp].sort().join('-')

    // Initialize bidirectional tracking
    if (!bidirectionalState.has(pairKey)) {
      bidirectionalState.set(pairKey, { srcOpen: false, dstOpen: false, established: false })
    }
    const pairState = bidirectionalState.get(pairKey)!

    // Initialize session state
    if (!sessionStates.has(sessionKey)) {
      sessionStates.set(sessionKey, 'Idle')
    }

    for (const message of packet.messages) {
      const currentState = sessionStates.get(sessionKey)!

      switch (message.type) {
        case 'OPEN': {
          const openMsg = message as BgpOpenMessage

          // Mark this direction has sent OPEN
          if (srcIp < dstIp) {
            pairState.srcOpen = true
          } else {
            pairState.dstOpen = true
          }

          // Check if we've seen OPEN from the other side
          const reverseState = sessionStates.get(reverseKey)
          const hasReverseOpen = reverseState === 'OpenSent' || reverseState === 'OpenConfirm' || reverseState === 'Established'

          const newState: SessionState = hasReverseOpen ? 'OpenConfirm' : 'OpenSent'
          sessionStates.set(sessionKey, newState)

          events.push({
            timestamp,
            sessionKey,
            srcIp,
            dstIp,
            eventType: 'OPEN_SENT',
            state: newState,
            details: {
              routerId: openMsg.bgpIdentifier,
              asNumber: openMsg.fourByteAs ?? openMsg.myAs,
            },
          })
          break
        }

        case 'KEEPALIVE': {
          // First KEEPALIVE after OPEN means established
          if (currentState === 'OpenSent' || currentState === 'OpenConfirm') {
            sessionStates.set(sessionKey, 'Established')
            pairState.established = true

            events.push({
              timestamp,
              sessionKey,
              srcIp,
              dstIp,
              eventType: 'KEEPALIVE',
              state: 'Established',
            })
          }
          // Subsequent KEEPALIVEs don't change state, so we don't log them
          break
        }

        case 'NOTIFICATION': {
          const notifMsg = message as BgpNotificationMessage
          sessionStates.set(sessionKey, 'Down')

          // Also mark reverse session as down
          if (sessionStates.has(reverseKey)) {
            sessionStates.set(reverseKey, 'Down')
          }

          events.push({
            timestamp,
            sessionKey,
            srcIp,
            dstIp,
            eventType: 'NOTIFICATION',
            state: 'Down',
            details: {
              errorCode: notifMsg.errorCodeName,
              errorSubcode: notifMsg.errorSubcodeName,
              hint: notifMsg.hint,
            },
          })
          break
        }

        case 'UPDATE': {
          // UPDATE only makes sense if established, but we'll record first UPDATE
          if (currentState !== 'Established') {
            // Implicit establishment if we see UPDATE without seeing KEEPALIVE
            sessionStates.set(sessionKey, 'Established')
            events.push({
              timestamp,
              sessionKey,
              srcIp,
              dstIp,
              eventType: 'UPDATE',
              state: 'Established',
            })
          }
          break
        }
      }
    }
  }

  return events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}

/**
 * Group events by session (bidirectional pair)
 */
export function groupEventsBySession(events: SessionEvent[]): Map<string, SessionStateTrack> {
  const tracks = new Map<string, SessionStateTrack>()

  for (const event of events) {
    // Create canonical session key (sorted IPs)
    const pairKey = [event.srcIp, event.dstIp].sort().join(' ↔ ')

    if (!tracks.has(pairKey)) {
      tracks.set(pairKey, {
        sessionKey: pairKey,
        srcIp: event.srcIp < event.dstIp ? event.srcIp : event.dstIp,
        dstIp: event.srcIp < event.dstIp ? event.dstIp : event.srcIp,
        events: [],
        currentState: 'Idle',
      })
    }

    const track = tracks.get(pairKey)!
    track.events.push(event)

    // Always update to the latest state (events are sorted by time)
    // This correctly handles DOWN → re-OPEN → Established sequences
    track.currentState = event.state

    // Track timestamps for display
    if (event.state === 'Established') {
      track.establishedAt = event.timestamp
    } else if (event.state === 'Down') {
      track.downAt = event.timestamp
    }
  }

  return tracks
}

/**
 * Get time range from events
 */
export function getTimeRange(events: SessionEvent[]): { start: Date; end: Date } | null {
  if (events.length === 0) return null

  const timestamps = events.map(e => e.timestamp.getTime())
  return {
    start: new Date(Math.min(...timestamps)),
    end: new Date(Math.max(...timestamps)),
  }
}
