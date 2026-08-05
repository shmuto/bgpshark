import { describe, expect, test } from 'bun:test'
import { BgpSessionTracker, afiSafiKey, endpointKey } from '../../../src/lib/bgp/session'
import { parseOpenMessage } from '../../../src/lib/bgp/open'
import { BinaryReader } from '../../../src/lib/pcap/reader'

const IPV4_UNICAST = afiSafiKey(1, 1)
const A = endpointKey('10.0.0.1', 40000)
const B = endpointKey('10.0.0.2', 179)

/** An OPEN body advertising the given capabilities, as parsed from the wire. */
function open(options: { fourByteAs?: number; addPath?: 'receive' | 'send' | 'both' }) {
  const caps: number[] = []
  if (options.fourByteAs !== undefined) {
    const as = options.fourByteAs
    caps.push(2, 6, 65, 4, (as >>> 24) & 0xff, (as >>> 16) & 0xff, (as >>> 8) & 0xff, as & 0xff)
  }
  if (options.addPath) {
    const sendReceive = { receive: 1, send: 2, both: 3 }[options.addPath]
    caps.push(2, 6, 69, 4, 0, 1, 1, sendReceive)
  }
  const body = [4, 0xfd, 0xe9, 0, 90, 10, 0, 0, 1, caps.length, ...caps]
  return parseOpenMessage(new BinaryReader(new Uint8Array(body), false))
}

describe('negotiating the 4-byte AS capability', () => {
  test('applies when both ends advertise it', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ fourByteAs: 65001 }))
    t.observeOpen(B, open({ fourByteAs: 65002 }))
    expect(t.decodingFor(A, B).fourByteAs).toBe(true)
  })

  test('does not apply when only one end does', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ fourByteAs: 65001 }))
    t.observeOpen(B, open({}))
    expect(t.decodingFor(A, B).fourByteAs).toBe(false)
  })

  test('is unknown until both OPENs have been seen', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ fourByteAs: 65001 }))
    // Half an exchange says nothing about what was agreed.
    expect(t.decodingFor(A, B).fourByteAs).toBeNull()
  })
})

describe('negotiating ADD-PATH', () => {
  test('the sender sends Path IDs when it offered to send and the peer to receive', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'send' }))
    t.observeOpen(B, open({ addPath: 'receive' }))
    expect(t.decodingFor(A, B).addPath.has(IPV4_UNICAST)).toBe(true)
  })

  test('has a direction: the same session is not add-path the other way', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'send' }))
    t.observeOpen(B, open({ addPath: 'receive' }))
    expect(t.decodingFor(B, A).addPath.has(IPV4_UNICAST)).toBe(false)
  })

  test('both ends saying "both" makes it add-path in both directions', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'both' }))
    t.observeOpen(B, open({ addPath: 'both' }))
    expect(t.decodingFor(A, B).addPath.has(IPV4_UNICAST)).toBe(true)
    expect(t.decodingFor(B, A).addPath.has(IPV4_UNICAST)).toBe(true)
  })

  test('a sender willing to send but a peer that cannot receive means no Path IDs', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'send' }))
    t.observeOpen(B, open({ addPath: 'send' }))
    expect(t.decodingFor(A, B).addPath.has(IPV4_UNICAST)).toBe(false)
  })

  test('only the address families both ends named are affected', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'both' }))
    t.observeOpen(B, open({ addPath: 'both' }))
    // The capability above names IPv4 unicast only.
    expect(t.decodingFor(A, B).addPath.has(afiSafiKey(2, 1))).toBe(false)
  })

  test('an unobserved session claims nothing', () => {
    const t = new BgpSessionTracker()
    expect(t.decodingFor(A, B).addPath.size).toBe(0)
  })
})
