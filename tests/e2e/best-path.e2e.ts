import { test, expect } from '@playwright/test'
import { applyFilter, bestPathCapture, loadCapture, shownCount } from './helpers'

/**
 * Why traffic for a prefix left by the upstream it did.
 *
 * The capture offers `172.20.0.0/16` twice: a short AS_PATH with MED 300 and no
 * LOCAL_PREF, and a longer one with MED 10 and LOCAL_PREF 200. The longer path
 * wins, and nothing but the attributes says why — which is the whole of S4, and
 * used to be answerable only by writing SQL.
 */
test.describe('the attributes a best path is settled with', () => {
  test('are columns on the route history, so two paths compare side by side', async ({ page }) => {
    await loadCapture(page, 'bestpath.pcap', bestPathCapture())
    await page.waitForURL('**/messages')

    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await page.getByText('172.20.0.0/16').first().click()

    // The panel, not just its heading: the nearest rounded-lg ancestor is the
    // card, which is how `testlab/screenshots.ts` addresses these too.
    const history = page
      .getByText('Route History')
      .first()
      .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    await expect(history).toBeVisible()
    const text = await history.innerText()

    expect(text).toContain('MED')
    expect(text).toContain('LOCAL_PREF')
    expect(text).toContain('Communities')

    // Both announcements, each with its own numbers. The losing path is the one
    // with the *shorter* AS_PATH, which is why the columns have to be there:
    // the winner is only explicable through LOCAL_PREF.
    expect(text).toContain('300')
    expect(text).toContain('200')
    expect(text).toContain('65000:80')
    expect(text).toContain('65000:200')
  })

  test('an attribute that was never sent reads as absent, not as zero', async ({ page }) => {
    // 192.0.2.1 sent no LOCAL_PREF. Showing 0 there would invent a value, and
    // 0 is the one that loses every comparison — the opposite of the truth,
    // which is that the attribute is simply not part of that route.
    await loadCapture(page, 'bestpath.pcap', bestPathCapture())
    await page.waitForURL('**/messages')

    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await page.getByText('172.20.0.0/16').first().click()

    const rows = page.locator('tr').filter({ hasText: '192.0.2.1' })
    await expect(rows.first()).toBeVisible()
    const shortPath = await rows.first().innerText()

    expect(shortPath).toContain('300')
    expect(shortPath).toContain('-')
    expect(shortPath).not.toContain('0\t0')
  })

  test('med and local_pref filter the packet list, through DuckDB', async ({ page }) => {
    // The path that only runs when the database is up, which is the half a unit
    // test cannot reach: `applyFilter` waits past the debounce so what is
    // counted is the database's answer rather than the in-memory one.
    await loadCapture(page, 'bestpath.pcap', bestPathCapture())
    await page.waitForURL('**/messages')

    await applyFilter(page, 'med = 300')
    expect(await shownCount(page)).toBe(1)

    await applyFilter(page, 'med > 100')
    expect(await shownCount(page)).toBe(1)

    await applyFilter(page, 'local_pref = 200')
    expect(await shownCount(page)).toBe(1)

    // Both UPDATEs carry a MED, so this selects the pair.
    await applyFilter(page, 'med >= 10')
    expect(await shownCount(page)).toBe(2)
  })

  test('a route with no LOCAL_PREF is not swept in by a comparison', async ({ page }) => {
    // The trap worth a test of its own: if absent were read as 0, this would
    // select both UPDATEs and quietly answer a different question.
    await loadCapture(page, 'bestpath.pcap', bestPathCapture())
    await page.waitForURL('**/messages')

    await applyFilter(page, 'local_pref < 1000')
    expect(await shownCount(page)).toBe(1)
  })
})
