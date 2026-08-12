import { describe, test, expect } from 'bun:test'
import { holdTimerContext } from '../../../src/lib/bgp/hold-timer'
import type { BgpMessage, BgpPacket } from '../../../src/lib/bgp/types'

/**
 * The silence a Hold Timer Expired NOTIFICATION is complaining about.
 *
 * The measurement people reach for is the gap to the previous packet, and that
 * is the wrong one — on a healthy session both ends are sending, so the
 * previous packet is usually the *sender's* own KEEPALIVE. The hold timer
 * counts time since something was heard from the peer, and the two answers
 * differ by exactly the keepalive offset between the two ends.
 */
function at(second: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + second * 1000)
}

function packet(
  srcIp: string,
  dstIp: string,
  second: number,
  messages: BgpMessage[]
): BgpPacket {
  return {
    frameIndex: second,
    timestamp: at(second),
    srcIp,
    dstIp,
    srcPort: srcIp === '10.0.0.2' ? 179 : 51000,
    dstPort: srcIp === '10.0.0.2' ? 51000 : 179,
    messages,
    rawData: new Uint8Array(),
    parseWarnings: [],
  } as unknown as BgpPacket
}

const keepalive: BgpMessage = { type: 'KEEPALIVE' } as BgpMessage
const holdExpired: BgpMessage = {
  type: 'NOTIFICATION',
  errorCode: 4,
  errorSubcode: 0,
  errorCodeName: 'Hold Timer Expired',
  errorSubcodeName: 'Unspecific',
  data: new Uint8Array(),
  hint: '',
} as BgpMessage

function open(holdTime: number): BgpMessage {
  return {
    type: 'OPEN',
    version: 4,
    myAs: 65001,
    holdTime,
    bgpIdentifier: '1.1.1.1',
    optionalParameters: [],
    capabilities: [],
  } as unknown as BgpMessage
}

/** A → B is the peer's direction; B is the one that gives up. */
const A = '10.0.0.1'
const B = '10.0.0.2'

describe('the silence before a hold timer teardown', () => {
  test('measures from the peer, not from the previous packet', () => {
    const packets = [
      packet(A, B, 0, [open(90)]),
      packet(B, A, 0, [open(90)]),
      // A speaks, then B answers 1s later. The naive "gap to the previous
      // packet" would report 90s here; the hold timer counts 91s, because it
      // is A that went quiet.
      packet(A, B, 10, [keepalive]),
      packet(B, A, 11, [keepalive]),
      packet(B, A, 101, [holdExpired]),
    ]

    const context = holdTimerContext(packets, 4)

    expect(context?.peer).toBe(A)
    expect(context?.lastHeard?.silenceSeconds).toBe(91)
    expect(context?.lastHeard?.type).toBe('KEEPALIVE')
  })

  test('the negotiated hold time is the lower of the two OPENs', () => {
    const packets = [
      packet(A, B, 0, [open(90)]),
      packet(B, A, 0, [open(30)]),
      packet(A, B, 10, [keepalive]),
      packet(B, A, 41, [holdExpired]),
    ]

    expect(holdTimerContext(packets, 3)?.negotiatedHoldTime).toBe(30)
  })

  test('a silence that ran the hold time is marked as having done so', () => {
    const packets = [
      packet(A, B, 0, [open(90)]),
      packet(B, A, 0, [open(90)]),
      packet(A, B, 10, [keepalive]),
      packet(B, A, 101, [holdExpired]),
    ]

    expect(holdTimerContext(packets, 3)?.silenceReachedHoldTime).toBe(true)
  })

  test('a timer that fired early is marked as having fired early', () => {
    // 40s of silence against a 90s hold time. Either packets are missing from
    // the capture or the timer in force was not the one on record — both worth
    // knowing, and neither visible if this were rounded to "timed out".
    const packets = [
      packet(A, B, 0, [open(90)]),
      packet(B, A, 0, [open(90)]),
      packet(A, B, 10, [keepalive]),
      packet(B, A, 50, [holdExpired]),
    ]

    const context = holdTimerContext(packets, 3)
    expect(context?.lastHeard?.silenceSeconds).toBe(40)
    expect(context?.silenceReachedHoldTime).toBe(false)
  })

  test('without both OPENs the silence stands alone', () => {
    // A capture started mid-session, which is the common case.
    const packets = [packet(A, B, 10, [keepalive]), packet(B, A, 101, [holdExpired])]

    const context = holdTimerContext(packets, 1)
    expect(context?.lastHeard?.silenceSeconds).toBe(91)
    expect(context?.negotiatedHoldTime).toBeUndefined()
    expect(context?.silenceReachedHoldTime).toBeUndefined()
  })

  test('nothing from the peer at all is reported as nothing, not as zero', () => {
    const packets = [packet(B, A, 10, [keepalive]), packet(B, A, 101, [holdExpired])]

    const context = holdTimerContext(packets, 1)
    expect(context).not.toBeNull()
    expect(context?.lastHeard).toBeUndefined()
  })

  test('OPENs from a later session do not describe this one', () => {
    // A flapping capture: this teardown ran under the first pair of OPENs, and
    // the reconnect that follows renegotiated a different hold time. Reading
    // the whole capture rather than what preceded the teardown would report
    // the wrong timer.
    const packets = [
      packet(A, B, 0, [open(90)]),
      packet(B, A, 0, [open(90)]),
      packet(A, B, 10, [keepalive]),
      packet(B, A, 101, [holdExpired]),
      packet(A, B, 200, [open(30)]),
      packet(B, A, 200, [open(30)]),
    ]

    expect(holdTimerContext(packets, 3)?.negotiatedHoldTime).toBe(90)
  })

  test('another session between other addresses is not consulted', () => {
    const packets = [
      packet('192.0.2.1', '192.0.2.2', 0, [open(30)]),
      packet('192.0.2.1', '192.0.2.2', 95, [keepalive]),
      packet(A, B, 0, [open(90)]),
      packet(B, A, 0, [open(90)]),
      packet(A, B, 10, [keepalive]),
      packet(B, A, 101, [holdExpired]),
    ]

    const context = holdTimerContext(packets, 5)
    expect(context?.negotiatedHoldTime).toBe(90)
    expect(context?.lastHeard?.silenceSeconds).toBe(91)
  })

  test('any other NOTIFICATION has nothing to say here', () => {
    const cease = { ...holdExpired, errorCode: 6, errorCodeName: 'Cease' } as BgpMessage
    const packets = [packet(A, B, 10, [keepalive]), packet(B, A, 101, [cease])]

    expect(holdTimerContext(packets, 1)).toBeNull()
  })

  test('a packet that is not a NOTIFICATION has nothing to say either', () => {
    expect(holdTimerContext([packet(A, B, 10, [keepalive])], 0)).toBeNull()
  })
})
