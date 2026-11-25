/**
 * Synthetic captures near the size limit, for measuring what a large capture
 * costs the app.
 *
 *   bun run testlab/large-captures.ts                 # all shapes, 300MB each, into testlab/out/large/
 *   bun run testlab/large-captures.ts U T --mb 250    # chosen shapes and size
 *
 * How much a decoded capture weighs depends far less on its size than on how
 * often its values repeat: the decoder keeps one copy of each repeated
 * attribute list and prefix (`src/lib/bgp/shared-decode.ts`). So the limit in
 * `src/lib/file-constraints.ts` is measured against several shapes, each the
 * worst case for a different part of the app, rather than one capture:
 *
 * - **U**, every UPDATE its own: one /32, its own AS_PATH and MED. Nothing is
 *   shared, so it is the most packets and the most decoded objects per byte.
 * - **R**, 200 routes per UPDATE: few, large UPDATEs carrying tens of millions
 *   of announcements over a modest set of prefixes — the route statistics and
 *   the SQL console's `routes` table.
 * - **T**, a table transfer: 50 routes per UPDATE, each session cycling
 *   through 300,000 distinct /24s, as a full table does. Over a million routes
 *   in all, which is what the route statistics' per-route state is sized by.
 * - **E**, EVPN and ADD-PATH: MP_REACH routes, which are never shared, from a
 *   session that negotiated Path Identifiers.
 *
 * Every capture is four sessions, `10.k.0.1` ↔ `10.k.0.2` for k = 0..3, each
 * opening with the handshake, both OPENs and both KEEPALIVEs, then sending one
 * UPDATE per segment 0.01ms apart, with a KEEPALIVE each way every 2000
 * UPDATEs. The UPDATE count is worked out from a small sample of the same
 * shape so that the file lands just under the size asked for.
 *
 * `testlab/measure-large.ts` loads these into the production build and records
 * time, memory and long tasks; see testlab/README.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  announce,
  buildScenario,
  establish,
  mergeCaptures,
  withdraw,
  type BgpMessageSpec,
  type BuiltCapture,
  type CapabilitySpec,
  type ScenarioPeer,
  type ScenarioStep,
} from '../src/lib/build'
import { Afi, Safi } from '../src/lib/bgp/constants'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LARGE_OUT_DIR = join(REPO_ROOT, 'testlab', 'out', 'large')

const SESSIONS = 4
const KEEPALIVE_EVERY = 2000
const UPDATE_GAP_MS = 0.01

export type ShapeId = 'U' | 'R' | 'T' | 'E'

interface Shape {
  id: ShapeId
  description: string
  /** The messages of UPDATE `i` on session `k`: an announcement, sometimes followed by a withdrawal. */
  updates(k: number, i: number, peer: ScenarioPeer): BgpMessageSpec[]
  capabilities?: (peer: ScenarioPeer) => CapabilitySpec[]
}

/** The dotted text of an IPv4 address given as an unsigned 32-bit number. */
function ipv4(value: number): string {
  return `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`
}

/** The `n`th /24 counted from 20.0.0.0. */
function slash24(n: number): string {
  return `${ipv4((20 << 24) + n * 256)}/24`
}

