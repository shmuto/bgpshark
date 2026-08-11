/**
 * The troubleshooting scenarios, as captures.
 *
 * Each entry here is one fault an operator arrives with — "the session will not
 * come up", "the routes are there but the wrong path wins", "it dropped and
 * nothing said why" — compiled into a pcap that shows exactly that fault and
 * nothing else. They exist so the analysis screens can be pointed at a known
 * answer: when a scenario says the hold timer expired 90 seconds after the last
 * KEEPALIVE, that is a fact you can check the dashboard against.
 *
 * `docs/troubleshooting-scenarios.md` is the other half of this file: what each
 * scenario is, what you would want to learn from its capture, and what BGPShark
 * currently says about it.
 *
 * These are deliberately *not* presets. A preset is a starting point you edit
 * to match the session in front of you, and the Build screen keeps a short
 * curated list of them; these are fixed reproductions meant to be read, and
 * several of them — a capture merged from two sessions, a capture with one
 * direction deleted — are not describable as a single two-peer scenario at all.
 *
 * They are all shaped like a capture taken on **one router**, because that is
 * the capture people can actually get. That does not mean one direction: your
 * own interface sees what you sent and what arrived. It means a fault at the
 * far end appears only as something missing — see S12 and S14.
 *
 *   bun run testlab/scenarios.ts          # write all of them
 *   bun run testlab/scenarios.ts s3 s11   # write only these
 *
 * Output lands in `testlab/scenarios/`, which is gitignored: the generator is
 * the artifact worth keeping, and a pcap whose contents are only legible by
 * opening it is not.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  announce,
  buildScenario,
  presetById,
  withdraw,
  END_OF_RIB,
  type BgpMessageSpec,
  type CapabilitySpec,
  type Scenario,
} from '../src/lib/build'
import { Afi, Safi } from '../src/lib/bgp/constants'
import { writePcap, type ExportableFrame } from '../src/lib/pcap/writer'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scenarios')

/** The two ends of most of these, so a scenario only states its own quirk. */
const A = { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1', holdTime: 90 }
const B = { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2', holdTime: 90 }

/** The steps every healthy session starts with. */
function establish(): Scenario['steps'] {
  return [
    { kind: 'handshake' },
    { kind: 'open', from: 'a' },
    { kind: 'open', from: 'b' },
    { kind: 'keepalive', from: 'a' },
    { kind: 'keepalive', from: 'b' },
  ]
}

interface BuiltCase {
  bytes: Uint8Array
  frameCount: number
}

interface ScenarioCase {
  id: string
  /** The complaint this capture reproduces, in the words it arrives in. */
  title: string
  /** What the capture is supposed to prove, so a wrong answer is recognisable. */
  expect: string
  /** Async because one case borrows a fixture that has to be imported. */
  build: () => BuiltCase | Promise<BuiltCase>
}

/** A case built from one `Scenario`, which is most of them. */
function fromScenario(
  id: string,
  title: string,
  expect: string,
  scenario: () => Scenario
): ScenarioCase {
  return {
    id,
    title,
    expect,
    build: () => {
      const built = buildScenario(scenario())
      return { bytes: built.bytes, frameCount: built.frames.length }
    },
  }
}

// ---------------------------------------------------------------------------
// S1 — the session never comes up, and never reaches BGP to say why.
// ---------------------------------------------------------------------------

const s1 = fromScenario(
  's1-tcp-refused',
  'The neighbor stays Idle/Connect and no BGP is ever exchanged',
  'SYN answered by RST, three times. Diagnosable only at the TCP layer.',
  // The shipped preset already is this capture; naming it here keeps the
  // scenario list complete rather than sending the reader off to find it.
  () => presetById('connection-refused')!.build()
)

// ---------------------------------------------------------------------------
// S2 — the session is up, but one address family's routes never arrive.
// ---------------------------------------------------------------------------

const s2 = fromScenario(
  's2-capability-mismatch',
  'The session is Established but no IPv6 routes are received',
  'A advertises IPv6 unicast, GR and ADD-PATH; B advertises none of them.',
  () => ({
    name: 'Capability mismatch',
    a: {
      ...A,
      capabilities: [
        { type: 'MULTIPROTOCOL', afi: Afi.IPV4, safi: Safi.UNICAST },
        { type: 'MULTIPROTOCOL', afi: Afi.IPV6, safi: Safi.UNICAST },
        { type: 'ROUTE_REFRESH' },
        { type: 'FOUR_OCTET_AS', asNumber: A.as },
        {
          type: 'GRACEFUL_RESTART',
          restartTime: 120,
          addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST }],
        },
        {
          type: 'ADD_PATH',
          addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST, sendReceive: 'both' }],
        },
      ],
    },
    // Only what a much older configuration would send. The v6 routes have
    // nowhere to go, and nothing in the session ever says so out loud.
    b: {
      ...B,
      capabilities: [
        { type: 'MULTIPROTOCOL', afi: Afi.IPV4, safi: Safi.UNICAST },
        { type: 'ROUTE_REFRESH' },
        { type: 'FOUR_OCTET_AS', asNumber: B.as },
      ],
    },
    gap: 200,
    steps: [
      ...establish(),
      {
        kind: 'send',
        from: 'a',
        messages: [announce(['10.1.0.0/24'], { nextHop: A.ip, asPath: [A.as] }), END_OF_RIB],
      },
      {
        kind: 'send',
        from: 'b',
        messages: [announce(['10.2.0.0/24'], { nextHop: B.ip, asPath: [B.as] }), END_OF_RIB],
      },
      { kind: 'delay', gap: 30_000 },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
    ],
  })
)

