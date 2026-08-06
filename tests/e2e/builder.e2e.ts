import { test, expect } from '@playwright/test'

/**
 * The builder is the one screen that works with no capture loaded, and the one
 * whose output has to survive a round trip through the rest of the app. Both of
 * those are only really testable here: the unit tests prove the bytes decode,
 * but not that the screen reaches them, that the route is not swallowed by the
 * capture guard, or that a built file loads into the analyzer.
 */
test.describe('the capture builder', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./builder', { waitUntil: 'networkidle' })
  })

  test('opens with no capture loaded and previews the default scenario', async ({ page }) => {
    // The analysis screens redirect to the upload page without a capture. This
    // one must not — producing a capture is the reason you are here.
    await expect(page).toHaveURL(/\/builder$/)
    await expect(page.getByRole('heading', { name: 'Build a capture' })).toBeVisible()

    await expect(page.getByText(/\d+ frames · .* · \d+ BGP messages/)).toBeVisible()
    await expect(page.getByRole('cell', { name: 'OPEN' }).first()).toBeVisible()
  })

  test('reaches the preview from the upload screen', async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await page.getByRole('link', { name: 'Build one' }).click()

    await expect(page).toHaveURL(/\/builder$/)
  })

  test('rebuilds when the scenario changes', async ({ page }) => {
    const source = page.getByRole('cell', { name: '10.0.0.1:51000' }).first()
    await expect(source).toBeVisible()

    await page.getByLabel('IP address').first().fill('192.0.2.7')

    await expect(page.getByRole('cell', { name: '192.0.2.7:51000' }).first()).toBeVisible()
    await expect(source).not.toBeVisible()
  })

  test('switching scenario changes what the capture contains', async ({ page }) => {
    await page.getByRole('combobox').first().selectOption('connection-refused')

    // The TCP-rejected scenario has no BGP in it at all — that is its point.
    await expect(page.getByText(/0 BGP messages/)).toBeVisible()
    await expect(page.getByRole('cell', { name: /RST/ }).first()).toBeVisible()
  })

  test('a NOTIFICATION scenario previews the message that ends the session', async ({ page }) => {
    await page.getByRole('combobox').first().selectOption('bad-peer-as')

    await expect(page.getByRole('cell', { name: 'NOTIFICATION' }).first()).toBeVisible()
  })

  test('a built capture loads into the analyzer', async ({ page }) => {
    await page.getByRole('combobox').first().selectOption('flap')
    await page.getByRole('button', { name: 'Open in analyzer' }).click()

    await page.waitForURL('**/messages')
    await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()

    // The route analysis screen should see the flapping prefix the scenario
    // announced and withdrew five times.
    await page.getByRole('link', { name: 'Routes' }).click()
    await expect(page.getByText('10.9.9.0/24').first()).toBeVisible()
  })

  test('reports a bad address instead of crashing', async ({ page }) => {
    await page.getByLabel('IP address').first().fill('not-an-address')

    await expect(page.getByText(/Not an IP address/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download .pcap' })).toBeDisabled()
  })

  test('an added step shows up in the built capture', async ({ page }) => {
    await page.getByRole('combobox').first().selectOption('established');

    const before = await frameCount(page)

    await page.getByRole('button', { name: '+ TCP reset (RST)' }).click()

    await expect.poll(() => frameCount(page)).toBe(before + 1)
    await expect(page.getByRole('cell', { name: /RST/ }).first()).toBeVisible()
  })
})

async function frameCount(page: import('@playwright/test').Page): Promise<number> {
  const text = await page.getByText(/\d+ frames ·/).first().textContent()
  return Number(text?.match(/(\d+) frames/)?.[1] ?? -1)
}
