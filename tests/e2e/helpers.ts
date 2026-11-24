import { expect, type Page } from '@playwright/test'
import {
  ROUTER_A,
  ROUTER_B,
  announce,
  buildScenario,
  establish,
  keepSide,
  mergeCaptures,
  patchRecord,
  END_OF_RIB,
  type BgpMessageSpec,
  type CapabilitySpec,
} from '../../src/lib/build'

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
  await openMessagesAfterLoad(page)
}

/**
 * Waits for a freshly loaded capture to land on Messages, where it opens and
 * where most specs work. Nothing else is still loading by then: DuckDB takes
 * the capture only once the SQL console asks for it (see `waitForDatabase`).
 */
export async function openMessagesAfterLoad(page: Page, timeout = 30_000) {
  await page.waitForURL('**/messages', { timeout })
  await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
}

/**
 * On the SQL console, waits until DuckDB holds the capture: the console
 * inserts it on arrival, and its editor is enabled once the insert is done.
 * Waiting for the header's gauge to go would race the request that puts it up.
 */
export async function waitForDatabase(page: Page, timeout = 30_000) {
  await expect(page.getByRole('heading', { name: 'SQL Console' })).toBeVisible()
  await expect(page.locator('textarea').first()).toBeEnabled({ timeout })
  await expect(page.getByTestId('db-load-status')).toHaveCount(0, { timeout })
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
 * The workspace's sessions-and-findings column, with every finding group
 * expanded so each instance and its detail is on the page.
 *
 * Waits for the Findings heading first: reading `innerText` straight after a
 * capture loads is a race, and a negative assertion ("does not say X") would
 * pass against a column that had not rendered yet.
 */
export async function showFindings(page: Page) {
  const rail = page.getByRole('complementary', { name: 'Sessions and findings' })
  await expect(rail.getByRole('heading', { name: /^Findings/ })).toBeVisible()
  // Expanding a group removes it from this selector, so positional locators
  // from `.all()` would shift under the loop; take the first one each time.
  const collapsed = rail.locator('button[aria-expanded="false"]')
  while ((await collapsed.count()) > 0) {
    await collapsed.first().click()
  }
  return rail
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
 * Waits until the packet list shows the filter's answer: no sliced pass in
 * flight (a capture over 20,000 packets filters after a pause), and the count
 * the same on two looks in a row. A capture below that size is filtered in the
 * render that takes the keystroke, so this usually returns at once — where a
 * fixed wait, long enough for the DuckDB debounce this used to sit out, cost
 * over a second per filter across the whole suite.
 */
export async function listSettled(page: Page) {
  await expect(page.getByText('filtering...')).toHaveCount(0)
  const counter = page.getByText(/Showing \d+ of \d+ packets/).first()
  let last = await counter.textContent()
  await expect
    .poll(
      async () => {
        const now = await counter.textContent()
        const same = now === last
        last = now
        return same
      },
      { intervals: [50] }
    )
    .toBe(true)
}

/** Types a filter expression and waits until the list shows its answer. */
export async function applyFilter(page: Page, expression: string) {
  const input = page.locator('input[type="text"]').first()
  await input.click()
  await input.fill(expression)
  await page.keyboard.press('Escape')
  await listSettled(page)
}

/**
 * Runs a query in the SQL console and returns the view's text once it settles.
 * The view only: the sessions column beside it lists addresses, and their
 * digits would answer assertions about the result table.
 */
export async function runSql(page: Page, sql: string): Promise<string> {
  await waitForDatabase(page)
  const editor = page.locator('textarea').first()
  await editor.click()
  await editor.fill(sql)
  await page.keyboard.press('Control+Enter')
  await expect(page.getByText(/Results \(|Error:/).first()).toBeVisible()
  // The result and its table land in one render; the button says Run again
  // once the query has finished.
  await expect(page.getByRole('button', { name: /Running/ })).toHaveCount(0)
  return page.getByRole('main').innerText()
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
  // The builder has no spec for EVPN NLRI, so the routes are written as bytes
  // and carried in RAW path attributes; everything around them — the session,
  // its OPENs and the TCP underneath — is the builder's.
  const ip4 = (address: string) => address.split('.').map(Number)
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  const rd = (address: string, n: number) => [0, 1, ...ip4(address), n >> 8, n & 0xff]
  const vni = (v: number) => [(v << 4) >> 16, ((v << 4) >> 8) & 0xff, (v << 4) & 0xff]
  const mac = (text: string) => text.split(':').map((byte) => parseInt(byte, 16))
  const nlri = (type: number, value: number[]) => [type, value.length, ...value]

  const macRoute = (leaf: string, id: number, address: string, tag: number) =>
    nlri(2, [...rd(leaf, id), ...new Array(10).fill(0), ...u32(0), 48, ...mac(address), 0, ...vni(tag)])
  const imet = (leaf: string, id: number) => nlri(3, [...rd(leaf, id), ...u32(0), 32, ...ip4(leaf)])

  // Route Target 65002:100 and the VXLAN encapsulation community, on every route.
  const extendedCommunities = [0x00, 0x02, 0xfd, 0xea, ...u32(100), 0x03, 0x0c, 0, 0, 0, 0, 0, 8]

  const announce = (nextHop: string, routes: number[], as: number): BgpMessageSpec => ({
    type: 'UPDATE',
    pathAttributes: [
      { type: 'ORIGIN', value: 'IGP' },
      { type: 'AS_PATH', segments: [{ asNumbers: [as] }] },
      // MP_REACH_NLRI for L2VPN/EVPN (AFI 25 / SAFI 70), and the communities.
      { type: 'RAW', flags: 0x80, typeCode: 14, value: Uint8Array.from([0, 25, 70, 4, ...ip4(nextHop), 0, ...routes]) },
      { type: 'RAW', flags: 0xc0, typeCode: 16, value: Uint8Array.from(extendedCommunities) },
    ],
  })
  const withdraw = (routes: number[]): BgpMessageSpec => ({
    type: 'UPDATE',
    pathAttributes: [{ type: 'RAW', flags: 0x80, typeCode: 15, value: Uint8Array.from([0, 25, 70, ...routes]) }],
  })

  // 4-byte AS and MP-BGP for L2VPN/EVPN only. Stated in full because the
  // default would offer IPv4 unicast, which a pure EVPN fabric peering does not.
  const evpn = (asNumber: number): CapabilitySpec[] => [
    { type: 'FOUR_OCTET_AS', asNumber },
    { type: 'MULTIPROTOCOL', afi: 25, safi: 70 },
  ]
  const leaf1 = { ip: '10.0.0.1', as: 65001, routerId: '10.0.0.1', holdTime: 90, capabilities: evpn(65001) }
  const leaf2 = { ip: '10.0.0.2', as: 65002, routerId: '10.0.0.2', holdTime: 90, capabilities: evpn(65002) }
  const host = '00:0c:29:aa:bb:cc'

  const built = buildScenario({
    a: leaf1,
    b: leaf2,
    startTime: new Date('2025-12-01T00:00:00Z'),
    gap: 10,
    steps: [
      ...establish(),
      { kind: 'send', from: 'b', messages: [announce(leaf2.ip, [...imet(leaf2.ip, 100), ...imet(leaf2.ip, 200)], 65002)], gap: 1000 },
      { kind: 'send', from: 'b', messages: [announce(leaf2.ip, macRoute(leaf2.ip, 100, host, 10100), 65002)], gap: 2000 },
      // The host moves: leaf2 withdraws it a minute later, leaf1 picks it up.
      { kind: 'send', from: 'b', messages: [withdraw(macRoute(leaf2.ip, 100, host, 10100))], gap: 57_000 },
      { kind: 'send', from: 'a', messages: [announce(leaf1.ip, macRoute(leaf1.ip, 100, host, 10100), 65001)], gap: 2000 },
    ],
  })
  return Buffer.from(built.bytes)
}

/**
 * A pcapng whose first packets claim more captured bytes than they carry, so
 * the parser produces warnings. Built from the sample rather than committed as
 * a second fixture, so it cannot drift away from it. A pcapng rather than a
 * pcap on purpose: its blocks state their own length, so the parser can skip
 * each damaged packet and carry on — which is the warning these tests read.
 */
export function corruptCapture(sample: Buffer): Buffer {
  return Buffer.from(patchRecord(sample, [1, 2, 3], { capturedLength: (n) => n + 40 }))
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
    a: ROUTER_A,
    b: ROUTER_B,
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
  const a = ROUTER_A
  const b = ROUTER_B

  const built = buildScenario({
    a,
    b,
    gap: 200,
    steps: [
      ...establish(),
      { kind: 'delay', gap: 20_000 },
      { kind: 'reset', from: 'b' },
      { kind: 'delay', gap: 60_000 },
      ...establish(),
      { kind: 'delay', gap: 20_000 },
      { kind: 'close', from: 'b' },
      { kind: 'delay', gap: 60_000 },
      ...establish(),
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
  const a = ROUTER_A
  const b = ROUTER_B

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
      ...establish(),
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

  const short = buildScenario({
    a: { ip: '192.0.2.1', as: 65010, routerId: '10.10.10.10', holdTime: 90 },
    b: { ...local, ip: '192.0.2.100' },
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
            nlri: ['172.20.0.0/16'],
          },
        ],
      },
    ],
  })

  // Two separate sessions in one file, which is what a capture on the router
  // receiving both upstreams actually looks like.
  return Buffer.from(mergeCaptures([short, long]).bytes)
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

  const built = buildScenario({
    a,
    b,
    gap: 200,
    steps: [
      ...establish(),
      { kind: 'send', from: 'a', messages: [END_OF_RIB] },
      { kind: 'delay', gap: 20_000 },
      { kind: 'reset', from: 'a' },
      { kind: 'delay', gap: 25_000 },
      ...establish(),
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
  const a = ROUTER_A
  const b = ROUTER_B
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
      ...establish(),
      { kind: 'delay', gap: 20_000 },
      cease,
      { kind: 'reset', from: 'b' },
      { kind: 'delay', gap: 60_000 },
      ...establish(),
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
    a: ROUTER_A,
    b: ROUTER_B,
    gap: 200,
    steps: [
      ...establish(),
      { kind: 'send', from: 'b', messages: [{ type: 'NOTIFICATION', errorCode: 6, errorSubcode: 2 }] },
    ],
  })
  return Buffer.from(keepSide(full, 'a').bytes)
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
    a: ROUTER_A,
    b: ROUTER_B,
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
    a: ROUTER_A,
    b: { ...ROUTER_B, holdTime: 180 },
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

/**
 * An ADD-PATH session, either working or misconfigured.
 *
 * `'both'` is the ordinary working case: identifiers flow each way and the same
 * prefix arrives twice, once per path. `'send'` is the interesting one — both
 * ends offer to *send* additional paths and neither offers to receive them, so
 * both OPENs name IPv4 unicast under ADD-PATH, a diff of advertisements calls
 * that a match, and nothing carries a Path Identifier in either direction.
 */
export function addPathCapture(sendReceive: 'both' | 'send' = 'both'): Buffer {
  const capabilities = (asNumber: number) => [
    { type: 'MULTIPROTOCOL' as const, afi: 1, safi: 1 },
    { type: 'FOUR_OCTET_AS' as const, asNumber },
    { type: 'ADD_PATH' as const, addressFamilies: [{ afi: 1, safi: 1, sendReceive }] },
  ]
  // Two paths to one prefix when they are actually negotiated; one plain
  // announcement otherwise, since a misconfigured session cannot send them.
  const nlri =
    sendReceive === 'both'
      ? [{ prefix: '10.1.0.0/24', pathId: 1 }, { prefix: '10.1.0.0/24', pathId: 2 }]
      : ['10.1.0.0/24']

  const built = buildScenario({
    a: {
      ip: '10.0.0.1',
      as: 65001,
      routerId: '1.1.1.1',
      holdTime: 90,
      capabilities: capabilities(65001),
    },
    b: {
      ip: '10.0.0.2',
      as: 65002,
      routerId: '2.2.2.2',
      holdTime: 90,
      capabilities: capabilities(65002),
    },
    gap: 200,
    steps: [
      ...establish(),
      {
        kind: 'send',
        from: 'a',
        messages: [announce(nlri, { nextHop: '10.0.0.1', asPath: [65001] }), END_OF_RIB],
      },
      { kind: 'delay', gap: 5000 },
      // Only one of the two paths goes away, which is the withdraw that reads
      // as "the prefix is gone" unless the identifier is on screen.
      ...(sendReceive === 'both'
        ? [
            {
              kind: 'send' as const,
              from: 'a' as const,
              messages: [
                { type: 'UPDATE' as const, withdrawnRoutes: [{ prefix: '10.1.0.0/24', pathId: 2 }] },
              ],
            },
          ]
        : []),
    ],
  })
  return Buffer.from(built.bytes)
}

/**
 * Opens the Sessions tab and waits for its table. The tab is loaded on demand,
 * and until it arrives the previous tab — often the packet list, which also
 * has table rows — is still on screen.
 */
export async function openSessionsTab(page: Page, sessionName?: string) {
  await page.getByRole('link', { name: /^(Sessions|セッション)$/ }).click()
  await page.waitForURL('**/sessions**')
  const sessionTable = page.getByRole('main').locator('table').filter({
    has: page.getByRole('columnheader', { name: /^(Session|セッション)$/ }),
  })
  await expect(sessionTable).toBeVisible()
  if (sessionName !== undefined) {
    await sessionTable.locator('tbody tr').filter({ hasText: sessionName }).click()
  }
  return sessionTable
}
