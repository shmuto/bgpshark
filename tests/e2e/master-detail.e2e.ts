import { test, expect } from '@playwright/test'
import { loadSample } from './helpers'

/**
 * What the header and the master–detail screens show before the reader has
 * clicked anything.
 */
test.describe('opening Neighbors and Routes', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('Neighbors opens on its busiest router instead of a blank pane', async ({ page }) => {
    await page.getByRole('link', { name: 'Neighbors', exact: true }).click()
    await expect(page).toHaveURL(/router=/)
    await expect(page.getByText('Select a router to view details')).toHaveCount(0)
    await expect(page.getByText('Sessions', { exact: true })).toBeVisible()
  })

  test('Routes opens on its first prefix', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await expect(page).toHaveURL(/prefix=/)
    await expect(page.getByRole('heading', { name: /^Route History: / })).toBeVisible()
  })

  test('the row picked for the reader is not a step Back has to undo', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await expect(page).toHaveURL(/prefix=/)
    await page.goBack()
    await expect(page).toHaveURL(/\/messages/)
  })

  test('a link that names a row keeps it', async ({ page }) => {
    await page.goto('./routes?prefix=10.0.12.0%2F24', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Route History: 10.0.12.0/24' })).toBeVisible()
  })

  test('closing the detail leaves it closed', async ({ page }) => {
    await page.getByRole('link', { name: 'Neighbors', exact: true }).click()
    await expect(page).toHaveURL(/router=/)
    await page.getByRole('button', { name: /close/i }).first().click()
    await expect(page).not.toHaveURL(/router=/)
    await page.waitForTimeout(300)
    await expect(page).not.toHaveURL(/router=/)
  })
})

test.describe('on a narrow screen', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the list is what opens, not a detail nobody asked for', async ({ page }) => {
    await loadSample(page)
    await page.goto('./neighbors', { waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    await expect(page).not.toHaveURL(/router=/)
    await expect(page.locator('tbody tr').first()).toBeVisible()
  })
})

test.describe('the header', () => {
  test('separates the capture screens from Build and Help', async ({ page }) => {
    await loadSample(page)
    const capture = page.getByRole('navigation', { name: 'Capture' })
    const tools = page.getByRole('navigation', { name: 'Tools' })
    await expect(capture.getByRole('link')).toHaveText(['Dashboard', 'Messages', 'Neighbors', 'Routes', 'SQL'])
    await expect(tools.getByRole('link')).toHaveText(['Build', 'Help'])
  })
})