// ---------------------------------------------------------------------------
// S3 — the session comes up and falls over, repeatedly.
// ---------------------------------------------------------------------------

const s3 = fromScenario(
  's3-holdtimer-flap',
  'The session flaps every few minutes',
  'Three cycles. Keepalives every 30s, then A goes quiet and B tears it down ' +
    'exactly 90s later — the negotiated hold time, which is what makes this a ' +
    'one-way reachability fault rather than a BGP one.',
  () => {
    const cycle = (): Scenario['steps'] => [
      ...establish(),
      {
        kind: 'send',
        from: 'a',
        messages: [
          announce(['10.1.0.0/24', '10.1.1.0/24'], { nextHop: A.ip, asPath: [A.as] }),
          END_OF_RIB,
        ],
      },
      { kind: 'delay', gap: 30_000 },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      { kind: 'delay', gap: 30_000 },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      // A's keepalives stop arriving. B waits out the hold time to the second.
      { kind: 'delay', gap: 90_000 },
      { kind: 'send', from: 'b', messages: [{ type: 'NOTIFICATION', errorCode: 4, errorSubcode: 0 }] },
      { kind: 'reset', from: 'b', gap: 50 },
      { kind: 'delay', gap: 60_000 },
    ]

    return {
      name: 'Hold timer flap',
      a: A,
      b: B,
      gap: 200,
      steps: [...cycle(), ...cycle(), ...cycle()],
    }
  }
)

// ---------------------------------------------------------------------------
// S4 — the same prefix from two peers, and the wrong one wins.
// ---------------------------------------------------------------------------

/**
 * Two sessions into one local router, merged into a single capture.
 *
 * This is the shape a best-path question actually arrives in — two upstreams,
 * one prefix, and a decision to explain — and it is a shape `buildScenario`
 * cannot express, since a scenario is two peers. Merging the frames of two
 * builds is the honest way to get there: each session's TCP state stays
 * internally consistent, and interleaving by timestamp is what a capture on
 * the receiving router would have recorded.
 */
