import { test, expect } from '@playwright/test'
import { applyFilter, goToDashboard, loadSample, shownCount } from './helpers'

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

test.describe('a withdrawal opened from elsewhere', () => {
  // The links filter by the route's prefix; DuckDB used to read `prefix` as
  // announcements only, so the withdrawal the link selected was filtered out.
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('a Withdraw row in Route History opens that withdrawal', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await page.getByText('1.1.1.1/32').first().click()
    await expect(page.getByRole('heading', { name: 'Route History: 1.1.1.1/32' })).toBeVisible()
    await page.getByRole('row').filter({ hasText: '🔴 Withdraw' }).first().click()

    await page.waitForURL('**/messages**')
    // Past the DuckDB debounce, so the answer is the database's.
    await page.waitForTimeout(1200)
    await expect(page.getByText(/^Packet #\d+$/)).toBeVisible()
    await expect(page.getByText('Withdrawn').first()).toBeVisible()
  })

  test('a Route flapping alert opens the withdrawal it names', async ({ page }) => {
    await goToDashboard(page)
    await page
      .getByRole('listitem')
      .filter({ hasText: 'Route flapping: 1.1.1.1/32' })
      .getByRole('button', { name: 'View →' })
      .click()

    await page.waitForURL('**/messages**')
    await page.waitForTimeout(1200)
    await expect(page.getByText(/^Packet #\d+$/)).toBeVisible()
  })

  test('nlri still means announcements only', async ({ page }) => {
    await applyFilter(page, 'prefix = 1.1.1.1/32')
    const both = await shownCount(page)
    await applyFilter(page, 'nlri = 1.1.1.1/32')
    expect(await shownCount(page)).toBeLessThan(both)
  })
})
