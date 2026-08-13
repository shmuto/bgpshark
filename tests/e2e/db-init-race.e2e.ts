import { test, expect } from '@playwright/test'
import { evpnCapture, runSql } from './helpers'

/**
 * Dropping a capture before DuckDB has finished coming up.
 *
 * `initDatabase` publishes the module-level connection that `isInitialized()`
 * reports on, and the schema is a series of CREATE TABLE round trips. For as
 * long as the connection was published before those statements ran, there was a
 * window in which the database said it was ready and had no tables in it — and
 * the app asks exactly that question before handing a freshly parsed capture to
 * `loadPackets`. Losing the race meant an insert into a table that did not exist
 * yet, a "Catalog Error: Table with name nlri does not exist" that failed the
 * whole initialization, and an upload screen that sat on "Parsing file..."
 * forever because the state machine never reached `ready`.
 *
 * The window is real but short, so this drops the file at the first moment the
 * input exists — no waiting for the network to settle, which is what the other
 * specs do and what kept them mostly on the winning side of it — and repeats,
 * because a race that is lost sometimes is not a race that is lost every time.
 */
const ATTEMPTS = 4

test.describe('a capture dropped while the database is still starting', () => {
  test('still ends up with a database that has the capture in it', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(String(e)))

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      // `domcontentloaded`, not `networkidle`: the point is to arrive while the
      // wasm is still being fetched and instantiated.
      await page.goto('./', { waitUntil: 'domcontentloaded' })
      await page.locator('input[type="file"]').first().setInputFiles({
        name: 'race.pcap',
        mimeType: 'application/vnd.tcpdump.pcap',
        buffer: evpnCapture(),
      })

      // The failure this exists for is a screen that never leaves the upload
      // page, so reaching the explorer at all is half the assertion.
      await page.waitForURL('**/messages')
      await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
    }

    // And the other half: the database is not merely present but populated.
    // A capture that raced past a half-built DuckDB used to land here with the
    // in-memory evaluator and an empty set of tables behind the SQL console.
    await page.getByRole('link', { name: 'SQL', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'SQL Console' })).toBeVisible()

    const body = await runSql(page, 'select count(*) as n from packets')
    expect(body).not.toContain('Error:')
    expect(body).toMatch(/Results \(1 rows?\)/)

    expect(errors.join('\n')).not.toMatch(/Catalog Error/)
  })
})