const s4: ScenarioCase = {
  id: 's4-bestpath',
  title: 'Traffic for one prefix leaves by the wrong upstream',
  expect:
    'One prefix from two peers. The short AS_PATH carries MED 300 and no ' +
    'LOCAL_PREF; the long one carries MED 10 and LOCAL_PREF 200 — so the ' +
    'longer path wins, and only the attributes say why.',
  build: () => {
    const PREFIX = '172.20.0.0/16'
    const LOCAL_ROUTER = { as: 65000, routerId: '100.100.100.100', holdTime: 90 }

    const viaShortPath = buildScenario({
      a: { ip: '192.0.2.1', as: 65010, routerId: '10.10.10.10', holdTime: 90 },
      b: { ...LOCAL_ROUTER, ip: '192.0.2.100' },
      gap: 200,
      startTime: new Date('2026-01-01T00:00:00Z'),
      steps: [
        ...establish(),
        {
          kind: 'send',
          from: 'a',
          messages: [
            {
              type: 'UPDATE',
              pathAttributes: [
                { type: 'ORIGIN', value: 'IGP' },
                { type: 'AS_PATH', segments: [{ type: 'AS_SEQUENCE', asNumbers: [65010, 65200] }] },
                { type: 'NEXT_HOP', address: '192.0.2.1' },
                { type: 'MULTI_EXIT_DISC', value: 300 },
                { type: 'COMMUNITIES', communities: ['65000:80'] },
              ],
              nlri: [PREFIX],
            },
            END_OF_RIB,
          ],
        },
      ],
    })

    const viaLongPath = buildScenario({
      a: { ip: '198.51.100.1', as: 65020, routerId: '20.20.20.20', holdTime: 90 },
      b: { ...LOCAL_ROUTER, ip: '198.51.100.100' },
      gap: 200,
      startTime: new Date('2026-01-01T00:00:05Z'),
      steps: [
        ...establish(),
        {
          kind: 'send',
          from: 'a',
          messages: [
            {
              type: 'UPDATE',
              pathAttributes: [
                { type: 'ORIGIN', value: 'IGP' },
                {
                  type: 'AS_PATH',
                  segments: [{ type: 'AS_SEQUENCE', asNumbers: [65020, 65300, 65200] }],
                },
                { type: 'NEXT_HOP', address: '198.51.100.1' },
                { type: 'MULTI_EXIT_DISC', value: 10 },
                { type: 'LOCAL_PREF', value: 200 },
                { type: 'COMMUNITIES', communities: ['65000:200'] },
              ],
              nlri: [PREFIX],
            },
            END_OF_RIB,
          ],
        },
      ],
    })

    const merged = [...viaShortPath.frames, ...viaLongPath.frames].sort(
      (x, y) => x.timestamp.getTime() - y.timestamp.getTime()
    )
    return { bytes: writePcap(merged, viaShortPath.linkType), frameCount: merged.length }
  },
}

// ---------------------------------------------------------------------------
// S5 — a customer announcing far more than it should.
// ---------------------------------------------------------------------------

const s5 = fromScenario(
  's5-route-leak',
  'A customer session is carrying routes it has no business announcing',
  'One legitimate aggregate, two transit paths re-announced through the ' +
    'customer AS, and a more-specific with a different origin. Every session ' +
    'stays healthy throughout — the fault is entirely in the AS_PATHs.',
  () => ({
    name: 'Route leak',
    a: { ip: '203.0.113.1', as: 65100, routerId: '11.11.11.11', holdTime: 90 },
    b: { ip: '203.0.113.2', as: 65000, routerId: '100.100.100.100', holdTime: 90 },
    gap: 200,
    steps: [
      ...establish(),
      {
        kind: 'send',
        from: 'a',
        messages: [
          // What the customer is supposed to send.
          announce(['198.18.0.0/16'], { nextHop: '203.0.113.1', asPath: [65100] }),
          // What it is actually sending: paths learned from two other transits.
          announce(['8.8.8.0/24'], { nextHop: '203.0.113.1', asPath: [65100, 65001, 15169] }),
          announce(['1.1.1.0/24'], { nextHop: '203.0.113.1', asPath: [65100, 65002, 13335] }),
          // And a more-specific of its own aggregate, from a different origin.
          announce(['198.18.7.0/24'], { nextHop: '203.0.113.1', asPath: [65100, 64999] }),
          END_OF_RIB,
        ],
      },
    ],
  })
)

