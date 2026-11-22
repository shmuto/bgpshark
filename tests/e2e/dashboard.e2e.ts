import { test, expect } from '@playwright/test'

/**
 * The first screen after a capture loads, and how much of it the alerts may
 * take up.
 */
test.describe('landing on a freshly loaded capture', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /sample/i }).first().click()
    await page.waitForURL('**/dashboard')
    await expect(page.getByRole('heading', { name: /^Alerts/ })).toBeVisible()
  })

  test('opens on the overview, with neighbours and timeline on the first screen', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'BGP Neighbors' })).toBeInViewport()
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeInViewport()
  })

  test('states packets and messages apart, and each type count opens Messages', async ({ page }) => {
    const strip = page.getByTestId('summary-strip')
    // One TCP segment can carry several messages, so the two totals differ and
    // the strip must say which is which rather than set them side by side.
    await expect(strip).toContainText(/\d+\s*BGP packets\s*\(\d+ messages\)/)
    // A capture without a teardown says so; one without ROUTE-REFRESH says nothing.
    await expect(strip.getByRole('button', { name: /^NOTIFICATION \d+$/ })).toBeVisible()
    await expect(strip.getByRole('button', { name: /^ROUTE-REFRESH/ })).toHaveCount(0)

    await strip.getByRole('button', { name: /^UPDATE \d+$/ }).click()
    await page.waitForURL(/\/messages\?filter=type%3DUPDATE/)
  })

  test('the neighbour table counts messages and says so', async ({ page }) => {
    await expect(page.getByRole('columnheader', { name: 'Msgs' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Pkts' })).toHaveCount(0)
  })

  test('shows the five worst alerts and folds the rest', async ({ page }) => {
    const views = page.getByRole('button', { name: 'View →' })
    await expect(views).toHaveCount(5)

    const more = page.getByRole('button', { name: /Show \d+ more alerts?/ })
    const hidden = Number((await more.textContent())?.match(/\d+/)?.[0])
    await more.click()
    await expect(views).toHaveCount(5 + hidden)
    await expect(page.getByRole('button', { name: 'Show fewer' })).toBeVisible()
  })

  test('a connection collision is not ranked as a failure', async ({ page }) => {
    await page.getByRole('button', { name: /Show \d+ more alerts?/ }).click()
    const collision = page.getByRole('listitem').filter({ hasText: 'Connection Collision Resolution' }).first()
    await expect(collision).toContainText('🟡')
    // The teardown that caused the reconnect is what the list leads with.
    await expect(page.getByRole('listitem').first()).toContainText('Hard Reset')
  })

  test('different paths from iBGP and eBGP peers are not an AS_PATH change', async ({ page }) => {
    await page.getByRole('button', { name: /Show \d+ more alerts?/ }).click()
    await expect(page.getByText('(no AS_PATH)')).toHaveCount(0)
  })
})