const SHAPES: Record<ShapeId, Shape> = {
  U: {
    id: 'U',
    description: 'every UPDATE its own /32, AS_PATH and MED',
    updates(k, i, peer) {
      // 2^22 addresses per session: far more than any size asked for needs.
      const prefix = (n: number) => `${ipv4((20 << 24) + k * (1 << 22) + n)}/32`
      const messages: BgpMessageSpec[] = [
        announce([prefix(i)], {
          nextHop: peer.ip,
          asPath: [peer.as, 100 + (i % 9973), 200 + (i % 7919)],
          med: i,
        }),
      ]
      if (i % 50 === 49) messages.push(withdraw([prefix(i - 1)]))
      return messages
    },
  },
  R: {
    id: 'R',
    description: '200 distinct /24s per UPDATE from 50,000 per session, 50 AS paths, communities',
    updates(k, i, peer) {
      // A window of 200 consecutive /24s sliding through the session's pool,
      // so no UPDATE carries a prefix twice and each is re-announced every
      // 250 UPDATEs.
      const POOL = 50_000
      const prefixes = (from: number, count: number) =>
        Array.from({ length: count }, (_, j) => slash24(k * POOL + ((from + j) % POOL)))
      const path = i % 50
      const messages: BgpMessageSpec[] = [
        announce(prefixes(i * 200, 200), {
          nextHop: peer.ip,
          asPath: [peer.as, 3000 + path, 4000 + (path % 7)],
          communities: [`65000:${path}`, `65000:${1000 + (path % 3)}`],
        }),
      ]
      if (i % 30 === 29) messages.push(withdraw(prefixes(i * 200 + 7, 50)))
      return messages
    },
  },
  T: {
    id: 'T',
    description: 'a table transfer: 50 /24s per UPDATE cycling through 300,000 per session',
    updates(k, i, peer) {
      const TABLE = 300_000
      const prefixes = (from: number, count: number) =>
        Array.from({ length: count }, (_, j) => slash24(k * TABLE + ((from + j) % TABLE)))
      const messages: BgpMessageSpec[] = [
        announce(prefixes(i * 50, 50), {
          nextHop: peer.ip,
          asPath: [peer.as, 5000 + (i % 200), 6000 + (i % 13)],
          med: (i % 10) * 10,
          communities: ['65000:100'],
        }),
      ]
      if (i % 40 === 39) messages.push(withdraw(prefixes(i * 50 - 1000, 20)))
      return messages
    },
  },
  E: {
    id: 'E',
    description: 'EVPN type-2 routes over MP_REACH, IPv4 unicast with ADD-PATH',
    capabilities: (peer) => [
      { type: 'MULTIPROTOCOL', afi: Afi.IPV4, safi: Safi.UNICAST },
      { type: 'MULTIPROTOCOL', afi: Afi.L2VPN, safi: Safi.EVPN },
      { type: 'ROUTE_REFRESH' },
      { type: 'FOUR_OCTET_AS', asNumber: peer.as },
      { type: 'ADD_PATH', addressFamilies: [{ afi: Afi.IPV4, safi: Safi.UNICAST, sendReceive: 'both' }] },
    ],
    updates(k, i, peer) {
      if (i % 2 === 0) {
        // Ten paths for each of 20,000 /24s, told apart by Path Identifier.
        const n = (i >> 1) % 20_000
        const nlri = Array.from({ length: 10 }, (_, p) => ({ prefix: slash24(k * 20_000 + n), pathId: p + 1 }))
        const messages: BgpMessageSpec[] = [
          announce(nlri, { nextHop: peer.ip, asPath: [peer.as, 7000 + (i % 100)], med: i % 5 }),
        ]
        if (i % 60 === 58) messages.push(withdraw(nlri.slice(0, 3)))
        return messages
      }
      // MAC/IP advertisements: 20 per UPDATE, MACs and addresses cycling through 100,000.
      const routes = Array.from({ length: 20 }, (_, j) => {
        const n = ((i >> 1) * 20 + j) % 100_000
        return evpnMacIp(k, n)
      })
      return [
        {
          type: 'UPDATE',
          pathAttributes: [
            { type: 'ORIGIN', value: 'IGP' },
            { type: 'AS_PATH', segments: [{ type: 'AS_SEQUENCE', asNumbers: [peer.as] }] },
            {
              type: 'RAW',
              flags: 0x90,
              typeCode: 14,
              value: mpReachEvpn(peer.ip, routes),
            },
            // Route Target 65000:(100..103), transitive two-octet AS.
            { type: 'RAW', flags: 0xc0, typeCode: 16, value: new Uint8Array([0, 2, 0xfd, 0xe8, 0, 0, 0, 100 + (i % 4)]) },
          ],
        },
      ]
    },
  },
}

/** An EVPN route type 2 (MAC/IP Advertisement), as its NLRI bytes. */
function evpnMacIp(k: number, n: number): Uint8Array {
  const body = new Uint8Array(8 + 10 + 4 + 1 + 6 + 1 + 4 + 3)
  let o = 0
  // RD type 1: 10.k.0.1:100
  body.set([0, 1, 10, k, 0, 1, 0, 100], o)
  o += 8
  o += 10 // ESI: zero
  body.set([0, 0, 0, 100], o) // Ethernet Tag
  o += 4
  body[o++] = 48
  body.set([0x02, k, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], o)
  o += 6
  body[o++] = 32
  body.set([30 + k, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], o)
  o += 4
  body.set([0, 0x27, 0x11], o) // MPLS label 10001
  const route = new Uint8Array(2 + body.length)
  route[0] = 2
  route[1] = body.length
  route.set(body, 2)
  return route
}

