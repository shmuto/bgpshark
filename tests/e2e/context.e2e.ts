import { test, expect } from '@playwright/test'
import { applyFilter, loadSample, shownCount } from './helpers'

/**
 * The small things that made every packet and every screen change a fresh
 * start: attributes collapsed again, filters gone after a look at another tab.
 */
test.describe('reading packet details', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('UPDATE attributes are open, and stay as the reader left them', async ({ page }) => {
    await applyFilter(page, 'type = UPDATE')
    await page.locator('tbody [role="row"]').first().click()
    await expect(page.getByText(/Click to collapse/).first()).toBeVisible()

    await page.getByText(/Click to collapse/).first().click()
    await expect(page.getByText(/Click for details/).first()).toBeVisible()

    // The next packet keeps the reader's choice instead of resetting it.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByText(/Click to collapse/)).toHaveCount(0)
  })

  test('a KEEPALIVE says how much of the hold time its gap used', async ({ page }) => {
    await applyFilter(page, 'type = KEEPALIVE')
    await page.locator('tbody [role="row"]').last().click()
    await expect(page.getByText(/previous message to/)).toBeVisible()
    await expect(page.getByText('Negotiated hold time')).toBeVisible()
  })
})

test.describe('moving between screens', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('Messages keeps its filter and selection across a visit to another tab', async ({ page }) => {
    await applyFilter(page, 'type = NOTIFICATION')
    const filtered = await shownCount(page)
    await page.locator('tbody [role="row"]').nth(2).click()
    const frame = (await page.locator('tbody [role="row"]').nth(2).locator('td').first().textContent())?.trim()

    await page.getByRole('link', { name: 'Neighbors', exact: true }).click()
    await page.waitForURL('**/neighbors**')
    await page.getByRole('link', { name: 'Messages', exact: true }).click()

    await expect(page).toHaveURL(/filter=/)
    await expect.poll(() => shownCount(page)).toBe(filtered)
    await expect(page.getByText(`Packet #${frame}`)).toBeVisible()
  })

  test('a route history row opens Messages narrowed to that route', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await page.locator('tbody tr').first().click()
    await expect(page.getByRole('heading', { name: /Route History: / })).toBeVisible()
    await page.locator('table').last().locator('tbody tr').first().click()

    await page.waitForURL('**/messages**')
    expect(new URL(page.url()).searchParams.get('filter')).toMatch(/^prefix = [\d.]+\/\d+$/)
    await expect(page.getByText(/^Packet #\d+$/)).toBeVisible()
  })
})
