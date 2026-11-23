import { test, expect } from '@playwright/test'
import { loadSample } from './helpers'

const COMPACT = { width: 480, height: 900 }

/** Width of the pane holding the packet list. */
async function packetListWidth(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const pane = document.querySelector('table[role="grid"]')?.closest('div.flex.flex-col')
    return pane ? Math.round(pane.getBoundingClientRect().width) : 0
  })
}

test.describe('resizable panes', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('dragging the divider resizes the list, and it is remembered', async ({ page }) => {
    const before = await packetListWidth(page)
    const divider = page.getByRole('separator').first()
    const box = (await divider.boundingBox())!

    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + 300, box.y + 200, { steps: 10 })
    await page.mouse.up()

    const after = await packetListWidth(page)
    expect(after).toBeGreaterThan(before + 150)

    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByText(/Showing \d+ of/)).toBeVisible()
    expect(Math.abs((await packetListWidth(page)) - after)).toBeLessThan(40)
  })

  test('arrow keys move it and double-click puts it back', async ({ page }) => {
    const divider = page.getByRole('separator').first()

    await divider.focus()
    const before = await packetListWidth(page)
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    expect(await packetListWidth(page)).toBeLessThan(before)

    await divider.dblclick()
    // The packet list's default share is 60% of the split it sits in — the
    // view area, which no longer spans the window now that the sessions
    // column is beside it.
    const initial = await page.evaluate(() => {
      const split = document.querySelector('table[role="grid"]')?.closest('div.flex.flex-col')?.parentElement
      return Math.round((split?.getBoundingClientRect().width ?? 0) * 0.6)
    })
    expect(Math.abs((await packetListWidth(page)) - initial)).toBeLessThan(40)
  })

  test('there is no divider when only one pane is on screen', async ({ page }) => {
    await page.setViewportSize(COMPACT)
    await expect(page.getByRole('separator').first()).toBeHidden()
  })
})

test.describe('compact viewport', () => {
  test.use({ viewport: COMPACT })

  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('the packet list gets the whole screen, then the detail does', async ({ page }) => {
    // Stacking both at half height left neither readable.
    expect(await packetListWidth(page)).toBeGreaterThan(COMPACT.width - 40)

    await page.locator('[role="row"]').nth(3).click()
    await expect(page.getByText(/Packet #\d+/)).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Relative' })).toBeHidden()

    await page.getByRole('button', { name: /Back to list/i }).click()
    await expect(page.getByRole('columnheader', { name: 'Relative' })).toBeVisible()
  })

  test('the route screen swaps the same way', async ({ page }) => {
    await page.goto('./routes', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Prefix Statistics' })).toBeVisible()

    await page.locator('tbody tr').first().click()
    await expect(page.getByRole('heading', { name: /Route History/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Prefix Statistics' })).toBeHidden()

    await page.getByRole('button', { name: /Back to list/i }).click()
    await expect(page.getByRole('heading', { name: 'Prefix Statistics' })).toBeVisible()
  })

  test('the neighbors screen swaps the same way', async ({ page }) => {
    await page.goto('./neighbors', { waitUntil: 'networkidle' })
    await page.locator('tbody tr').first().click()
    await expect(page.getByText('Message Summary')).toBeVisible()

    await page.getByRole('button', { name: /Back to routers/i }).click()
    await expect(page.getByRole('columnheader', { name: /Router ID/ })).toBeVisible()
  })

  test('the navigation is still reachable and nothing overflows sideways', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'SQL', exact: true })).toBeVisible()

    for (const path of ['messages', 'neighbors', 'routes', 'sql']) {
      await page.goto(`./${path}`, { waitUntil: 'networkidle' })
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      )
      expect(overflows, `${path} overflows horizontally`).toBe(false)
    }
  })
})

test.describe('crossing the breakpoint', () => {
  test('a selection made wide lands on the detail when narrowed', async ({ page }) => {
    await loadSample(page)
    await page.goto('./routes', { waitUntil: 'networkidle' })
    await page.locator('tbody tr').first().click()

    await page.setViewportSize(COMPACT)
    await expect(page.getByRole('heading', { name: /Route History/ })).toBeVisible()
  })

  test('widening again brings both panes back', async ({ page }) => {
    await loadSample(page)
    await page.setViewportSize(COMPACT)
    await page.goto('./routes', { waitUntil: 'networkidle' })

    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.getByRole('heading', { name: 'Prefix Statistics' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Route History/ })).toBeVisible()
  })
})

test.describe('standard laptop widths', () => {
  for (const width of [1440, 1280]) {
    test(`at ${width}px the packet list fits its pane and Columns stays reachable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await loadSample(page)

      const { table, pane } = await page.evaluate(() => {
        const grid = document.querySelector('table[role="grid"]') as HTMLElement
        return { table: grid.scrollWidth, pane: grid.parentElement!.clientWidth }
      })
      expect(table).toBeLessThanOrEqual(pane)

      const columns = page.getByRole('button', { name: 'Configure columns' })
      await expect(columns).toBeInViewport()
      await columns.click()
      await expect(page.getByText('Visible Columns')).toBeVisible()
    })

    test(`at ${width}px the route history stays inside the window`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await loadSample(page)
      await page.getByRole('link', { name: 'Routes', exact: true }).click()
      await page.locator('tbody tr').first().click()
      await expect(page.getByRole('heading', { name: 'AS_PATH Analysis' })).toBeVisible()

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      await expect(page.getByText(/distinct paths?/)).toBeInViewport()
    })
  }
})
