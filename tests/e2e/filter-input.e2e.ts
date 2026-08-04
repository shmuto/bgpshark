import { test, expect } from '@playwright/test'
import { loadSample, shownCount } from './helpers'

test.describe('the filter box', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
    await page.getByRole('button', { name: 'Advanced' }).click()
  })

  test('Enter after a finished word leaves the query alone', async ({ page }) => {
    // The suggestion list also opens on complete input, as a hint about what
    // could come next. With the first entry pre-selected, this turned
    // "type = NOTIFICATION and" into "type = NOTIFICATION type".
    const input = page.locator('input[type="text"]').first()
    await input.click()
    await input.pressSequentially('type = NOTIFICATION and', { delay: 20 })
    await page.keyboard.press('Enter')

    await expect(input).toHaveValue('type = NOTIFICATION and')
  })

  test('a suggestion the user arrows into is still accepted by Enter', async ({ page }) => {
    const input = page.locator('input[type="text"]').first()
    await input.click()
    await input.pressSequentially('type = ', { delay: 20 })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(input).toHaveValue('type = OPEN')
  })

  test('a typed filter applies', async ({ page }) => {
    const input = page.locator('input[type="text"]').first()
    await input.click()
    await input.fill('type = NOTIFICATION')
    await page.keyboard.press('Escape')

    await expect.poll(() => shownCount(page)).toBe(9)
  })

  test('a half-typed query is not flagged while you are still typing', async ({ page }) => {
    const input = page.locator('input[type="text"]').first()
    await input.click()
    await input.pressSequentially('type = ', { delay: 20 })

    // Every incomplete expression is a syntax error; saying so immediately means
    // the box is red for most of the time spent typing.
    await expect(input).not.toHaveClass(/border-critical/)

    // It still gets reported once the typing stops.
    await expect(input).toHaveClass(/border-critical/, { timeout: 5_000 })
  })

  test('the rule builder is reachable', async ({ page }) => {
    await page.getByRole('button', { name: 'Simple' }).click()
    await page.getByRole('button', { name: /Add Filter/ }).click()
    await expect(page.getByRole('combobox').first()).toBeVisible()
  })

  test('All Packets shows the non-BGP frames too', async ({ page }) => {
    const bgpOnly = await shownCount(page)
    await page.getByRole('button', { name: 'All Packets' }).click()
    await expect.poll(() => shownCount(page)).toBeGreaterThan(bgpOnly)
  })
})
