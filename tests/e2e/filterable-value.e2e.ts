import { test, expect } from '@playwright/test'
import { loadSample } from './helpers'

test.describe('apply-as-filter buttons in the packet detail', () => {
  test('on Source and Destination they sit left of the address, clear of the port', async ({ page }) => {
    await loadSample(page)
    await page.locator('tbody [role="row"]').first().click()

    const add = page.getByRole('button', { name: /^Add to filter: src_ip = / })
    const value = add.locator('xpath=../..')
    await value.hover()
    await expect(add).toBeVisible()

    const buttons = (await add.locator('xpath=..').boundingBox())!
    const address = (await value.boundingBox())!
    // Entirely to the left of the address, so nothing covers ":port".
    expect(buttons.x + buttons.width).toBeLessThanOrEqual(address.x + 1)
  })

  test('a filterable value is marked before it is hovered', async ({ page }) => {
    await loadSample(page)
    await page.locator('tbody [role="row"]').first().click()
    const text = page.getByRole('button', { name: /^Add to filter: src_ip = / }).locator('xpath=../../span[1]')
    await expect(text).toHaveCSS('text-decoration-style', 'dotted')
  })
})
