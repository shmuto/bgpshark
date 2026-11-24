import { test, expect, type Page } from '@playwright/test'
import { applyFilter, listSettled, loadSample } from './helpers'

/** The Relative cell of the list row for a frame, as shown. */
async function relativeOf(page: Page, frame: string): Promise<string> {
  const row = page.locator('tbody [role="row"]').filter({
    has: page.locator('td:first-child', { hasText: new RegExp(`^${frame}$`) }),
  })
  return (await row.locator('td').nth(1).textContent())?.trim() ?? ''
}

test.describe('one time axis across filters and screens', () => {
  test('Relative counts from the capture start, whatever the filter', async ({ page }) => {
    await loadSample(page)
    await applyFilter(page, 'type = NOTIFICATION')

    const firstRow = page.locator('tbody [role="row"]').first()
    const frame = ((await firstRow.locator('td').first().textContent()) ?? '').trim()
    const filtered = await relativeOf(page, frame)
    // The first NOTIFICATION is not the first frame of the capture, so a
    // clock that restarted at the first row of the filtered list would read 0.
    expect(filtered).not.toBe('0.000')

    await page.getByRole('button', { name: 'Clear filter', exact: true }).click()
    await listSettled(page)
    await page.locator('input[type="text"]').first().fill(`frame = ${frame}`)
    await listSettled(page)
    expect(await relativeOf(page, frame)).toBe(filtered)
  })

  test('absolute times say they are UTC', async ({ page }) => {
    await loadSample(page)
    await page.locator('tbody [role="row"]').first().click()
    await expect(page.getByText('Time (UTC)')).toBeVisible()
    await expect(page.getByText('Since capture start')).toBeVisible()
    await expect(page.getByText('Δ previous on session')).toBeVisible()
  })

  test('Route History reads oldest first and can be reversed', async ({ page }) => {
    await loadSample(page)
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await page.locator('tbody tr').first().click()
    const history = page.locator('table').last()
    const header = page.getByRole('button', { name: /Time \(UTC\)/ })
    await expect(header).toBeVisible()

    const times = async () => history.locator('tbody tr td:first-child').allTextContents()
    const ascending = await times()
    expect(ascending).toEqual([...ascending].sort())

    await header.click()
    await expect(page.locator('th[aria-sort="descending"]')).toBeVisible()
    expect(await times()).toEqual([...ascending].reverse())
  })
})
