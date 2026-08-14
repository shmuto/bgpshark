/**
 * Ready-made scenarios.
 *
 * These are the captures you otherwise have to go and find: a session that
 * comes up cleanly, and the handful of ways one fails. They exist to be
 * starting points — pick the shape of the problem, then change the addresses,
 * AS numbers and prefixes to match the one in front of you.
 *
 * Each is a plain `Scenario`, so anything a preset does can be written by hand,
 * and a preset can be taken apart and edited rather than only run.
 */
import type { Scenario, ScenarioPeer } from './scenario'
import type { BgpMessageSpec, PathAttributeSpec, PrefixSpec } from './bgp-encode'
import { Afi, Safi } from '../bgp/constants'

export interface PresetDefinition {
  id: string
  name: string
  /** What the resulting capture shows, in the terms someone would search for it. */
  description: string
  build: () => Scenario
}

const ROUTER_A: ScenarioPeer = {
  ip: '10.0.0.1',
  as: 65001,
  routerId: '1.1.1.1',
  holdTime: 90,
}

const ROUTER_B: ScenarioPeer = {
  ip: '10.0.0.2',
  as: 65002,
  routerId: '2.2.2.2',
  holdTime: 90,
}

/**
 * An UPDATE announcing `prefixes` with a plausible set of attributes.
 *
 * `PrefixSpec` rather than `string` so a prefix can carry an ADD-PATH Path
 * Identifier, which the encoder has always written — the narrower signature
 * here just made it unreachable from the presets and the test captures.
 */
export function announce(
  prefixes: PrefixSpec[],
  options: { nextHop: string; asPath: number[]; origin?: 'IGP' | 'EGP' | 'INCOMPLETE'; med?: number; communities?: string[] }
): BgpMessageSpec {
  const attributes: PathAttributeSpec[] = [
    { type: 'ORIGIN', value: options.origin ?? 'IGP' },
    { type: 'AS_PATH', segments: [{ type: 'AS_SEQUENCE', asNumbers: options.asPath }] },
    { type: 'NEXT_HOP', address: options.nextHop },
  ]

  if (options.med !== undefined) attributes.push({ type: 'MULTI_EXIT_DISC', value: options.med })
  if (options.communities?.length) {
    attributes.push({ type: 'COMMUNITIES', communities: options.communities })
  }

  return { type: 'UPDATE', pathAttributes: attributes, nlri: prefixes }
}

/** An UPDATE that withdraws `prefixes`. */
export function withdraw(prefixes: PrefixSpec[]): BgpMessageSpec {
  return { type: 'UPDATE', withdrawnRoutes: prefixes }
}

/** RFC 4724's End-of-RIB for IPv4 unicast: an UPDATE with nothing in it. */
export const END_OF_RIB: BgpMessageSpec = { type: 'UPDATE' }

// ---------------------------------------------------------------------------

function establishedSession(): Scenario {
  return {
    name: 'Established session',
    a: ROUTER_A,
    b: ROUTER_B,
    gap: 200,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      {
        kind: 'send',
        from: 'a',
        messages: [
          announce(['10.1.0.0/24', '10.1.1.0/24'], {
            nextHop: ROUTER_A.ip,
            asPath: [ROUTER_A.as],
            communities: ['65001:100'],
          }),
          announce(['192.168.0.0/22'], {
            nextHop: ROUTER_A.ip,
            asPath: [ROUTER_A.as, 65100],
            med: 50,
          }),
          END_OF_RIB,
        ],
      },
      {
        kind: 'send',
        from: 'b',
        messages: [
          announce(['10.2.0.0/24'], { nextHop: ROUTER_B.ip, asPath: [ROUTER_B.as] }),
          END_OF_RIB,
        ],
      },
      { kind: 'delay', gap: 30_000 },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
    ],
  }
}

function holdTimerExpired(): Scenario {
  return {
    name: 'Hold timer expired',
    a: ROUTER_A,
    b: { ...ROUTER_B, holdTime: 30 },
    gap: 200,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      {
        kind: 'send',
        from: 'a',
        messages: [announce(['10.1.0.0/24'], { nextHop: ROUTER_A.ip, asPath: [ROUTER_A.as] })],
      },
      // A's keepalives stop arriving. B waits out its hold time and tears the
      // session down — the classic symptom of one-way reachability.
      { kind: 'delay', gap: 30_000 },
      { kind: 'send', from: 'b', messages: [{ type: 'NOTIFICATION', errorCode: 4, errorSubcode: 0 }] },
      { kind: 'close', from: 'b', gap: 50 },
    ],
  }
}

function badPeerAs(): Scenario {
  return {
    name: 'AS mismatch',
    a: { ...ROUTER_A, as: 65099 },
    b: ROUTER_B,
    gap: 200,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      // B was configured with a different remote-as, so it never sends an OPEN
      // of its own — it rejects the one it got.
      { kind: 'send', from: 'b', messages: [{ type: 'NOTIFICATION', errorCode: 2, errorSubcode: 2 }] },
      { kind: 'close', from: 'b', gap: 50 },
    ],
  }
}

function connectionRefused(): Scenario {
  return {
    name: 'TCP rejected (no BGP)',
    a: ROUTER_A,
    b: ROUTER_B,
    gap: 1000,
    steps: [
      // Nothing above TCP ever happens. This is what an MD5 mismatch, an ACL or
      // a missing neighbor statement looks like in a capture, and the reason
      // the dashboard has to diagnose the TCP layer when there is no BGP.
      { kind: 'handshake', gap: 0 },
      { kind: 'reset', from: 'b', gap: 1 },
      { kind: 'handshake' },
      { kind: 'reset', from: 'b', gap: 1 },
      { kind: 'handshake' },
      { kind: 'reset', from: 'b', gap: 1 },
    ],
  }
}