/** An MP_REACH_NLRI value for L2VPN EVPN carrying `routes`. */
function mpReachEvpn(nextHop: string, routes: Uint8Array[]): Uint8Array {
  const nh = nextHop.split('.').map(Number)
  const length = 2 + 1 + 1 + 4 + 1 + routes.reduce((sum, r) => sum + r.length, 0)
  const out = new Uint8Array(length)
  out.set([0, Afi.L2VPN, Safi.EVPN, 4, ...nh, 0])
  let o = 9
  for (const route of routes) {
    out.set(route, o)
    o += route.length
  }
  return out
}

function peers(k: number, shape: Shape): { a: ScenarioPeer; b: ScenarioPeer } {
  const a: ScenarioPeer = { ip: `10.${k}.0.1`, as: 65002 + k, routerId: `10.${k}.0.1` }
  const b: ScenarioPeer = { ip: `10.${k}.0.2`, as: 65001, routerId: `10.${k}.0.2` }
  if (shape.capabilities) {
    a.capabilities = shape.capabilities(a)
    b.capabilities = shape.capabilities(b)
  }
  return { a, b }
}

/**
 * Session `k` of `shape` with `count` UPDATEs.
 *
 * The steps are handed over as an iterable rather than an array, which the
 * compiler only ever walks once: an R session's steps, as specs, would hold
 * tens of millions of prefix strings at once.
 */
function buildSession(shape: Shape, k: number, count: number): BuiltCapture {
  const { a, b } = peers(k, shape)
  function* steps(): Generator<ScenarioStep> {
    yield* establish()
    for (let i = 0; i < count; i++) {
      yield { kind: 'send', from: 'a', messages: shape.updates(k, i, a), gap: UPDATE_GAP_MS }
      if (i % KEEPALIVE_EVERY === KEEPALIVE_EVERY - 1) {
        yield { kind: 'keepalive', from: 'a', gap: UPDATE_GAP_MS }
        yield { kind: 'keepalive', from: 'b', gap: UPDATE_GAP_MS }
      }
    }
  }
  return buildScenario({
    a,
    b,
    startTime: new Date(Date.UTC(2026, 0, 1, 0, 0, k)),
    steps: steps() as unknown as ScenarioStep[],
  })
}

/** Bytes per UPDATE for a shape, from a sample session. */
function bytesPerUpdate(shape: Shape): number {
  const small = buildSession(shape, 0, 2000).bytes.length
  const smaller = buildSession(shape, 0, 1000).bytes.length
  return (small - smaller) / 1000
}

/** A capture of `shape` just under `megabytes` MiB. */
export function buildLargeCapture(id: ShapeId, megabytes: number): Uint8Array {
  const shape = SHAPES[id]
  const target = megabytes * 1024 * 1024 * 0.995
  const perSession = Math.floor(target / bytesPerUpdate(shape) / SESSIONS)
  const sessions = Array.from({ length: SESSIONS }, (_, k) => buildSession(shape, k, perSession))
  return mergeCaptures(sessions).bytes
}

export function largeCapturePath(id: ShapeId, megabytes: number): string {
  return join(LARGE_OUT_DIR, `${id}-${megabytes}mb.pcap`)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const mbAt = args.indexOf('--mb')
  const megabytes = mbAt >= 0 ? Number(args[mbAt + 1]) : 300
  const ids = args.filter((arg, i) => arg in SHAPES && i !== mbAt + 1) as ShapeId[]
  mkdirSync(LARGE_OUT_DIR, { recursive: true })
  for (const id of ids.length > 0 ? ids : (['U', 'R', 'T'] as ShapeId[])) {
    const started = performance.now()
    const bytes = buildLargeCapture(id, megabytes)
    const path = largeCapturePath(id, megabytes)
    writeFileSync(path, bytes)
    console.log(
      `${id}: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB → ${path} ` +
        `(${SHAPES[id].description}; ${((performance.now() - started) / 1000).toFixed(0)}s)`
    )
  }
}
