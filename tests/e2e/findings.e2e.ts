import { test, expect } from '@playwright/test'
import { loadSample, prefixCount, showFindings, shownCount } from './helpers'

/**
 * The workspace's left column: the sessions in the capture and what went wrong
 * in them, beside every view instead of on a dashboard in front of them.
 */
test.describe('findings beside the views', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('one hard reset on three sessions reads as one finding, not sixteen rows', async ({ page }) => {
    const rail = await showFindings(page)
    await expect(rail.getByRole('heading', { name: /^Findings/ })).toContainText('4 kinds · 16 alerts')

    const groups = rail.getByRole('region', { name: 'Findings' }).locator('li > div > button')
    await expect(groups).toHaveCount(4)
    // Worst first: the teardown that caused everything else leads.
    await expect(groups.first()).toContainText('Hard Reset')
    await expect(groups.first()).toContainText('3 sessions')
  })

  test('a connection collision is informational and listed last', async ({ page }) => {
    const rail = await showFindings(page)
    const groups = rail.getByRole('region', { name: 'Findings' }).locator('li > div > button')
    await expect(groups.last()).toContainText('Connection Collision Resolution')
    await expect(groups.last()).toContainText('Info:')
  })

  test('different paths from iBGP and eBGP peers are not an AS_PATH change', async ({ page }) => {
    await showFindings(page)
    await expect(page.getByText('(no AS_PATH)')).toHaveCount(0)
    await expect(page.getByText(/AS_PATH changed/)).toHaveCount(0)
  })
})

test.describe('choosing a session', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('narrows the list and the findings, and says so once', async ({ page }) => {
    expect(await shownCount(page)).toBe(50)
    const rail = page.getByRole('complementary', { name: 'Sessions and findings' })
    await rail.getByRole('button', { name: /^1\.1\.1\.1 ↔ 2\.2\.2\.2/ }).click()

    await expect(page.getByTestId('session-scope')).toHaveText('1.1.1.1 ↔ 2.2.2.2')
    await expect.poll(() => shownCount(page)).toBe(17)
    await expect(rail.getByRole('heading', { name: /^Findings/ })).toContainText('8 alerts')

    await page.getByRole('button', { name: 'Show all sessions' }).click()
    await expect(page.getByTestId('session-scope')).toHaveCount(0)
    await expect.poll(() => shownCount(page)).toBe(50)
  })

  test('the scope follows the reader to another tab', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes' }).click()
    const all = await prefixCount(page)

    await page
      .getByRole('complementary', { name: 'Sessions and findings' })
      .getByRole('button', { name: /^10\.0\.13\.1 ↔ 10\.0\.13\.3/ })
      .click()
    await expect(page.getByTestId('session-scope')).toBeVisible()
    await expect.poll(() => prefixCount(page)).toBeLessThanOrEqual(all)

    await page.getByRole('link', { name: 'Messages' }).click()
    await expect(page.getByTestId('session-scope')).toHaveText('10.0.13.1 ↔ 10.0.13.3')
  })
})
