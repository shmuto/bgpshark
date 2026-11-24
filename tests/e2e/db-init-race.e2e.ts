import { test, expect } from '@playwright/test'
import { evpnCapture, openMessagesAfterLoad, runSql } from './helpers'

/**
 * Asking for the database before it has finished coming up.
 *
 * `initDatabase` publishes the module-level connection that `isInitialized()`
 * reports on, and the schema is a series of CREATE TABLE round trips. For as
 * long as the connection was published before those statements ran, there was a
 * window in which the database said it was ready and had no tables in it —
 * and losing that race meant an insert into a table that did not exist yet, a
 * "Catalog Error: Table with name nlri does not exist" that failed the whole
 * initialization.
 *
 * The database now starts when the SQL console asks for the capture, so the
 * race is the console's own: it arrives, starts DuckDB and hands over the
 * capture in one go. This drops captures at the first moment the input exists
 * and opens the console straight after, repeatedly, because a race that is
 * lost sometimes is not a race that is lost every time — and checks that the
 * database ends up holding the last capture.
 */
const ATTEMPTS = 4

test.describe('the SQL console asking for a database that is still starting', () => {
  test('still ends up with a database that has the capture in it', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(String(e)))

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      // `domcontentloaded`, not `networkidle`: arrive, drop and ask for SQL
      // as early as the page allows.
      await page.goto('./', { waitUntil: 'domcontentloaded' })
      await page.locator('input[type="file"]').first().setInputFiles({
        name: 'race.pcap',
        mimeType: 'application/vnd.tcpdump.pcap',
        buffer: evpnCapture(),
      })
      await openMessagesAfterLoad(page)
      await page.getByRole('link', { name: 'SQL', exact: true }).click()

      // Not merely present but populated: a capture that raced a half-built
      // DuckDB used to land on an empty set of tables.
      const body = await runSql(page, 'select count(*) as n from packets')
      expect(body).not.toContain('Error:')
      expect(body).toMatch(/Results \(1 rows?\)/)
    }

    expect(errors.join('\n')).not.toMatch(/Catalog Error/)
  })
})
