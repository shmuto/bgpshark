import { test, expect } from '@playwright/test'
import { applyFilter, loadSample } from './helpers'

/**
 * The packet list's Info column, which also carries an UPDATE's prefixes.
 *
 * Prefixes used to sit in a column of their own, with Info beside it restating
 * them as counts ("2 withdrawn") or restating the Type column ("4 msgs"). One
 * column now says it once.
 */
test.describe('the Info column', () => {
  test('an UPDATE shows its prefixes, and nothing restates them', async ({ page }) => {
    await loadSample(page)
    await applyFilter(page, 'type = UPDATE')

    await expect(page.getByRole('columnheader', { name: 'Info' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Prefix', exact: true })).toHaveCount(0)
    const rows = page.locator('tbody [role="row"]')
    await expect(rows.first()).toContainText(/\d+\.\d+\.\d+\.\d+\/\d+/)
    await expect(rows.filter({ hasText: /\d+ msgs|\d+ withdrawn|\d+ announced/ })).toHaveCount(0)
  })

  test('a saved column set that kept Prefix keeps seeing prefixes', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('bgpshark-visible-columns', JSON.stringify(['index', 'type', 'prefix']))
    })
    await loadSample(page)
    await applyFilter(page, 'type = UPDATE')

    await expect(page.getByRole('columnheader', { name: 'Info' })).toBeVisible()
    await expect(page.locator('tbody [role="row"]').first()).toContainText(/\d+\.\d+\.\d+\.\d+\/\d+/)
  })

  test('the filter is cleared from inside the box, with no second button', async ({ page }) => {
    await loadSample(page)
    await applyFilter(page, 'type = UPDATE')
    await expect(page.getByRole('button', { name: 'Clear Filter', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear filter', exact: true }).click()
    await expect(page.locator('input[type="text"]').first()).toHaveValue('')
  })
})