// ---------------------------------------------------------------------------
// S6 — an UPDATE the far end refuses.
// ---------------------------------------------------------------------------

/**
 * The attribute B will not accept, written once.
 *
 * Flags 0x40 is transitive with the optional bit clear, which is what makes an
 * unknown type code an error rather than something to pass along. Type code
 * 199 is 0xc7, the length is 4, and the value is arbitrary.
 *
 * The same bytes go into the UPDATE and into the NOTIFICATION's data field,
 * because that is what RFC 4271 §6.3 says the data field contains: the
 * attribute that caused the error. A capture where the two disagreed would be
 * one no speaker could have produced, and a decoder tested against it would be
 * tested against a lie.
 */
const OFFENDING_ATTRIBUTE = new Uint8Array([0x40, 0xc7, 0x04, 0xde, 0xad, 0xbe, 0xef])

const s6 = fromScenario(
  's6-malformed-update',
  'The session drops the moment routes are advertised',
  'An attribute with type code 199 and the optional bit clear — a well-known ' +
    'attribute nobody recognises — answered with NOTIFICATION 3/2 whose data ' +
    'field carries that very attribute back.',
  () => ({
    name: 'Malformed UPDATE',
    a: A,
    b: B,
    gap: 200,
    steps: [
      ...establish(),
      {
        kind: 'send',
        from: 'a',
        messages: [
          {
            type: 'UPDATE',
            pathAttributes: [
              { type: 'ORIGIN', value: 'IGP' },
              { type: 'AS_PATH', segments: [{ type: 'AS_SEQUENCE', asNumbers: [A.as] }] },
              { type: 'NEXT_HOP', address: A.ip },
              {
                type: 'RAW',
                flags: OFFENDING_ATTRIBUTE[0],
                typeCode: OFFENDING_ATTRIBUTE[1],
                value: OFFENDING_ATTRIBUTE.slice(3),
              },
            ],
            nlri: ['10.5.0.0/24'],
          } satisfies BgpMessageSpec,
        ],
      },
      {
        kind: 'send',
        from: 'b',
        messages: [
          { type: 'NOTIFICATION', errorCode: 3, errorSubcode: 2, data: OFFENDING_ATTRIBUTE },
        ],
      },
      { kind: 'close', from: 'b', gap: 50 },
    ],
  })
)

// ---------------------------------------------------------------------------
// S7 — a full table arriving through a small MTU.
// ---------------------------------------------------------------------------

const s7 = fromScenario(
  's7-segmented',
  'Only some of the advertised routes seem to arrive',
  '400 prefixes at a 576-byte MTU, so BGP messages span TCP segments and only ' +
    'reassembly recovers them all.',
  () => presetById('segmented')!.build()
)

// ---------------------------------------------------------------------------
// S8 — a restart that was supposed to be graceful.
// ---------------------------------------------------------------------------

const s8 = fromScenario(
  's8-graceful-restart',
  'A router was reloaded and it is unclear whether forwarding was preserved',
  'Both ends advertise Graceful Restart, A restarts without a NOTIFICATION, ' +
    'and the re-established session takes 3s to reach End-of-RIB.',
  () => {
    const grA: CapabilitySpec[] = [
      { type: 'MULTIPROTOCOL', afi: Afi.IPV4, safi: Safi.UNICAST },
      { type: 'ROUTE_REFRESH' },
      { type: 'FOUR_OCTET_AS', asNumber: A.as },
      {
        type: 'GRACEFUL_RESTART',
        restartTime: 120,
        // 0x80 is the forwarding-state-preserved flag, the whole point of GR.
        addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST, flags: 0x80 }],
      },
    ]
    const grB: CapabilitySpec[] = [
      { type: 'MULTIPROTOCOL', afi: Afi.IPV4, safi: Safi.UNICAST },
      { type: 'ROUTE_REFRESH' },
      { type: 'FOUR_OCTET_AS', asNumber: B.as },
      {
        type: 'GRACEFUL_RESTART',
        restartTime: 300,
        addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST }],
      },
    ]

    return {
      name: 'Graceful restart',
      a: { ...A, capabilities: grA },
      b: { ...B, capabilities: grB },
      gap: 200,
      steps: [
        ...establish(),
        {
          kind: 'send',
          from: 'a',
          messages: [announce(['10.1.0.0/24'], { nextHop: A.ip, asPath: [A.as] }), END_OF_RIB],
        },
        { kind: 'delay', gap: 20_000 },
        // A restarts. No NOTIFICATION — that is what makes it a restart rather
        // than a teardown, and what makes it hard to tell from a crash.
        { kind: 'reset', from: 'a' },
        { kind: 'delay', gap: 25_000 },
        ...establish(),
        {
          kind: 'send',
          from: 'a',
          messages: [announce(['10.1.0.0/24'], { nextHop: A.ip, asPath: [A.as] })],
        },
        { kind: 'delay', gap: 3000 },
        { kind: 'send', from: 'a', messages: [END_OF_RIB] },
      ],
    }
  }
)

