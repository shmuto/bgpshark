import { expect, type Page } from '@playwright/test'
import { buildScenario, END_OF_RIB } from '../../src/lib/build'
import { writePcap } from '../../src/lib/pcap/writer'

/**
 * Loads the bundled sample capture through the button a user would press, and
 * waits until the message explorer has something in it.
 *
 * Going through the UI rather than seeding IndexedDB directly means the tests
 * exercise the same path the app takes on a real upload, including the DuckDB
 * load that several of the assertions depend on.
 */
export async function loadSample(page: Page) {
  await page.goto('./', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /sample/i }).first().click()
  await page.waitForURL('**/messages')
  await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
}

/** Loads a capture built in memory, for the cases the sample cannot cover. */
export async function loadCapture(page: Page, name: string, bytes: Buffer) {
  await page.goto('./', { waitUntil: 'networkidle' })
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: 'application/vnd.tcpdump.pcap',
    buffer: bytes,
  })
}

/**
 * Clicks through to the Dashboard and waits until it has actually rendered.
 *
 * Clicking a header link and reading `innerText` on the next line is a race:
 * the assertion can run against the screen you just left. It fails loudly on a
 * positive assertion and — much worse — passes silently on a negative one, so
 * "the dashboard does not say X" would be satisfied by a dashboard that had not
 * appeared yet. The Alerts panel is unconditional on this screen, including
 * when it has nothing to report, so waiting for its heading is the cheapest
 * proof that the render happened.
 */
export async function goToDashboard(page: Page) {
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await page.waitForURL('**/dashboard')
  await expect(page.getByRole('heading', { name: /^Alerts/ })).toBeVisible()
}

/** The "Showing N of M packets" counter, as a number. */
export async function shownCount(page: Page): Promise<number> {
  const text = await page.getByText(/Showing \d+ of \d+ packets/).first().textContent()
  return Number(text?.match(/Showing (\d+)/)?.[1] ?? -1)
}

/** The "N prefixes" counter on the route analysis screen. */
export async function prefixCount(page: Page): Promise<number> {
  const text = await page.getByText(/\d+ prefixes/).first().textContent()
  return Number(text?.match(/(\d+) prefixes/)?.[1] ?? -1)
}

/**
 * Types a filter expression and waits past the DuckDB debounce, so what the
 * assertion reads is the database's answer rather than the in-memory one that
 * appears first.
 */
export async function applyFilter(page: Page, expression: string) {
  await page.getByRole('button', { name: 'Advanced' }).click()
  const input = page.locator('input[type="text"]').first()
  await input.click()
  await input.fill(expression)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
}

