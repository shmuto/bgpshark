import { test, expect } from '@playwright/test'
import { loadSample } from './helpers'

/**
 * What the header and the master–detail screens show before the reader has
 * clicked anything.
 */
test.describe('opening Routes', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
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
})

test.describe('the header', () => {
  test('keeps the capture views in the workspace tabs and the tools behind one menu', async ({ page }) => {
    await loadSample(page)
    const capture = page.getByRole('navigation', { name: 'Capture' })
    await expect(capture.getByRole('link')).toHaveText(['Messages', 'Sessions', 'Routes', 'SQL'])

    const tools = page.getByRole('navigation', { name: 'Tools' })
    await expect(tools).toHaveCount(0)
    await page.getByRole('button', { name: 'More' }).click()
    await expect(tools.getByRole('link', { name: /^Build/ })).toBeVisible()
    await expect(tools.getByRole('link', { name: 'Help', exact: true })).toBeVisible()
  })
})