// ---------------------------------------------------------------------------
// S9 — a refresh that did not bring back what was expected.
// ---------------------------------------------------------------------------

const s9 = fromScenario(
  's9-route-refresh',
  'A policy change was applied and a soft clear did not produce the expected routes',
  'B asks for IPv4 unicast again; A re-sends what it had plus one prefix ' +
    'tagged 65001:999, so the refresh and its answer differ.',
  () => ({
    name: 'Route refresh',
    a: A,
    b: B,
    gap: 200,
    steps: [
      ...establish(),
      {
        kind: 'send',
        from: 'a',
        messages: [announce(['10.1.0.0/24'], { nextHop: A.ip, asPath: [A.as] }), END_OF_RIB],
      },
      { kind: 'delay', gap: 10_000 },
      { kind: 'send', from: 'b', messages: [{ type: 'ROUTE_REFRESH', afi: Afi.IPV4, safi: Safi.UNICAST }] },
      {
        kind: 'send',
        from: 'a',
        messages: [
          announce(['10.1.0.0/24'], { nextHop: A.ip, asPath: [A.as] }),
          announce(['10.1.1.0/24'], {
            nextHop: A.ip,
            asPath: [A.as],
            communities: ['65001:999'],
          }),
          END_OF_RIB,
        ],
      },
    ],
  })
)

// ---------------------------------------------------------------------------
// S10 — a peer that will not stop talking.
// ---------------------------------------------------------------------------

const s10 = fromScenario(
  's10-churn',
  'CPU on the router is high and the RIB will not settle',
  '120 prefixes, 60 of them withdrawn and re-announced three times over, with ' +
    'the AS_PATH changing on the way back.',
  () => {
    const prefixes = Array.from({ length: 120 }, (_, i) => `10.${100 + (i >> 8)}.${i & 0xff}.0/24`)
    const churning = prefixes.slice(0, 60)

    const churn: Scenario['steps'] = []
    for (let round = 0; round < 3; round++) {
      churn.push({ kind: 'send', from: 'a', messages: [withdraw(churning)], gap: 4000 })
      churn.push({
        kind: 'send',
        from: 'a',
        messages: [announce(churning, { nextHop: A.ip, asPath: [A.as, 65500] })],
        gap: 4000,
      })
    }

    return {
      name: 'Withdraw burst',
      a: A,
      b: B,
      gap: 200,
      steps: [
        ...establish(),
        {
          kind: 'send',
          from: 'a',
          messages: [announce(prefixes, { nextHop: A.ip, asPath: [A.as] }), END_OF_RIB],
        },
        ...churn,
      ],
    }
  }
)

// ---------------------------------------------------------------------------
// S11 — a session that dies without saying anything.
// ---------------------------------------------------------------------------