function ipv6Peering(): Scenario {
  const a: ScenarioPeer = { ip: '2001:db8::1', as: 64501, routerId: '10.0.0.1' }
  const b: ScenarioPeer = { ip: '2001:db8::2', as: 64502, routerId: '10.0.0.2' }

  return {
    name: 'IPv6 transport',
    a,
    b,
    gap: 200,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      {
        kind: 'send',
        from: 'a',
        messages: [
          {
            type: 'UPDATE',
            pathAttributes: [
              { type: 'ORIGIN', value: 'IGP' },
              { type: 'AS_PATH', segments: [{ asNumbers: [a.as] }] },
              {
                type: 'MP_REACH_NLRI',
                afi: Afi.IPV6,
                safi: Safi.UNICAST,
                nextHop: a.ip,
                nlri: ['2001:db8:1::/48', '2001:db8:2::/48'],
              },
            ],
          },
        ],
      },
      {
        kind: 'send',
        from: 'b',
        messages: [
          {
            type: 'UPDATE',
            pathAttributes: [
              {
                type: 'MP_UNREACH_NLRI',
                afi: Afi.IPV6,
                safi: Safi.UNICAST,
                withdrawnRoutes: ['2001:db8:9::/48'],
              },
            ],
          },
        ],
      },
    ],
  }
}

function routeFlap(): Scenario {
  const prefix = '10.9.9.0/24'
  const cycles = 5

  const flapping: Scenario['steps'] = []
  for (let i = 0; i < cycles; i++) {
    flapping.push({
      kind: 'send',
      from: 'a',
      messages: [announce([prefix], { nextHop: ROUTER_A.ip, asPath: [ROUTER_A.as] })],
      gap: 2000,
    })
    flapping.push({ kind: 'send', from: 'a', messages: [withdraw([prefix])], gap: 3000 })
  }

  return {
    name: 'Flapping route',
    a: ROUTER_A,
    b: ROUTER_B,
    gap: 200,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      {
        kind: 'send',
        from: 'a',
        messages: [announce(['10.1.0.0/24'], { nextHop: ROUTER_A.ip, asPath: [ROUTER_A.as] })],
      },
      ...flapping,
    ],
  }
}

function fourByteAsPeering(): Scenario {
  const a: ScenarioPeer = { ip: '10.0.0.1', as: 4200000001, routerId: '1.1.1.1' }
  const b: ScenarioPeer = { ip: '10.0.0.2', as: 4200000002, routerId: '2.2.2.2' }

  return {
    name: '4-byte AS numbers',
    a,
    b,
    gap: 200,
    steps: [
      { kind: 'handshake' },
      // Both OPENs carry AS_TRANS in the 2-byte field with the real number in
      // the capability, so the AS path only reads correctly if the OPENs were
      // captured too.
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      {
        kind: 'send',
        from: 'a',
        messages: [
          announce(['172.16.0.0/16'], { nextHop: a.ip, asPath: [a.as, 4200000009] }),
        ],
      },
    ],
  }
}

function segmentedUpdates(): Scenario {
  // Enough prefixes that the UPDATE has to be split across segments at this MTU.
  const prefixes = Array.from({ length: 400 }, (_, i) => `10.${(i >> 8) & 0xff}.${i & 0xff}.0/24`)

  return {
    name: 'UPDATE split across TCP segments',
    a: ROUTER_A,
    b: ROUTER_B,
    gap: 200,
    mtu: 576,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      {
        kind: 'send',
        from: 'a',
        messages: [
          announce(prefixes.slice(0, 200), { nextHop: ROUTER_A.ip, asPath: [ROUTER_A.as, 65100] }),
          announce(prefixes.slice(200), { nextHop: ROUTER_A.ip, asPath: [ROUTER_A.as] }),
          END_OF_RIB,
        ],
      },
    ],
  }
}

export const PRESETS: PresetDefinition[] = [
  {
    id: 'established',
    name: 'Established session',
    description: 'Handshake, OPEN exchange, route advertisement and End-of-RIB. A healthy baseline.',
    build: establishedSession,
  },
  {
    id: 'hold-timer',
    name: 'Hold timer expired',
    description: 'The session comes up, one side goes quiet, the other tears it down with NOTIFICATION 4/0.',
    build: holdTimerExpired,
  },
  {
    id: 'bad-peer-as',
    name: 'AS mismatch',
    description: 'The OPEN is rejected with NOTIFICATION 2/2 because remote-as does not match.',
    build: badPeerAs,
  },
  {
    id: 'connection-refused',
    name: 'TCP rejected — no BGP at all',
    description: 'SYN answered with RST, three times over. What an MD5 mismatch or an ACL looks like.',
    build: connectionRefused,
  },
  {
    id: 'ipv6',
    name: 'IPv6 transport',
    description: 'A session over IPv6 carrying IPv6 routes in MP_REACH_NLRI and MP_UNREACH_NLRI.',
    build: ipv6Peering,
  },
  {
    id: 'flap',
    name: 'Flapping route',
    description: 'One prefix announced and withdrawn five times over, for the route analysis screen.',
    build: routeFlap,
  },
  {
    id: 'four-byte-as',
    name: '4-byte AS numbers',
    description: 'AS_TRANS in the OPEN with the real ASN in the capability, and a 4-byte AS_PATH.',
    build: fourByteAsPeering,
  },
  {
    id: 'segmented',
    name: 'UPDATE split across segments',
    description: 'A 400-prefix advertisement at a 576-byte MTU, so messages span TCP segments.',
    build: segmentedUpdates,
  },
]

export function presetById(id: string): PresetDefinition | undefined {
  return PRESETS.find((preset) => preset.id === id)
}
