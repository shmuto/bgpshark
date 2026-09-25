import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  addPathCapture,
  bestPathCapture,
  evpnCapture,
  gracefulRestartCapture,
  loadCapture,
  routeRefreshCapture,
} from './helpers'

const SAMPLE = new URL('../../public/sample.pcapng', import.meta.url).pathname

/**
 * The two filter backends, asked the same questions and required to agree.
 *
 * A filter expression is evaluated in memory while the query is being typed
 * and while the capture is still loading into DuckDB, and by DuckDB once it has
 * loaded. The packet list shows whichever answered last, so a disagreement is
 * not an edge case: it is the list changing under the reader for no reason
 * they can see. Each backend used to be tested only on its own terms, and they
 * drifted — negation meant "no message has this" in SQL and "some message
 * lacks this" in memory.
 *
 * Nothing here says which answer is right; the rest of the suite does that. It
 * says only that there is one answer. It reaches into the app's own modules
 * through the dev server, which serves `src/` as ES modules, so both backends
 * run exactly as the app runs them, against the same loaded database.
 */

const OPERATORS = ['=', '!=', 'contains', 'not contains'] as const

/** Fields and the values worth asking each about, across the captures below. */
const QUESTIONS: Record<string, string[]> = {
  type: ['UPDATE', 'OPEN', 'KEEPALIVE', 'NOTIFICATION'],
  src_ip: ['10.0.0.1', '10.0.0.0/8', '192.0.2.0/24'],
  dst_ip: ['10.0.0.2', '10.0.0.0/8'],
  src_port: ['179'],
  dst_port: ['179'],
  router_id: ['1.1.1.1', '2.2.2.2'],
  capability: ['ADD_PATH', 'GRACEFUL_RESTART', 'ROUTE_REFRESH'],
  src_as: ['65001', '65002'],
  asn: ['65001', '65002', '65010'],
  origin: ['IGP', 'INCOMPLETE'],
  med: ['0', '300'],
  local_pref: ['100', '200'],
  next_hop: ['10.0.0.2', '192.0.2.1'],
  community: ['65000:80', '65001:999', '65002:100'],
  rt: ['65002:100'],
  ext_community: ['"Route Target 65002:100"', 'Route'],
  mac: ['00:0c:29:aa:bb:cc'],
  rd: ['10.0.0.2:100'],
  vni: ['10100'],
  evpn_type: ['2', '3'],
  prefix: ['10.0.0.0/8', '10.1.0.0/24', '10.0.12.7', '172.16.0.0/12'],
  withdrawn: ['10.0.0.0/8', '10.1.1.0/24'],
}
const ORDERED: Record<string, string[]> = {
  med: ['100'],
  local_pref: ['150'],
  src_as: ['65001'],
  asn: ['65001'],
  frame: ['10'],
}

function expressions(): string[] {
  const out: string[] = []
  for (const [field, values] of Object.entries(QUESTIONS)) {
    for (const value of values) for (const op of OPERATORS) out.push(`${field} ${op} ${value}`)
  }
  for (const [field, values] of Object.entries(ORDERED)) {
    for (const value of values) for (const op of ['<', '<=', '>', '>=']) out.push(`${field} ${op} ${value}`)
  }
  // Composition, where a negation inside `and`/`or`/`not` has to mean the same.
  out.push('not type = KEEPALIVE', 'type = UPDATE and community != 65001:999', 'not (prefix = 10.0.0.0/8)')
  return out
}

/** Every expression the two backends answer differently, with both answers. */
async function disagreements(page: Page, bytes: Buffer): Promise<string[]> {
  return page.evaluate(
    async ({ data, queries }) => {
      const base = '/bgpshark/src/lib'
      const { parsePcap, isPcapng, parsePcapng } = await import(`${base}/pcap/index.ts`)
      const { parseBgpFromPackets } = await import(`${base}/bgp/index.ts`)
      const { parseQuery, matchPacket } = await import(`${base}/filter/index.ts`)
      const { getMatchingFrameIndexes, isDataLoaded } = await import(`${base}/db/index.ts`)
      if (!isDataLoaded()) return ['DuckDB did not load this capture']

      const buffer = new Uint8Array(data).buffer
      const pcap = isPcapng(buffer) ? parsePcapng(buffer) : parsePcap(buffer)
      const packets = parseBgpFromPackets(pcap.packets).packets as Array<{ frameIndex: number }>

      const out: string[] = []
      for (const query of queries) {
        const parsed = parseQuery(query)
        if (parsed.errors.length > 0) {
          out.push(`${query}: does not parse (${parsed.errors[0].message})`)
          continue
        }
        const memory = packets.filter((p) => matchPacket(p as never, parsed)).map((p) => p.frameIndex)
        const sql = await getMatchingFrameIndexes(query)
        const same = memory.length === sql.length && memory.every((frame, i) => frame === sql[i])
        if (!same) out.push(`${query}: memory [${memory.join(',')}] sql [${sql.join(',')}]`)
      }
      return out
    },
    { data: [...bytes], queries: expressions() }
  )
}

const CAPTURES: Array<[string, () => Buffer]> = [
  ['sample.pcapng', () => readFileSync(SAMPLE)],
  ['evpn.pcap', evpnCapture],
  ['best-path.pcap', bestPathCapture],
  ['add-path.pcap', () => addPathCapture()],
  ['route-refresh.pcap', () => routeRefreshCapture()],
  ['graceful-restart.pcap', () => gracefulRestartCapture()],
]

for (const [name, build] of CAPTURES) {
  test(`in memory and in DuckDB, every filter selects the same packets: ${name}`, async ({ page }) => {
    const bytes = build()
    await loadCapture(page, name, bytes)
    await page.waitForURL('**/messages')
    await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
    // The database load finishes after the list appears; wait for it rather
    // than comparing against tables that are still being filled.
    await page.waitForFunction(
      async (url) => (await import(url)).isDataLoaded(),
      '/bgpshark/src/lib/db/index.ts',
      { timeout: 30_000 }
    )

    const differ = await disagreements(page, bytes)
    expect(differ, differ.join('\n')).toEqual([])
  })
}