/** Runs a query in the SQL console and returns the page text once it settles. */
export async function runSql(page: Page, sql: string): Promise<string> {
  const editor = page.locator('textarea').first()
  await editor.click()
  await editor.fill(sql)
  await page.keyboard.press('Control+Enter')
  await expect(page.getByText(/Results \(|Error:/).first()).toBeVisible()
  await page.waitForTimeout(600)
  return page.locator('body').innerText()
}

/**
 * A small VXLAN fabric: two leaves peering, both joining a VNI, MACs learned
 * behind leaf2, and then one MAC moving to leaf1 — withdrawn by the leaf that
 * had it and re-announced by the leaf that now does.
 *
 * Built here rather than committed as a fixture so what it contains is legible
 * next to the assertions that depend on it. EVPN needs a capture of its own:
 * the sample has no L2VPN in it, so nothing else in this suite would notice if
 * EVPN stopped reaching the database.
 */
export function evpnCapture(): Buffer {
  const bgp = (type: number, body: number[]) => {
    const length = 19 + body.length
    return Buffer.from([...Array(16).fill(0xff), length >> 8, length & 0xff, type, ...body])
  }
  const attribute = (flags: number, type: number, value: number[]) => [flags, type, value.length, ...value]
  const ip4 = (address: string) => address.split('.').map(Number)
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

  // OPEN advertising 4-byte AS and MP-BGP for L2VPN/EVPN (AFI 25 / SAFI 70).
  const open = (as: number, routerId: string) => {
    const caps = [2, 6, 65, 4, ...u32(as), 2, 6, 1, 4, 0, 25, 0, 70]
    return bgp(1, [4, as >> 8, as & 0xff, 0, 90, ...ip4(routerId), caps.length, ...caps])
  }

  const rd = (address: string, n: number) => [0, 1, ...ip4(address), n >> 8, n & 0xff]
  const vni = (v: number) => [(v << 4) >> 16, ((v << 4) >> 8) & 0xff, (v << 4) & 0xff]
  const mac = (text: string) => text.split(':').map((byte) => parseInt(byte, 16))
  const nlri = (type: number, value: number[]) => [type, value.length, ...value]

  const macRoute = (leaf: string, id: number, address: string, tag: number) =>
    nlri(2, [...rd(leaf, id), ...new Array(10).fill(0), ...u32(0), 48, ...mac(address), 0, ...vni(tag)])
  const imet = (leaf: string, id: number) => nlri(3, [...rd(leaf, id), ...u32(0), 32, ...ip4(leaf)])

  // Route Target 65002:100 and the VXLAN encapsulation community, on every route.
  const routeTarget = [0x00, 0x02, 0xfd, 0xea, ...u32(100)]
  const vxlan = [0x03, 0x0c, 0, 0, 0, 0, 0, 8]
  const withAttributes = (attrs: number[]) => bgp(2, [0, 0, attrs.length >> 8, attrs.length & 0xff, ...attrs])

  const announce = (nextHop: string, routes: number[], as: number) =>
    withAttributes([
      ...attribute(0x40, 1, [0]),
      ...attribute(0x40, 2, [2, 1, ...u32(as)]),
      ...attribute(0x80, 14, [0, 25, 70, 4, ...ip4(nextHop), 0, ...routes]),
      ...attribute(0xc0, 16, [...routeTarget, ...vxlan]),
    ])
  const withdraw = (routes: number[]) =>
    withAttributes(attribute(0x80, 15, [0, 25, 70, ...routes]))

  const LEAF1 = '10.0.0.1'
  const LEAF2 = '10.0.0.2'
  const events = [
    { t: 0, from: LEAF1, message: open(65001, LEAF1) },
    { t: 0.05, from: LEAF2, message: open(65002, LEAF2) },
    { t: 1, from: LEAF2, message: announce(LEAF2, [...imet(LEAF2, 100), ...imet(LEAF2, 200)], 65002) },
    { t: 3, from: LEAF2, message: announce(LEAF2, macRoute(LEAF2, 100, '00:0c:29:aa:bb:cc', 10100), 65002) },
    { t: 60, from: LEAF2, message: withdraw(macRoute(LEAF2, 100, '00:0c:29:aa:bb:cc', 10100)) },
    { t: 62, from: LEAF1, message: announce(LEAF1, macRoute(LEAF1, 100, '00:0c:29:aa:bb:cc', 10100), 65001) },
  ]

  const header = Buffer.alloc(24)
  header.writeUInt32LE(0xa1b2c3d4, 0)
  header.writeUInt16LE(2, 4)
  header.writeUInt16LE(4, 6)
  header.writeUInt32LE(65535, 16)
  header.writeUInt32LE(1, 20)

  const chunks: Buffer[] = [header]
  for (const event of events) {
    const outbound = event.from === LEAF1
    const tcp = Buffer.alloc(20)
    tcp.writeUInt16BE(outbound ? 54001 : 179, 0)
    tcp.writeUInt16BE(outbound ? 179 : 54001, 2)
    tcp.writeUInt32BE(1, 4)
    tcp[12] = 0x50
    tcp[13] = 0x18
    tcp.writeUInt16BE(65535, 14)

    const payload = Buffer.concat([tcp, event.message])
    const ip = Buffer.alloc(20)
    ip[0] = 0x45
    ip.writeUInt16BE(20 + payload.length, 2)
    ip[8] = 64
    ip[9] = 6
    Buffer.from(ip4(event.from)).copy(ip, 12)
    Buffer.from(ip4(outbound ? LEAF2 : LEAF1)).copy(ip, 16)

    const frame = Buffer.concat([
      Buffer.from('aabbccddeeff112233445566', 'hex'),
      Buffer.from([0x08, 0x00]),
      ip,
      payload,
    ])
    const record = Buffer.alloc(16)
    const seconds = 1764547200 + event.t
    record.writeUInt32LE(Math.floor(seconds), 0)
    record.writeUInt32LE(Math.round((seconds % 1) * 1e6), 4)
    record.writeUInt32LE(frame.length, 8)
    record.writeUInt32LE(frame.length, 12)
    chunks.push(record, frame)
  }

  return Buffer.concat(chunks)
}

/**
 * A pcapng whose first packets claim more captured bytes than they carry, so
 * the parser produces warnings. Built from the sample rather than committed as
 * a second fixture, so it cannot drift away from it.
 */
export function corruptCapture(sample: Buffer): Buffer {
  const bytes = Buffer.from(sample)
  let offset = 0
  let patched = 0

  while (offset + 8 <= bytes.length) {
    const type = bytes.readUInt32LE(offset)
    const length = bytes.readUInt32LE(offset + 4)
    if (length < 12 || offset + length > bytes.length) break

    // Enhanced Packet Block: bump its captured length past the block's own end.
    if (type === 6 && patched < 3) {
      bytes.writeUInt32LE(bytes.readUInt32LE(offset + 20) + 40, offset + 20)
      patched++
    }
    offset += length
  }

  return bytes
}

/**
 * A peer that accepts the connection and then says nothing.
 *
 * The TCP handshake completes, we send an OPEN, and no BGP ever comes back —
 * the shape of a fault at the far end seen from a capture taken on one router.
 * Built here rather than read from `testlab/scenarios/`, which is gitignored
 * and therefore absent in CI; `testlab/scenarios.ts` is the same situation
 * written for a human to open, this is the same situation written for a test.
 */
export function unansweredOpenCapture(): Buffer {
  const built = buildScenario({
    a: { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1', holdTime: 90 },
    b: { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2', holdTime: 90 },
    gap: 200,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'delay', gap: 90_000 },
      { kind: 'reset', from: 'a' },
    ],
  })
  return Buffer.from(built.bytes)
}

/**
 * A session that drops twice with nothing at the BGP layer recording it: once
 * by RST, once by FIN, then coming back up.
 *
 * Both shapes are here on purpose. A firewall closes an idle session politely
 * as readily as it resets one, so a rule that only looked for RST would call
 * the second teardown healthy — the same reasoning `testlab/scenarios.ts`
 * writes into `s11-silent-teardown`, which this is the test-sized copy of.
 */
export function silentTeardownCapture(): Buffer {
  const a = { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1', holdTime: 90 }
  const b = { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2', holdTime: 90 }
  const establish = [
    { kind: 'handshake' as const },
    { kind: 'open' as const, from: 'a' as const },
    { kind: 'open' as const, from: 'b' as const },
    { kind: 'keepalive' as const, from: 'a' as const },
    { kind: 'keepalive' as const, from: 'b' as const },
  ]

  const built = buildScenario({
    a,
    b,
    gap: 200,
    steps: [
      ...establish,
      { kind: 'delay', gap: 20_000 },
      { kind: 'reset', from: 'b' },
      { kind: 'delay', gap: 60_000 },
      ...establish,
      { kind: 'delay', gap: 20_000 },
      { kind: 'close', from: 'b' },
      { kind: 'delay', gap: 60_000 },
      ...establish,
    ],
  })
  return Buffer.from(built.bytes)
}

/**
 * A soft clear, and what came back from it.
 *
 * `gained` is the `s9-route-refresh` shape: the re-advertisement brings back
 * the original route plus one tagged with a community. `lost` is the other
 * half of the same complaint and the reason this cannot be read from
 * withdrawals — a route the peer no longer has is simply *absent* from the
 * re-advertisement, and nothing in the capture withdraws it.
 */
export function routeRefreshCapture(outcome: 'gained' | 'lost' = 'gained'): Buffer {
  const a = { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1', holdTime: 90 }
  const b = { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2', holdTime: 90 }

  const route = (prefix: string, communities?: string[]) => ({
    type: 'UPDATE' as const,
    pathAttributes: [
      { type: 'ORIGIN' as const, value: 'IGP' as const },
      { type: 'AS_PATH' as const, segments: [{ type: 'AS_SEQUENCE' as const, asNumbers: [65001] }] },
      { type: 'NEXT_HOP' as const, address: a.ip },
      ...(communities ? [{ type: 'COMMUNITIES' as const, communities }] : []),
    ],
    nlri: [prefix],
  })

  const before =
    outcome === 'gained' ? [route('10.1.0.0/24')] : [route('10.1.0.0/24'), route('10.2.0.0/24')]
  const after =
    outcome === 'gained'
      ? [route('10.1.0.0/24'), route('10.1.1.0/24', ['65001:999'])]
      : [route('10.1.0.0/24')]

  const built = buildScenario({
    a,
    b,
    gap: 200,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      { kind: 'send', from: 'a', messages: [...before, END_OF_RIB] },
      { kind: 'delay', gap: 10_000 },
      // B asks A to re-advertise, which is what a soft clear looks like on the
      // wire — so the table being compared is A's.
      { kind: 'send', from: 'b', messages: [{ type: 'ROUTE_REFRESH', afi: 1, safi: 1 }] },
      { kind: 'send', from: 'a', messages: [...after, END_OF_RIB] },
    ],
  })
  return Buffer.from(built.bytes)
}

/**
 * One prefix offered by two peers, where the shorter AS_PATH is not the winner.
 *
 * The same shape as `s4-bestpath`: 192.0.2.1 offers `65010 65200` with MED 300
 * and no LOCAL_PREF, 198.51.100.1 offers the longer `65020 65300 65200` with
 * MED 10 and LOCAL_PREF 200. LOCAL_PREF outranks path length, so the long path
 * wins and nothing but the attributes says why — which is the whole of S4.
 */
export function bestPathCapture(): Buffer {
  const local = { as: 65000, routerId: '100.100.100.100', holdTime: 90 }
  const establish = [
    { kind: 'handshake' as const },
    { kind: 'open' as const, from: 'a' as const },
    { kind: 'open' as const, from: 'b' as const },
    { kind: 'keepalive' as const, from: 'a' as const },
    { kind: 'keepalive' as const, from: 'b' as const },
  ]

  const short = buildScenario({
    a: { ip: '192.0.2.1', as: 65010, routerId: '10.10.10.10', holdTime: 90 },
    b: { ...local, ip: '192.0.2.100' },
    gap: 200,
    startTime: new Date('2026-01-01T00:00:00Z'),
    steps: [
      ...establish,
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
            nlri: ['172.20.0.0/16'],
          },
        ],
      },
    ],
  })

  const long = buildScenario({
    a: { ip: '198.51.100.1', as: 65020, routerId: '20.20.20.20', holdTime: 90 },
    b: { ...local, ip: '198.51.100.100' },
    gap: 200,
    startTime: new Date('2026-01-01T00:00:05Z'),
    steps: [
      ...establish,
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
            nlri: ['172.20.0.0/16'],
          },
        ],
      },
    ],
  })

  // Two separate sessions in one file, which is what a capture on the router
  // receiving both upstreams actually looks like.
  return Buffer.from(writePcap([...short.frames, ...long.frames], short.linkType))
}

