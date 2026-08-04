import { test, expect } from '@playwright/test'
import { applyFilter, loadSample, prefixCount, shownCount } from './helpers'

/**
 * The filter DSL and the route analysis screen have to answer the same question
 * the same way. They used to have three separate implementations that disagreed.
 */
test.describe('prefix matching', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('a CIDR selects the routes inside it', async ({ page }) => {
    // The sample announces 10.0.12.0/24 and friends, never a literal 10.0.0.0/8.
    // Under the old string comparison this matched nothing.
    await applyFilter(page, 'prefix = 10.0.0.0/8')
    expect(await shownCount(page)).toBeGreaterThan(0)
  })

  test('a bare address selects the routes covering it', async ({ page }) => {
    await applyFilter(page, 'prefix = 10.0.12.7')
    const covering = await shownCount(page)
    expect(covering).toBeGreaterThan(0)

    await applyFilter(page, 'prefix = 10.0.0.0/8')
    expect(covering).toBeLessThanOrEqual(await shownCount(page))
  })

  test('an unrelated block matches nothing', async ({ page }) => {
    await applyFilter(page, 'prefix = 172.16.0.0/12')
    expect(await shownCount(page)).toBe(0)
  })

  test('negation is the complement', async ({ page }) => {
    await applyFilter(page, 'prefix = 10.0.0.0/8')
    const matching = await shownCount(page)

    await applyFilter(page, 'prefix != 10.0.0.0/8')
    expect(await shownCount(page)).toBe(50 - matching)
  })

  test('an IP field honours the mask to the bit', async ({ page }) => {
    // Whole-octet matching would have made these two agree.
    await applyFilter(page, 'src_ip = 10.0.13.0/30')
    expect(await shownCount(page)).toBeGreaterThan(0)

    await applyFilter(page, 'src_ip = 10.0.13.4/30')
    expect(await shownCount(page)).toBe(0)
  })

  test('withdrawn routes are searched the same way', async ({ page }) => {
    await applyFilter(page, 'withdrawn = 10.0.0.0/8')
    expect(await shownCount(page)).toBeGreaterThan(0)
  })

  test('the route screen agrees with the filter for the same text', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await page.locator('input[placeholder*="10.0.0.0"]').first().fill('10.0.0.0/8')
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(page.getByText(/\d+ prefixes/)).toBeVisible()
    expect(await prefixCount(page)).toBeGreaterThan(0)
  })
})

test.describe('prefix search on the route screen', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Prefix Statistics' })).toBeVisible()
  })

  const search = async (page: import('@playwright/test').Page, text: string) => {
    await page.locator('input[placeholder*="10.0.0.0"]').first().fill(text)
    await page.getByRole('button', { name: 'Search' }).click()
    await page.waitForTimeout(400)
    return prefixCount(page)
  }

  test('routes are identified by prefix and mask length', async ({ page }) => {
    // Keying on the address alone merged /24 and /23 into one row and summed
    // their counts.
    await expect(page.getByText('10.0.12.0/24')).toBeVisible()
  })

  test('the placeholder example finds something', async ({ page }) => {
    expect(await search(page, '10.0.0.0/8')).toBeGreaterThan(0)
  })

  test('an AS number finds the prefixes it carried', async ({ page }) => {
    expect(await search(page, 'AS65001')).toBeGreaterThan(0)
  })

  /** Picks a match direction and waits until the list has been recomputed. */
  const setMatch = async (page: import('@playwright/test').Page, name: string) => {
    const radio = page.getByRole('radio', { name, exact: true })
    await radio.click()
    await expect(radio).toBeChecked()
    await page.waitForTimeout(400)
    return prefixCount(page)
  }

  test('Supernets finds the route carrying a block nobody announces', async ({ page }) => {
    // 10.0.12.0/28 is announced by nobody, but it lives inside 10.0.12.0/24.
    // Searching downwards can never say so, which is what the direction is for.
    expect(await search(page, '10.0.12.0/28')).toBe(0)

    expect(await setMatch(page, 'Supernets')).toBeGreaterThan(0)
    await expect(page.getByText('10.0.12.0/24')).toBeVisible()
  })

  test('Exact match is the prefix and mask length typed', async ({ page }) => {
    await search(page, '10.0.0.0/8')
    // Nothing announces a literal 10.0.0.0/8, so exact match finds nothing.
    expect(await setMatch(page, 'Exact')).toBe(0)
  })

  test('the direction survives a reload', async ({ page }) => {
    await search(page, '10.0.12.0/28')
    const found = await setMatch(page, 'Supernets')

    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByRole('radio', { name: 'Supernets', exact: true })).toBeChecked()
    expect(await prefixCount(page)).toBe(found)
  })

  test('the Search button is what commits the query', async ({ page }) => {
    const before = await search(page, '10.0.0.0/8')

    await page.locator('input[placeholder*="10.0.0.0"]').first().fill('2.2.2.2')
    await page.waitForTimeout(400)
    expect(await prefixCount(page)).toBe(before)

    await page.getByRole('button', { name: 'Search' }).click()
    await page.waitForTimeout(400)
    expect(await prefixCount(page)).not.toBe(before)
  })

  test('emptying the box restores the full list without pressing anything', async ({ page }) => {
    const all = await prefixCount(page)
    await search(page, '2.2.2.2')
    await page.locator('input[placeholder*="10.0.0.0"]').first().fill('')
    await page.waitForTimeout(400)
    expect(await prefixCount(page)).toBe(all)
  })
})
