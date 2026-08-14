import { describe, expect, test } from 'bun:test'
import {
  BgpSessionTracker,
  addPathDirections,
  afiSafiKey,
  endpointKey,
} from '../../../src/lib/bgp/session'
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
  /** The negotiated set, asserting it was decided at all. */
  function negotiated(t: BgpSessionTracker, from: string, to: string): ReadonlySet<string> {
    const { addPath } = t.decodingFor(from, to)
    expect(addPath).not.toBeNull()
    return addPath!
  }

  test('the sender sends Path IDs when it offered to send and the peer to receive', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'send' }))
    t.observeOpen(B, open({ addPath: 'receive' }))
    expect(negotiated(t, A, B).has(IPV4_UNICAST)).toBe(true)
  })

  test('has a direction: the same session is not add-path the other way', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'send' }))
    t.observeOpen(B, open({ addPath: 'receive' }))
    expect(negotiated(t, B, A).has(IPV4_UNICAST)).toBe(false)
  })

  test('both ends saying "both" makes it add-path in both directions', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'both' }))
    t.observeOpen(B, open({ addPath: 'both' }))
    expect(negotiated(t, A, B).has(IPV4_UNICAST)).toBe(true)
    expect(negotiated(t, B, A).has(IPV4_UNICAST)).toBe(true)
  })

  test('a sender willing to send but a peer that cannot receive means no Path IDs', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'send' }))
    t.observeOpen(B, open({ addPath: 'send' }))
    expect(negotiated(t, A, B).has(IPV4_UNICAST)).toBe(false)
  })

  test('only the address families both ends named are affected', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'both' }))
    t.observeOpen(B, open({ addPath: 'both' }))
    // The capability above names IPv4 unicast only.
    expect(negotiated(t, A, B).has(afiSafiKey(2, 1))).toBe(false)
  })

  test('a session where neither end offered ADD-PATH decided that it has none', () => {
    // An empty set, not null: both OPENs were seen and the answer is "no".
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ fourByteAs: 65001 }))
    t.observeOpen(B, open({ fourByteAs: 65002 }))
    expect(negotiated(t, A, B).size).toBe(0)
  })

  test('an unobserved session does not claim there is no ADD-PATH', () => {
    // Null rather than an empty set. The difference is the whole point: an
    // empty set says the OPENs ruled it out, and null says nobody asked them.
    // Reading NLRI as plain because of the second is how a capture that began
    // mid-session shows prefixes nobody announced.
    const t = new BgpSessionTracker()
    expect(t.decodingFor(A, B).addPath).toBeNull()
  })

  test('half an exchange is not an answer either', () => {
    const t = new BgpSessionTracker()
    t.observeOpen(A, open({ addPath: 'both' }))
    expect(t.decodingFor(A, B).addPath).toBeNull()
  })
})

describe('reporting what ADD-PATH came to', () => {
  // What `decodingFor` reduces to a yes/no, spelled out per direction, because
  // a capability diff that only compares advertisements calls the interesting
  // failures a match.

  test('both ends configured to send is not a working session', () => {
    // Two ticks in the capability table, both saying "ADD-PATH: send", and not
    // one Path Identifier on the wire in either direction. This is the row the
    // section exists for.
    const [out] = addPathDirections(open({ addPath: 'send' }), open({ addPath: 'send' }))
    expect(out.negotiated).toBe(false)
    expect(out.senderSends).toBe(true)
    expect(out.receiverReceives).toBe(false)
  })

  test('send meeting receive is the working case, one way', () => {
    const sender = open({ addPath: 'send' })
    const receiver = open({ addPath: 'receive' })

    expect(addPathDirections(sender, receiver)[0].negotiated).toBe(true)
    // And nothing comes back the other way, which is the point of asking per
    // direction rather than per session.
    expect(addPathDirections(receiver, sender)[0].negotiated).toBe(false)
  })

  test('a family only one side named is reported rather than dropped', () => {
    // Leaving it out would hide the mismatch, which is the one thing the
    // section must not do.
    const directions = addPathDirections(open({ addPath: 'both' }), open({ fourByteAs: 65002 }))

    expect(directions).toHaveLength(1)
    expect(directions[0]).toMatchObject({ afi: 1, safi: 1, negotiated: false, receiverReceives: false })
  })

  test('a session where neither side asked has nothing to report', () => {
    expect(addPathDirections(open({ fourByteAs: 65001 }), open({ fourByteAs: 65002 }))).toEqual([])
  })

  test('it agrees with how the UPDATEs are actually parsed', () => {
    // The two must not drift: the screen says what was agreed and the parser
    // acts on it, and a session where they disagree shows prefixes that
    // contradict the panel above them.
    const sender = open({ addPath: 'send' })
    const receiver = open({ addPath: 'receive' })
    const t = new BgpSessionTracker()
    t.observeOpen(A, sender)
    t.observeOpen(B, receiver)

    for (const [from, to, a, b] of [
      [A, B, sender, receiver],
      [B, A, receiver, sender],
    ] as const) {
      const reported = addPathDirections(a, b).filter((f) => f.negotiated)
      const parsed = t.decodingFor(from, to).addPath!
      expect(reported.map((f) => afiSafiKey(f.afi, f.safi))).toEqual([...parsed])
    }
  })
})
