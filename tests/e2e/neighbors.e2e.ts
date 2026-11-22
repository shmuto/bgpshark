import { test, expect } from '@playwright/test'
import { loadSample } from './helpers'

test.describe('the neighbours screen', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
    await page.getByRole('link', { name: 'Neighbors', exact: true }).click()
    await page.locator('tbody tr').first().click()
  })

  test('selecting a session puts its Capability Diff on the first screen', async ({ page }) => {
    await page.getByText(/↔ 10\.0\.13\.3/).first().click()

    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('10.0.13.1 ↔ 10.0.13.3')
    await expect(page.getByText('🔍 Capability Diff')).toBeInViewport()
    // One message list for the session, not a second timeline beneath it.
    await expect(page.getByText(/Session Timeline/)).toHaveCount(0)

    await page.getByRole('button', { name: '← Router overview' }).click()
    await expect(page.getByText('🔗 Sessions')).toBeVisible()
    await expect(page).not.toHaveURL(/peer=/)
  })

  test('an announced prefix opens its route history', async ({ page }) => {
    const chip = page.getByRole('button', { name: /^\d+\.\d+\.\d+\.\d+\/\d+$/ }).first()
    const prefix = (await chip.textContent())!.trim()
    await chip.click()

    await page.waitForURL('**/routes**')
    await expect(page.getByRole('heading', { name: `Route History: ${prefix}` })).toBeVisible()
  })

  test('the router list says its count is what was sent', async ({ page }) => {
    await expect(page.getByRole('columnheader', { name: 'Sent' })).toBeVisible()
  })
})
