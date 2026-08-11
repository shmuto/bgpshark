import { test, expect } from '@playwright/test'

/**
 * The user manual.
 *
 * Two properties here are structural rather than cosmetic, and both are easy to
 * break without noticing. The manual must be readable with **no capture
 * loaded** — the reader most likely to want it has just arrived and has nothing
 * open, and every other screen redirects that person to the upload page. And
 * its content must survive the build: the Markdown is converted to HTML by a
 * Vite plugin, so a plugin that silently stopped running would leave the page
 * rendering its own source.
 */
test.describe('the user manual', () => {
  test('opens from the header with nothing loaded', async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await page.getByRole('link', { name: 'Help', exact: true }).click()

    await expect(page).toHaveURL(/\/manual$/)
    // Still on the manual, not bounced to the upload screen by a route guard.
    await expect(page.getByRole('heading', { name: 'BGPShark user manual' })).toBeVisible()
  })

  test('the Markdown became HTML, not text', async ({ page }) => {
    await page.goto('./manual', { waitUntil: 'networkidle' })

    // Real elements, which is what the build-time conversion produces.
    await expect(page.locator('.manual-prose h2').first()).toBeVisible()
    expect(await page.locator('.manual-prose table').count()).toBeGreaterThan(0)
    expect(await page.locator('.manual-prose pre code').count()).toBeGreaterThan(0)

    // If the plugin stopped running, the page would show the raw source.
    const body = await page.locator('body').innerText()
    expect(body).not.toContain('## The screens')
    expect(body).not.toContain('|--------|')
  })

  test('the contents list is built from the headings and scrolls to them', async ({ page }) => {
    await page.goto('./manual', { waitUntil: 'networkidle' })

    const toc = page.getByRole('navigation', { name: 'Manual contents' })
    await expect(toc).toBeVisible()

    const entries = toc.getByRole('link')
    const count = await entries.count()
    expect(count).toBeGreaterThan(5)

    // Every entry must point at a heading that exists — the failure this
    // guards is a table of contents that drifted from the prose.
    for (let i = 0; i < count; i++) {
      const href = await entries.nth(i).getAttribute('href')
      expect(href).toMatch(/^#/)
      await expect(page.locator(`${href}`)).toHaveCount(1)
    }
  })

  test('a link into a section lands on that section', async ({ page }) => {
    // The content is injected as HTML after the first paint, so the browser's
    // own hash handling has nothing to scroll to when it runs. The page has to
    // do it itself, and this is the assertion that says so.
    await page.goto('./manual#filters', { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)

    const offset = await page.evaluate(
      () => document.getElementById('filters')?.getBoundingClientRect().top ?? -9999
    )
    expect(offset).toBeGreaterThan(-50)
    expect(offset).toBeLessThan(200)
  })

  test('reading the manual asks nothing of the network', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const foreign: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (url.startsWith('data:') || url.startsWith('blob:')) return
      if (!url.startsWith(origin)) foreign.push(url)
    })

    await page.goto('./manual', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'BGPShark user manual' })).toBeVisible()

    expect(foreign, `unexpected off-origin requests:\n${foreign.join('\n')}`).toEqual([])
  })
})
