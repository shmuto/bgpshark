import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { corruptCapture, loadCapture } from './helpers'

const SAMPLE = new URL('../../public/sample.pcapng', import.meta.url).pathname

test.describe('parser warnings', () => {
  test('a capture the parser struggled with says so', async ({ page }) => {
    // WarningBanner existed but was never rendered, so everything the parser
    // noticed had nowhere to go.
    await loadCapture(page, 'truncated.pcapng', corruptCapture(readFileSync(SAMPLE)))

    const banner = page.getByText(/warnings? during parsing/)
    await expect(banner).toBeVisible()

    // Specific enough not to also match the file name in the header chip.
    // The corrupted blocks are now skipped individually rather than
    // desynchronizing the whole stream, so the warning names the skip.
    await banner.click()
    await expect(page.getByText(/block skipped/).first()).toBeVisible()
  })

  test('a clean capture shows no banner', async ({ page }) => {
    await loadCapture(page, 'sample.pcapng', readFileSync(SAMPLE))
    await expect(page.getByText(/Showing \d+ of/)).toBeVisible()
    await expect(page.getByText(/warnings? during parsing/)).toBeHidden()
  })
})

test.describe('nothing goes wrong quietly', () => {
  test('no console errors or unhandled rejections while walking every screen', async ({ page }) => {
    const problems: string[] = []
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
    page.on('pageerror', (e) => problems.push(e.message))

    await loadCapture(page, 'sample.pcapng', readFileSync(SAMPLE))
    await expect(page.getByText(/Showing \d+ of/)).toBeVisible()

    for (const name of ['Dashboard', 'Neighbors', 'Routes', 'SQL', 'Messages']) {
      await page.getByRole('link', { name, exact: true }).click()
      await page.waitForTimeout(800)
    }

    expect(problems).toEqual([])
  })
})
