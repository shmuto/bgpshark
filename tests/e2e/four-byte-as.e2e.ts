import { test, expect } from '@playwright/test'
import { buildScenario } from '../../src/lib/build'
import { applyFilter, loadCapture, runSql, shownCount } from './helpers'

/**
 * Values above 2^31 - 1, in every column that holds one.
 *
 * BGP is full of unsigned 32-bit fields — 4-byte AS numbers, MED, LOCAL_PREF,
 * the three parts of a large community, the EVPN Ethernet Tag — and the
 * parsers read them as unsigned. The DuckDB schema used to declare those
 * columns INTEGER, which is *signed* 32-bit, so the first value past
 * 2,147,483,647 failed the whole load with a conversion error and took the SQL
 * console down with it.
 *
 * That range is not exotic. RFC 6996 reserves 4200000000–4294967294 for
 * private use, which is exactly where a data-centre fabric numbers its leaves,
 * and 4294967295 is the ceiling of a large community's every field.
 */
const PEER_AS = 4_200_000_002
const PRIVATE_TOP = 4_294_967_294

function fourByteCapture(): Buffer {
  const capture = buildScenario({
    a: { ip: '10.0.0.1', as: 4_200_000_001, routerId: '1.1.1.1' },
    b: { ip: '10.0.0.2', as: PEER_AS, routerId: '2.2.2.2' },
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      {
        kind: 'send',
        from: 'b',
        messages: [
          {
            type: 'UPDATE',
            pathAttributes: [
              { type: 'ORIGIN', value: 'IGP' },
              { type: 'AS_PATH', segments: [{ asNumbers: [PEER_AS, PRIVATE_TOP] }] },
              { type: 'NEXT_HOP', address: '10.0.0.2' },
              { type: 'MULTI_EXIT_DISC', value: 4_000_000_000 },
              { type: 'LOCAL_PREF', value: 3_000_000_000 },
              { type: 'AGGREGATOR', asNumber: PEER_AS, address: '2.2.2.2' },
              { type: 'LARGE_COMMUNITIES', communities: [[PEER_AS, 4_294_967_295, 3_500_000_000]] },
            ],
            nlri: ['192.0.2.0/24'],
          },
        ],
      },
    ],
  })
  return Buffer.from(capture.bytes)
}

test.describe('4-byte AS numbers and other unsigned 32-bit values', () => {
  test.beforeEach(async ({ page }) => {
    await loadCapture(page, 'four-byte-as.pcap', fourByteCapture())
    await page.waitForURL('**/messages')
    await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
    // A failed DuckDB load is reported as a warning and filtering quietly
    // falls back to memory, where these values were always right — so without
    // this, the filter test below would pass against the very schema it
    // exists to catch.
    await expect(page.getByText(/warnings? loading this capture/)).toBeHidden()
  })

  test('load into DuckDB with their values intact', async ({ page }) => {
    await page.getByRole('link', { name: 'SQL', exact: true }).click()
    await expect(page.getByText(/could not be loaded into DuckDB/)).toBeHidden()

    const body = await runSql(
      page,
      `select
         (select max(my_as) from messages)              as my_as,
         (select max(cap_as_number) from capabilities)  as cap_as,
         (select max(asn) from as_path)                 as path_asn,
         (select max(med_value) from path_attributes)   as med,
         (select max(local_pref) from path_attributes)  as local_pref,
         (select max(aggregator_as) from path_attributes) as aggregator,
         (select max(local_data1) from large_communities) as lc_local1,
         (select max(local_data2) from large_communities) as lc_local2`
    )
    expect(body).not.toContain('Error:')
    for (const value of [PEER_AS, PRIVATE_TOP, 4_000_000_000, 3_000_000_000, 4_294_967_295, 3_500_000_000]) {
      expect(body).toContain(String(value))
    }
  })

  test('filter on them through the database', async ({ page }) => {
    // One UPDATE carries the high ASN, one OPEN advertises the peer's.
    await applyFilter(page, `asn = ${PRIVATE_TOP}`)
    expect(await shownCount(page)).toBe(1)

    await applyFilter(page, `src_as = ${PEER_AS}`)
    expect(await shownCount(page)).toBe(1)

    await applyFilter(page, 'med > 3000000000')
    expect(await shownCount(page)).toBe(1)

    await applyFilter(page, 'local_pref = 3000000000')
    expect(await shownCount(page)).toBe(1)
  })
})
