/**
 * How long the peer had been quiet when its hold timer expired.
 *
 * `Hold Timer Expired` says a speaker stopped hearing from the other end, and
 * the number that decides what to do about it is the one the message does not
 * carry: how long the silence actually was, against the hold time the two ends
 * negotiated. A silence that ran the full hold time means the peer's packets
 * stopped arriving, which is a reachability problem below BGP — the session
 * did exactly what it is specified to do. A silence shorter than the hold time
 * means something else, and is worth noticing rather than glossing.
 *
 * Both numbers are in the capture already: the timestamps of what arrived, and
 * the Hold Time field of the two OPENs. Nothing here reads anything the packet
 * list does not already show; it just does the subtraction that was being left
 * to the reader.
 */
import type { BgpOpenMessage, BgpPacket } from './types'

export interface HoldTimerContext {
  /** The end that went quiet — the one the NOTIFICATION was sent to. */
  peer: string
  /**
   * The last thing heard from the peer before the teardown. Absent when the
   * capture holds nothing from that end at all, which is its own finding.
   */
  lastHeard?: {
    type: string
    timestamp: Date
    /** Seconds between that message and the NOTIFICATION. */
    silenceSeconds: number
  }
  /**
   * The hold time in force: the lower of the two OPENs, as RFC 4271 §4.2
   * requires. Absent when the capture did not catch both OPENs, which is
   * common on a capture started after the session came up.
   */
  negotiatedHoldTime?: number
  /**
   * True when the peer really was quiet for at least the negotiated hold time.
   * False means the timer fired early, which points at the capture missing
   * packets or at a hold time that changed since the OPENs on record.
   * Undefined when either number is unavailable.
   */
  silenceReachedHoldTime?: boolean
}

/**
 * Build the context for the NOTIFICATION at `index`, or null when there is
 * nothing to say — the packet is not a Hold Timer Expired, or nothing in the
 * capture bears on it.
 */
export function holdTimerContext(
  packets: BgpPacket[],
  index: number
): HoldTimerContext | null {
  const packet = packets[index]
  if (!packet) return null

  const expired = packet.messages.some(
    (message) => message.type === 'NOTIFICATION' && message.errorCode === 4
  )
  if (!expired) return null

  // The NOTIFICATION goes *to* the end that went quiet.
  const peer = packet.dstIp
  const local = packet.srcIp

  return {
    peer,
    lastHeard: findLastHeard(packets, index, peer, local),
    ...negotiated(packets, index, peer, local),
  }
}

/** The most recent message from the peer before this packet. */
function findLastHeard(
  packets: BgpPacket[],
  index: number,
  peer: string,
  local: string
): HoldTimerContext['lastHeard'] {
  const notificationTime = packets[index].timestamp.getTime()

  for (let i = index - 1; i >= 0; i--) {
    const candidate = packets[i]
    if (candidate.srcIp !== peer || candidate.dstIp !== local) continue

    const message = candidate.messages[candidate.messages.length - 1]
    if (!message) continue

    return {
      type: message.type,
      timestamp: candidate.timestamp,
      silenceSeconds: (notificationTime - candidate.timestamp.getTime()) / 1000,
    }
  }

  return undefined
}

/**
 * The negotiated hold time, from the last OPEN each end sent before this
 * teardown.
 *
 * Looking backwards rather than at the whole capture matters on a capture of a
 * flapping session: a later session's OPENs say nothing about the timer that
 * was running during this one.
 */
function negotiated(
  packets: BgpPacket[],
  index: number,
  peer: string,
  local: string
): Pick<HoldTimerContext, 'negotiatedHoldTime' | 'silenceReachedHoldTime'> {
  let peerHold: number | undefined
  let localHold: number | undefined

  for (let i = index - 1; i >= 0 && (peerHold === undefined || localHold === undefined); i--) {
    const candidate = packets[i]
    const involved =
      (candidate.srcIp === peer && candidate.dstIp === local) ||
      (candidate.srcIp === local && candidate.dstIp === peer)
    if (!involved) continue

    for (const message of candidate.messages) {
      if (message.type !== 'OPEN') continue
      const holdTime = (message as BgpOpenMessage).holdTime
      if (candidate.srcIp === peer) peerHold ??= holdTime
      else localHold ??= holdTime
    }
  }

  if (peerHold === undefined || localHold === undefined) return {}

  // RFC 4271 §4.2: the smaller of the two values is what runs.
  const negotiatedHoldTime = Math.min(peerHold, localHold)
  const silence = findLastHeard(packets, index, peer, local)?.silenceSeconds

  return {
    negotiatedHoldTime,
    silenceReachedHoldTime: silence === undefined ? undefined : silence >= negotiatedHoldTime,
  }
}

/**
 * Where a KEEPALIVE sits against the hold timer it is feeding.
 *
 * The receiving end resets its hold timer on every message from the sender, so
 * the number an operator wants on a KEEPALIVE is the gap since the sender's
 * previous message in the same direction, measured against the negotiated hold
 * time. A KEEPALIVE every 30s of a 90s hold time is the RFC 4271 §10 default
 * (one third); one arriving at 80s is a session about to drop.
 */
export interface KeepaliveContext {
  sender: string
  receiver: string
  /** The sender's previous message to the receiver. Absent at the start of the capture. */
  previous?: {
    type: string
    timestamp: Date
    gapSeconds: number
  }
  /** Lower of the two most recent OPENs, when the capture has both. */
  negotiatedHoldTime?: number
  /** gapSeconds / negotiatedHoldTime, when both exist and the hold time is not 0. */
  holdTimeFraction?: number
}

export function keepaliveContext(packets: BgpPacket[], index: number): KeepaliveContext | null {
  const packet = packets[index]
  if (!packet || !packet.messages.some((message) => message.type === 'KEEPALIVE')) return null

  const sender = packet.srcIp
  const receiver = packet.dstIp
  const heard = findLastHeard(packets, index, sender, receiver)
  const { negotiatedHoldTime } = negotiated(packets, index, sender, receiver)

  const previous = heard && {
    type: heard.type,
    timestamp: heard.timestamp,
    gapSeconds: heard.silenceSeconds,
  }
  const holdTimeFraction =
    previous && negotiatedHoldTime ? previous.gapSeconds / negotiatedHoldTime : undefined

  return { sender, receiver, previous, negotiatedHoldTime, holdTimeFraction }
}