const s11 = fromScenario(
  's11-silent-teardown',
  'The session dropped and there is no NOTIFICATION anywhere in the capture',
  'Two teardowns, neither announced at the BGP layer: a bare RST 5s after the ' +
    'last KEEPALIVE, and later a FIN exchange. Both shapes are here because an ' +
    'implementation that only looks for RST would call the second one healthy.',
  () => ({
    name: 'Silent teardown',
    a: A,
    b: B,
    gap: 200,
    steps: [
      ...establish(),
      {
        kind: 'send',
        from: 'a',
        messages: [announce(['10.1.0.0/24'], { nextHop: A.ip, asPath: [A.as] }), END_OF_RIB],
      },
      { kind: 'delay', gap: 20_000 },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      { kind: 'delay', gap: 5000 },
      // Something in the middle — a firewall state timeout, a load balancer —
      // kills the TCP session. Neither speaker gets to say why.
      { kind: 'reset', from: 'b' },
      { kind: 'delay', gap: 60_000 },

      ...establish(),
      {
        kind: 'send',
        from: 'a',
        messages: [announce(['10.1.0.0/24'], { nextHop: A.ip, asPath: [A.as] }), END_OF_RIB],
      },
      { kind: 'delay', gap: 20_000 },
      // The same fault with better manners: the connection is closed rather
      // than reset. A BGP speaker that meant to go away would have sent Cease
      // first, so a FIN on its own is the same missing explanation.
      { kind: 'close', from: 'b' },
      { kind: 'delay', gap: 60_000 },
      ...establish(),
    ],
  })
)

// ---------------------------------------------------------------------------
// S12 — the capture itself is the problem.
// ---------------------------------------------------------------------------

/**
 * A capture with one direction in it, which has two possible causes and no way
 * to tell them apart.
 *
 * The obvious reading is a broken mirror: a SPAN session or a capture filter
 * that only caught one leg, so the evidence is half missing. The other reading
 * is a fault — the peer's packets genuinely are not arriving, because of a
 * unidirectional link, an ACL applied in one direction, or MD5 configured on
 * one side only. Both produce this file. Nothing in it distinguishes them.
 *
 * That ambiguity is the point rather than a weakness of the scenario. Whichever
 * cause it is, every conclusion drawn from the file is unsafe until it is said
 * out loud, and the second cause is a real outage rather than a capture
 * problem — so "your capture looks incomplete" would be the wrong thing to say.
 *
 * Built by taking a complete capture and deleting every frame the far end sent,
 * which is what both causes do to the evidence.
 */
const s12: ScenarioCase = {
  id: 's12-one-direction',
  title: 'The capture shows a healthy session that the router says is down',
  expect:
    'Only frames sourced by 10.0.0.1 survive — including the TCP handshake, so ' +
    'even the SYN-ACK is absent. The NOTIFICATION 6/2 that ended the session ' +
    'was sent by the other end and is simply gone.',
  build: () => {
    const full = buildScenario({
      name: 'One direction only',
      a: A,
      b: B,
      gap: 200,
      steps: [
        ...establish(),
        {
          kind: 'send',
          from: 'a',
          messages: [announce(['10.1.0.0/24'], { nextHop: A.ip, asPath: [A.as] }), END_OF_RIB],
        },
        { kind: 'send', from: 'b', messages: [{ type: 'NOTIFICATION', errorCode: 6, errorSubcode: 2 }] },
      ],
    })

    const fromA = full.frames.filter((frame) => sourcedBy(frame, A.ip))
    return { bytes: writePcap(fromA, full.linkType), frameCount: fromA.length }
  },
}

/**
 * Whether an untagged Ethernet/IPv4 frame came from `ip`.
 *
 * The source address sits at offset 26: 14 bytes of Ethernet header, then 12
 * into the IPv4 header. Good enough for frames this file built itself, and
 * deliberately not a parser — `lib/pcap` is the parser.
 */
function sourcedBy(frame: ExportableFrame, ip: string): boolean {
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4) throw new Error(`sourcedBy expects an IPv4 address, got "${ip}"`)
  return octets.every((octet, i) => frame.frameBytes[26 + i] === octet)
}

// ---------------------------------------------------------------------------
// S13 — a MAC that will not stay put.
// ---------------------------------------------------------------------------

