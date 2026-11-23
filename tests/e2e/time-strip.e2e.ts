import { test, expect, type Page } from '@playwright/test'
import { loadSample, prefixCount, shownCount } from './helpers'

/** Drags across the time strip between two fractions of its width. */
async function dragStrip(page: Page, from: number, to: number) {
  const strip = page.getByRole('group', { name: /Messages over time/ })
  const box = (await strip.boundingBox())!
  await page.mouse.move(box.x + box.width * from, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * to, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
}

/**
 * The strip across the top of the workspace: message volume over time, and a
 * time window that narrows every view the way a session scope does.
 */
test.describe('the time strip', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('dragging narrows the list to that window, and Show all puts it back', async ({ page }) => {
    expect(await shownCount(page)).toBe(50)

    // The sample's teardown and reconnect burst sits a little past half way.
    await dragStrip(page, 0.55, 0.62)
    await expect(page.getByTestId('time-window')).toHaveText(/^\d+\.\d+s–\d+\.\d+s$/)
    await expect.poll(() => shownCount(page)).toBeLessThan(50)
    await expect.poll(() => shownCount(page)).toBeGreaterThan(0)

    await page.getByRole('button', { name: 'Show all' }).click()
    await expect(page.getByTestId('time-window')).toHaveCount(0)
    await expect.poll(() => shownCount(page)).toBe(50)
  })

  test('a click without a drag clears the window', async ({ page }) => {
    await dragStrip(page, 0.55, 0.62)
    await expect(page.getByTestId('time-window')).toBeVisible()
    await dragStrip(page, 0.3, 0.3)
    await expect(page.getByTestId('time-window')).toHaveCount(0)
  })

  test('the window follows the reader to Routes, and combines with a session', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    const all = await prefixCount(page)

    // Before any UPDATE was sent: no routes in the window.
    await dragStrip(page, 0.02, 0.3)
    await expect.poll(() => prefixCount(page)).toBe(0)

    await page.getByRole('button', { name: 'Show all' }).click()
    await expect.poll(() => prefixCount(page)).toBe(all)

    await page.getByRole('link', { name: 'Messages', exact: true }).click()
    await page
      .getByRole('complementary', { name: 'Sessions and findings' })
      .getByRole('button', { name: /^1\.1\.1\.1 ↔ 2\.2\.2\.2/ })
      .click()
    await expect.poll(() => shownCount(page)).toBe(17)
    await dragStrip(page, 0.55, 0.62)
    await expect.poll(() => shownCount(page)).toBeLessThan(17)
  })
})

test.describe('a window that hides what a link asks for', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('a finding outside the window widens it and selects its packet', async ({ page }) => {
    // Findings look at the whole capture; the window narrows the lists only.
    // A finding whose packet fell outside the window used to open on a list
    // that could not hold it, and then jump there the moment the reader
    // pressed Show all, long after.
    await dragStrip(page, 0.02, 0.3)
    await expect(page.getByTestId('time-window')).toBeVisible()

    const rail = page.getByRole('complementary', { name: 'Sessions and findings' })
    await rail.getByRole('button', { name: /^10\.0\.14\.1 → 10\.0\.14\.4/ }).first().click()

    await expect(page.getByTestId('time-window')).toHaveCount(0)
    await expect(page.getByText(/^Packet #\d+$/)).toHaveText('Packet #39')
  })
})
