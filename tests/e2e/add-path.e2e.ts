import { test, expect } from '@playwright/test'
import { addPathCapture, loadCapture } from './helpers'

/**
 * ADD-PATH, which is invisible in an UPDATE and decided in the OPEN.
 *
 * Two facts, and they are not the same fact. Whether *this route* arrived with
 * a Path Identifier is per-NLRI and shows up on the route; whether the session
 * negotiated ADD-PATH at all is per direction and per address family and shows
 * up on the neighbour screen. A capture can answer the second and still have
 * nothing to say about the first, and the two failures they diagnose are
 * different ones.
 */
test.describe('routes that arrived with a Path Identifier', () => {
  test('two paths to one prefix are two routes, not a repeated one', async ({ page }) => {
    await loadCapture(page, 'add-path.pcap', addPathCapture())
    await page.waitForURL('**/messages')

    // The UPDATE carrying both paths.
    await page.getByRole('row').filter({ hasText: 'UPDATE' }).first().click()

    const detail = page.locator('body')
    await expect(detail).toContainText('10.1.0.0/24 path 1')
    await expect(detail).toContainText('10.1.0.0/24 path 2')
  })

  test('the route history says which path went away', async ({ page }) => {
    // The capture withdraws path 2 and leaves path 1 up. Without the identifier
    // the history reads as an announce and a withdraw of the same route — the
    // prefix going away, which is not what happened.
    await loadCapture(page, 'add-path.pcap', addPathCapture())
    await page.waitForURL('**/messages')
    await page.getByRole('link', { name: 'Routes' }).click()
    await page.getByText('10.1.0.0/24').first().click()

    const history = page.locator('body')
    await expect(history).toContainText('Path ID')
    // Three events: two announces and the withdraw, each naming its path. The
    // emoji keeps this off the Prefix Statistics header, which also has an
    // "Announced" and a "Withdrawn" in it.
    const rows = page.getByRole('row').filter({ hasText: /🟢 Announce|🔴 Withdraw/ })
    await expect(rows).toHaveCount(3)
    await expect(rows.filter({ hasText: 'Withdraw' })).toContainText('2')
  })
})

test.describe('what ADD-PATH was actually negotiated', () => {
  test('two ends that both only send are reported, though the capabilities match', async ({
    page,
  }) => {
    // Both OPENs name IPv4 unicast under ADD-PATH, so a comparison of what each
    // side advertised finds nothing wrong — and no Path Identifier is sent in
    // either direction. The advertisement diff and the outcome disagree here,
    // and the outcome is the one that answers "why am I only getting one path".
    await loadCapture(page, 'add-path-send.pcap', addPathCapture('send'))
    await page.waitForURL('**/messages')
    await page.getByRole('link', { name: 'Neighbors' }).click()
    await page.getByText('1.1.1.1').first().click()
    await page.getByText(/10\.0\.0\.\d+ ↔ 10\.0\.0\.\d+/).first().click()

    const diff = page.locator('body')
    await expect(diff).toContainText('No capability mismatches detected')
    await expect(diff).toContainText('ADD-PATH Result')
    await expect(diff).toContainText('did not advertise receive for this family')
    await expect(diff).not.toContainText('Sent')
  })

  test('a working session says so, in both directions', async ({ page }) => {
    await loadCapture(page, 'add-path.pcap', addPathCapture())
    await page.waitForURL('**/messages')
    await page.getByRole('link', { name: 'Neighbors' }).click()
    await page.getByText('1.1.1.1').first().click()
    await page.getByText(/10\.0\.0\.\d+ ↔ 10\.0\.0\.\d+/).first().click()

    // One row per direction, both negotiated.
    const rows = page.getByRole('row').filter({ hasText: 'IPv4 / Unicast' })
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'Sent' })).toHaveCount(2)
  })
})
