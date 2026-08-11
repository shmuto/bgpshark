import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { corruptCapture, evpnCapture, loadCapture, loadSample, runSql } from './helpers'

const SAMPLE = new URL('../../public/sample.pcapng', import.meta.url).pathname

/**
 * The app makes no third-party requests. The README says so, the production
 * CSP enforces it (`connect-src 'self' blob: data:`), and this is the test
 * that keeps it true.
 *
 * It exists because it once was not. The DuckDB loader inserted rows through
 * `read_json_auto`, and the JSON reader is a DuckDB *extension* — fetched from
 * `extensions.duckdb.org` the first time it is used. In development that
 * download succeeds and everything looks fine; behind the production CSP it
 * cannot, so loading any capture failed and the SQL console was dead on the
 * deployed site. The whole end-to-end suite missed it, because it drives the
 * dev server, and the dev server ships no CSP.
 *
 * So the assertion is not "the CSP is configured" — it is "nothing was asked
 * of the network", which holds whether or not a policy is there to catch it.
 */
test.describe('the app makes no third-party requests', () => {
  test('loading a capture and querying it stays on our own origin', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const foreign: string[] = []

    page.on('request', (request) => {
      const url = request.url()
      // data: and blob: are the app's own bytes under another name.
      if (url.startsWith('data:') || url.startsWith('blob:')) return
      if (!url.startsWith(origin)) foreign.push(`${request.method()} ${url}`)
    })

    await loadSample(page)

    // The SQL console is where the extension fetch used to be triggered, so
    // getting a real answer out of it is part of the assertion rather than a
    // second test: a query that returns rows proves the loader populated the
    // tables without the JSON reader.
    await page.getByRole('link', { name: 'SQL', exact: true }).click()
    const body = await runSql(page, 'select count(*) as n from packets')
    expect(body).not.toContain('Error:')
    expect(body).toContain('Results (1 rows)')

    expect(foreign, `unexpected off-origin requests:\n${foreign.join('\n')}`).toEqual([])
  })

  test('every table the loader writes is populated, extension-free', async ({ page }) => {
    // EVPN exercises the widest set of columns — list columns, nullable
    // integers, the extended-community strings — which is where a transport
    // that is not JSON is most likely to differ from one that was.
    await loadCapture(page, 'evpn-fabric.pcap', evpnCapture())
    await page.waitForURL('**/messages')
    await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()

    await page.getByRole('link', { name: 'SQL', exact: true }).click()
    const body = await runSql(
      page,
      `select
         (select count(*) from packets)              as packets,
         (select count(*) from messages)             as messages,
         (select count(*) from nlri)                 as nlri,
         (select count(*) from withdrawn)            as withdrawn,
         (select count(*) from extended_communities) as ext_comms,
         (select count(*) from as_path)              as as_path`
    )
    expect(body).not.toContain('Error:')
    // A zero in any of these is the failure mode this guards: a load that
    // "succeeded" into empty tables reads as "no packets matched" everywhere.
    expect(body).not.toMatch(/\b0\b/)
  })

  test('a capture with parse warnings still loads its list column', async ({ page }) => {
    // parse_warnings is VARCHAR[], the one column whose literal form differs
    // most between JSON and VALUES — and it is empty on a clean capture, so a
    // capture that actually warns is the only place the difference shows.
    await loadCapture(page, 'truncated.pcapng', corruptCapture(readFileSync(SAMPLE)))
    await expect(page.getByText(/warnings? loading this capture/)).toBeVisible()

    await page.getByRole('link', { name: 'SQL', exact: true }).click()
    const body = await runSql(
      page,
      'select count(*) as rows_loaded, coalesce(max(len(parse_warnings)), 0) as widest from packets'
    )
    expect(body).not.toContain('Error:')
    expect(body).toContain('Results (1 rows)')
  })
})
