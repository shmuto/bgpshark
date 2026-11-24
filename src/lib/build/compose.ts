/**
 * The pieces one-off captures keep rewriting.
 *
 * A `Scenario` describes one session between two peers, and that covers most
 * captures. The rest are a scenario plus one more move: two sessions in the
 * same file, because that is what a capture on a router with two upstreams
 * looks like; or a session with one direction deleted, because that is what a
 * one-legged mirror or a one-way fault leaves behind. Both used to be written
 * by hand each time — the second by reading the source address out of the
 * frame at a fixed byte offset, which is right only for untagged IPv4 over
 * Ethernet and silently wrong for anything else.
 */
import { writePcap } from '../pcap/writer'
import type { BuiltCapture, ScenarioStep, Side } from './scenario'

/**
 * The steps every healthy session starts with: the TCP handshake, an OPEN from
 * each side, and the KEEPALIVE from each side that confirms them.
 *
 * A function rather than a constant so that callers spreading it into a step
 * list several times — a session that drops and comes back — each get their
 * own objects.
 */
export function establish(): ScenarioStep[] {
  return [
    { kind: 'handshake' },
    { kind: 'open', from: 'a' },
    { kind: 'open', from: 'b' },
    { kind: 'keepalive', from: 'a' },
    { kind: 'keepalive', from: 'b' },
  ]
}

/**
 * Several captures as one file, frames in time order.
 *
 * Each input keeps its own addresses and ports, so the result reads as several
 * sessions rather than one — give the scenarios different `startTime`s, or
 * their frames interleave from the same instant. The sort is stable, so frames
 * sharing a timestamp keep the order their own capture put them in.
 */
export function mergeCaptures(captures: BuiltCapture[]): BuiltCapture {
  if (captures.length === 0) throw new Error('mergeCaptures needs at least one capture')

  const linkType = captures[0].linkType
  const mismatched = captures.find((capture) => capture.linkType !== linkType)
  if (mismatched) {
    // A classic pcap has one link type for the whole file, so a frame built for
    // another would decode as nonsense rather than fail.
    throw new Error(
      `Cannot merge captures with different link types (${linkType} and ${mismatched.linkType})`
    )
  }

  const entries = captures.flatMap((capture) =>
    capture.frames.map((frame, i) => ({ frame, sender: capture.senders[i] }))
  )
  entries.sort((x, y) => x.frame.timestamp.getTime() - y.frame.timestamp.getTime())

  const frames = entries.map((entry) => entry.frame)
  return {
    bytes: writePcap(frames, linkType),
    frames,
    senders: entries.map((entry) => entry.sender),
    linkType,
    warnings: captures.flatMap((capture) => capture.warnings),
  }
}

/**
 * The same capture with only the frames `side` sent — what a SPAN session that
 * caught one leg, or a peer whose packets never arrive, leaves in the file.
 */
export function keepSide(capture: BuiltCapture, side: Side): BuiltCapture {
  const kept = capture.frames.flatMap((frame, i) => (capture.senders[i] === side ? [frame] : []))
  return {
    ...capture,
    bytes: writePcap(kept, capture.linkType),
    frames: kept,
    senders: kept.map(() => side),
  }
}