/**
 * A router that reloaded, with both ends having agreed how to survive it.
 *
 * The same shape as `s8-graceful-restart`: A drops the connection without a
 * NOTIFICATION, comes back, and reaches End-of-RIB three seconds later. What
 * makes it a restart rather than a crash loop is entirely in the OPENs — the
 * Graceful Restart capability on both, A's saying it kept forwarding — so a
 * test capture without them would prove nothing about the rule.
 *
 * `forwarding` is a parameter because the flag is what decides whether the
 * restart was harmless or a hole in the dataplane, and both readings need a
 * capture.
 */
export function gracefulRestartCapture(options: { forwarding?: boolean } = {}): Buffer {
  const capabilities = (asNumber: number, restartTime: number, forwarding: boolean) => [
    { type: 'MULTIPROTOCOL' as const, afi: 1, safi: 1 },
    { type: 'FOUR_OCTET_AS' as const, asNumber },
    {
      type: 'GRACEFUL_RESTART' as const,
      restartTime,
      // 0x80 is the forwarding-state-preserved flag, the whole point of GR.
      addressFamilies: [{ afi: 1, safi: 1, flags: forwarding ? 0x80 : 0 }],
    },
  ]
  const preserved = options.forwarding ?? true

  const a = {
    ip: '10.0.0.1',
    as: 65001,
    routerId: '1.1.1.1',
    holdTime: 90,
    capabilities: capabilities(65001, 120, preserved),
  }
  const b = {
    ip: '10.0.0.2',
    as: 65002,
    routerId: '2.2.2.2',
    holdTime: 90,
    capabilities: capabilities(65002, 300, false),
  }
  const establish = [
    { kind: 'handshake' as const },
    { kind: 'open' as const, from: 'a' as const },
    { kind: 'open' as const, from: 'b' as const },
    { kind: 'keepalive' as const, from: 'a' as const },
    { kind: 'keepalive' as const, from: 'b' as const },
  ]

  const built = buildScenario({
    a,
    b,
    gap: 200,
    steps: [
      ...establish,
      { kind: 'send', from: 'a', messages: [END_OF_RIB] },
      { kind: 'delay', gap: 20_000 },
      { kind: 'reset', from: 'a' },
      { kind: 'delay', gap: 25_000 },
      ...establish,
      { kind: 'delay', gap: 3000 },
      { kind: 'send', from: 'a', messages: [END_OF_RIB] },
    ],
  })
  return Buffer.from(built.bytes)
}

