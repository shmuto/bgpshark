import { test, expect } from '@playwright/test'
import { loadCapture, malformedUpdateCapture } from './helpers'

/**
 * The NOTIFICATION data field, decoded rather than dumped.
 *
 * The decoder is unit-tested; what only a browser shows is that the decode
 * reaches the detail view at all, and that the bytes are still there under it —
 * a NOTIFICATION is the message people most want to check an interpretation
 * against.
 */
test.describe('a NOTIFICATION that hands back the offending attribute', () => {
  test.beforeEach(async ({ page }) => {
    await loadCapture(page, 'malformed-update.pcap', malformedUpdateCapture())
    await page.waitForURL('**/messages')
    await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
    await page.getByText('UPDATE Message Error').first().click()
  })

  test('the data field is decoded as the attribute it is', async ({ page }) => {
    const body = await page.locator('body').innerText()

    // The heading is uppercased by CSS, and innerText reports what is rendered,
    // so match without depending on that.
    expect(body).toMatch(/offending attribute/i)
    expect(body).toContain('UNKNOWN(199)')
    // The clear optional bit is the fault, and "Well-known" is the word the
    // subcode itself uses for it — so it must be named, not left to absence.
    expect(body).toContain('Well-known')
    expect(body).toContain('Transitive')
  })

  test('the raw bytes are kept underneath the decode', async ({ page }) => {
    const body = await page.locator('body').innerText()

    expect(body).toContain('Error Data (7 bytes)')
    expect(body).toContain('40 c7 04 de ad be ef')
  })
})