const s13: ScenarioCase = {
  id: 's13-evpn-mac-move',
  title: 'A host in the fabric is unreachable in bursts',
  expect:
    'One MAC in VNI 10100 advertised by leaf2, withdrawn by leaf2, then ' +
    'advertised by leaf1 — a move, seen as the two halves it is made of.',
  // The EVPN fixture already exists next to the assertions that depend on it,
  // and a second hand-encoded copy here would be a second thing to keep right.
  build: async () => {
    const { evpnCapture } = await import('../tests/e2e/helpers')
    const capture = evpnCapture()
    return { bytes: new Uint8Array(capture), frameCount: 6 }
  },
}

// ---------------------------------------------------------------------------
// S14 — the peer accepts the connection and then says nothing.
// ---------------------------------------------------------------------------

/**
 * The case a capture taken on one router is worst at explaining, and the one
 * an operator hits most often when the far end is somebody else's.
 *
 * TCP comes up — so it is not S1, where the SYN is refused outright. Both
 * directions are present — so it is not S12, where half the conversation is
 * missing. The peer completes the handshake and then contributes no BGP at
 * all: no OPEN, no NOTIFICATION, nothing.
 *
 * Note what that rules *out*. Something accepted the connection on port 179,
 * so the port is open, an ACL is not dropping the SYN, and MD5 does not
 * disagree — a one-sided MD5 configuration fails at the handshake, not after
 * it. The fault is therefore somewhere after TCP came up, which is a much
 * smaller set: the peer's BGP unwilling to talk to this address, or the
 * payload not surviving a path that carries the handshake fine. A middlebox
 * that terminates TCP on the peer's behalf, a PMTU black hole that passes
 * small segments and drops full-sized ones, and control-plane policing all
 * look like this.
 *
 * What the capture *can* say is precise and worth saying: the connection
 * established, we sent an OPEN, and nothing came back before we gave up. That
 * narrows the search to the far end, which is exactly the conclusion this
 * capture should support.
 */
const s14 = fromScenario(
  's14-open-unanswered',
  'TCP connects, our OPEN goes out, and the peer never answers',
  'Three attempts. Each one completes the handshake, sends an OPEN, waits out ' +
    'the hold time in OpenSent and gives up. Exactly one BGP message per ' +
    'attempt, all of it ours.',
  () => {
    const attempt = (): Scenario['steps'] => [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      // Nothing from B. A waits its hold time in OpenSent and abandons the
      // connection; a real speaker backs off and tries again.
      { kind: 'delay', gap: 90_000 },
      { kind: 'reset', from: 'a' },
      { kind: 'delay', gap: 30_000 },
    ]

    return {
      name: 'OPEN unanswered',
      a: A,
      b: B,
      gap: 200,
      steps: [...attempt(), ...attempt(), ...attempt()],
    }
  }
)

// ---------------------------------------------------------------------------

export const SCENARIOS: ScenarioCase[] = [
  s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14,
]

async function main(): Promise<void> {
  const wanted = process.argv.slice(2)
  const selected =
    wanted.length === 0
      ? SCENARIOS
      : SCENARIOS.filter((scenario) =>
          wanted.some((arg) => scenario.id === arg || scenario.id.startsWith(`${arg}-`))
        )

  if (selected.length === 0) {
    console.error(`No scenario matched ${wanted.join(', ')}. Known ids:`)
    for (const scenario of SCENARIOS) console.error(`  ${scenario.id}`)
    process.exit(1)
  }

  mkdirSync(OUT_DIR, { recursive: true })

  for (const scenario of selected) {
    const { bytes, frameCount } = await scenario.build()
    const path = join(OUT_DIR, `${scenario.id}.pcap`)
    writeFileSync(path, bytes)
    console.log(`${scenario.id.padEnd(24)} ${String(frameCount).padStart(3)} frames  ${scenario.title}`)
  }
}

// Only when run as a script. `testlab/screenshots.ts` imports SCENARIOS to build
// the same captures in memory, and importing this file should not write pcaps.
if (import.meta.main) await main()