/**
 * The same two teardowns, each with a NOTIFICATION in front of it.
 *
 * This is the capture the teardown rule has to stay quiet about: the resets are
 * still there, but a Cease said why, so a second row announcing the reset would
 * be a worse explanation of packets that already have one.
 */
export function explainedTeardownCapture(): Buffer {
  const a = { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1', holdTime: 90 }
  const b = { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2', holdTime: 90 }
  const establish = [
    { kind: 'handshake' as const },
    { kind: 'open' as const, from: 'a' as const },
    { kind: 'open' as const, from: 'b' as const },
    { kind: 'keepalive' as const, from: 'a' as const },
    { kind: 'keepalive' as const, from: 'b' as const },
  ]
  // Cease / Administrative Shutdown, which is how a speaker that meant to go
  // away says so.
  const cease = {
    kind: 'send' as const,
    from: 'b' as const,
    messages: [{ type: 'NOTIFICATION' as const, errorCode: 6, errorSubcode: 2 }],
  }

  const built = buildScenario({
    a,
    b,
    gap: 200,
    steps: [
      ...establish,
      { kind: 'delay', gap: 20_000 },
      cease,
      { kind: 'reset', from: 'b' },
      { kind: 'delay', gap: 60_000 },
      ...establish,
      { kind: 'delay', gap: 20_000 },
      cease,
      { kind: 'reset', from: 'b' },
    ],
  })
  return Buffer.from(built.bytes)
}

/**
 * The same session with every frame the far end sent removed, which is what
 * both a one-legged mirror and a one-way reachability fault do to the evidence.
 */
export function oneDirectionCapture(): Buffer {
  const full = buildScenario({
    a: { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1', holdTime: 90 },
    b: { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2', holdTime: 90 },
    gap: 200,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      { kind: 'send', from: 'b', messages: [{ type: 'NOTIFICATION', errorCode: 6, errorSubcode: 2 }] },
    ],
  })
  // IPv4 source address: 14 bytes of Ethernet, then 12 into the IPv4 header.
  const fromA = full.frames.filter((frame) =>
    [10, 0, 0, 1].every((octet, i) => frame.frameBytes[26 + i] === octet)
  )
  return Buffer.from(writePcap(fromA, full.linkType))
}

/**
 * An UPDATE the far end refuses, and the NOTIFICATION that hands the offending
 * attribute back.
 *
 * The same seven bytes go into the UPDATE and into the NOTIFICATION's data
 * field, which is what RFC 4271 §6.3 says happens — flags 0x40 is transitive
 * with the optional bit clear, so type code 199 is an unrecognised *well-known*
 * attribute, which is exactly error 3/2.
 */
export function malformedUpdateCapture(): Buffer {
  const offending = new Uint8Array([0x40, 0xc7, 0x04, 0xde, 0xad, 0xbe, 0xef])
  const built = buildScenario({
    a: { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1', holdTime: 90 },
    b: { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2', holdTime: 90 },
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
              { type: 'AS_PATH', segments: [{ type: 'AS_SEQUENCE', asNumbers: [65001] }] },
              { type: 'NEXT_HOP', address: '10.0.0.1' },
              { type: 'RAW', flags: offending[0], typeCode: offending[1], value: offending.slice(3) },
            ],
            nlri: ['10.5.0.0/24'],
          },
        ],
      },
      {
        kind: 'send',
        from: 'b',
        messages: [{ type: 'NOTIFICATION', errorCode: 3, errorSubcode: 2, data: offending }],
      },
    ],
  })
  return Buffer.from(built.bytes)
}

/**
 * A hold timer expiry where the two candidate measurements differ a lot.
 *
 * 10.0.0.1 goes quiet first; 10.0.0.2 keeps sending for another 30 seconds and
 * then gives up. So the gap to the *previous packet in the capture* is about
 * 60 seconds and the gap to the last thing heard *from the peer* is about 90 —
 * and only the second is the number the hold timer was counting. The two are
 * far enough apart here that a test can tell which one is on screen.
 */
export function holdTimerExpiryCapture(): Buffer {
  const built = buildScenario({
    a: { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1', holdTime: 90 },
    b: { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2', holdTime: 180 },
    gap: 200,
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'delay', gap: 30_000 },
      { kind: 'keepalive', from: 'b' },
      { kind: 'delay', gap: 60_000 },
      { kind: 'send', from: 'b', messages: [{ type: 'NOTIFICATION', errorCode: 4, errorSubcode: 0 }] },
      { kind: 'close', from: 'b', gap: 50 },
    ],
  })
  return Buffer.from(built.bytes)
}
