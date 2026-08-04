import { test, expect } from '@playwright/test'
import { loadSample } from './helpers'

/**
 * The capture is restored from IndexedDB after the first render, so for a moment
 * "no capture" and "we have not looked yet" are the same state. Redirecting
 * during that moment threw away every deep link, reload and bookmark.
 */
test.describe('deep links and reloads', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  for (const path of ['dashboard', 'neighbors', 'routes', 'sql']) {
    test(`opening /${path} directly stays there`, async ({ page }) => {
      await page.goto(`./${path}`, { waitUntil: 'networkidle' })
      await expect(page).toHaveURL(new RegExp(`/${path}$`))
    })
  }

  test('reloading keeps the screen you were on', async ({ page }) => {
    await page.goto('./dashboard', { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('a ?selected= link survives and selects the packet', async ({ page }) => {
    await page.goto('./messages?selected=12', { waitUntil: 'networkidle' })
    await expect(page.getByText(/Packet #\d+/)).toBeVisible()
    // The filter effect used to replace the whole query string and drop this.
    await expect(page).toHaveURL(/selected=12/)
  })

  test('a dashboard alert opens the packet it names', async ({ page }) => {
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
    await page.getByText(/^View/).first().click()
    await expect(page).toHaveURL(/\/messages/)
    await expect(page.getByText(/Packet #\d+/)).toBeVisible()
  })
})

test.describe('without a capture', () => {
  test('the upload screen takes over, then hands back the route asked for', async ({ page }) => {
    // A fresh context has nothing in IndexedDB.
    await page.goto('./routes', { waitUntil: 'networkidle' })
    await expect(page.getByText('Drop pcap file here')).toBeVisible()

    await page.getByRole('button', { name: /sample/i }).first().click()
    await expect(page).toHaveURL(/\/routes$/)
  })

  test('a file that is not a capture is refused by extension', async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is not a capture'),
    })
    await expect(page.getByText(/Invalid file type/)).toBeVisible()
  })

  test('a corrupt capture reports why', async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'broken.pcap',
      mimeType: 'application/vnd.tcpdump.pcap',
      buffer: Buffer.from('garbage that is definitely not a pcap header'),
    })
    await expect(page.getByText(/unrecognized magic number/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try Again' })).toBeVisible()
  })
})
