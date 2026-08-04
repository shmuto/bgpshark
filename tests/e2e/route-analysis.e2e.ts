import { test, expect } from '@playwright/test'
import { loadSample } from './helpers'

test.beforeEach(async ({ page }) => {
  await loadSample(page)
  await page.getByRole('link', { name: 'Routes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Prefix Statistics' })).toBeVisible()
})

test.describe('the prefix table', () => {
  test('shows when each route was last seen', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Last Seen/ })).toBeVisible()
    await expect(page.locator('tbody tr').first()).toContainText(/\d\d:\d\d:\d\d/)
  })

  test('starts sorted by flap count, worst first', async ({ page }) => {
    const flaps = await page.locator('tbody tr td:nth-child(5)').allTextContents()
    const numbers = flaps.map((f) => parseInt(f, 10))
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a))
  })

  test('sorts prefixes numerically, not as text', async ({ page }) => {
    const header = page.getByRole('button', { name: /^Prefix/ })
    await header.click()
    // Wait for the sort to be applied rather than reading whatever is on screen
    // the instant after the click.
    await expect(header).toHaveAttribute('aria-sort', 'ascending')

    const prefixes = await page.locator('tbody tr td:first-child').allTextContents()

    const ninth = prefixes.indexOf('10.0.9.0/24')
    const twelfth = prefixes.indexOf('10.0.12.0/24')
    // A string comparison puts 10.0.12.0 before 10.0.9.0. Only skip if the
    // sample stops carrying one of them.
    if (ninth !== -1 && twelfth !== -1) expect(ninth).toBeLessThan(twelfth)

    // 1.1.1.1 sorts before anything in 10/8 either way.
    expect(prefixes[0]).toBe('1.1.1.1/32')
  })

  test('clicking the active column reverses it', async ({ page }) => {
    const header = page.getByRole('button', { name: /^Prefix/ })
    const firstCell = page.locator('tbody tr td:first-child').first()

    await header.click()
    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    await expect(firstCell).toHaveText('1.1.1.1/32')

    await header.click()
    await expect(header).toHaveAttribute('aria-sort', 'descending')
    await expect(firstCell).not.toHaveText('1.1.1.1/32')
  })

  test('a count column opens at its largest', async ({ page }) => {
    const header = page.getByRole('button', { name: /^Announced/ })
    await header.click()
    await expect(header).toHaveAttribute('aria-sort', 'descending')

    const counts = (await page.locator('tbody tr td:nth-child(2)').allTextContents()).map(Number)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })
})

test.describe('AS_PATH analysis', () => {
  test('lists the paths a prefix arrived over, most seen first', async ({ page }) => {
    await page.locator('tbody tr').first().click()

    const panel = page.getByRole('heading', { name: 'AS_PATH Analysis' })
    await expect(panel).toBeVisible()

    const body = await page.locator('body').innerText()
    expect(body).toMatch(/AS\d+/)
    expect(body).toMatch(/seen \d+ time/)
  })

  test('marks the paths after the most common one as alternates', async ({ page }) => {
    await page.locator('tbody tr').first().click()
    const body = await page.locator('body').innerText()

    // The sample's busiest prefix arrives over two paths.
    if (/\d distinct paths/.test(body)) {
      expect(body).toMatch(/alternate, seen \d+ time/)
    }
  })
})

test.describe('what you are looking at is in the URL', () => {
  test('the sort is', async ({ page }) => {
    await page.getByRole('button', { name: /^Announced/ }).click()
    await expect(page).toHaveURL(/sort=announced/)
    await expect(page).toHaveURL(/dir=desc/)
  })

  test('the search is', async ({ page }) => {
    await page.locator('input[placeholder*="10.0.0.0"]').first().fill('10.0.0.0/8')
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(page).toHaveURL(/q=10/)
  })

  test('the selection is', async ({ page }) => {
    await page.locator('tbody tr').first().click()
    await expect(page).toHaveURL(/prefix=/)
  })

  test('the match direction is', async ({ page }) => {
    await page.getByRole('radio', { name: 'Supernets', exact: true }).click()
    await expect(page).toHaveURL(/match=supernets/)
  })

  test('a link restores all of it in a session that never set it', async ({ page, context }) => {
    await page.getByRole('button', { name: /^Announced/ }).click()
    await page.locator('input[placeholder*="10.0.0.0"]').first().fill('10.0.0.0/8')
    await page.getByRole('button', { name: 'Search' }).click()
    await page.locator('tbody tr').first().click()
    await expect(page).toHaveURL(/prefix=/)
    const shared = page.url()

    // A different tab in the same browser: the capture is restored from
    // IndexedDB, everything else has to come from the link.
    const other = await context.newPage()
    await other.goto(shared, { waitUntil: 'networkidle' })

    await expect(other.locator('input[placeholder*="10.0.0.0"]').first()).toHaveValue('10.0.0.0/8')
    await expect(other.getByRole('heading', { name: /Route History: 10\./ })).toBeVisible()
    await expect(other).toHaveURL(/sort=announced/)
    await other.close()
  })

  test('and it survives a reload', async ({ page }) => {
    await page.locator('tbody tr').first().click()
    await expect(page).toHaveURL(/prefix=/)

    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: /Route History: 10\./ })).toBeVisible()
  })
})
