import { test, expect } from '@playwright/test'

/**
 * Third-party licence notices.
 *
 * The app fetches nothing from a CDN, which means every typeface and library it
 * uses is copied into the build and served from this origin — the app
 * redistributes them. The SIL Open Font License and the MIT License both require
 * the copyright notice and the licence text to travel with a redistributed copy,
 * so the page carrying them is a shipping requirement rather than a nicety.
 *
 * Two failures are worth guarding against and neither is visible from reading
 * the code. The page can become **unreachable** — a notice nobody can find is
 * not a notice — and it can **drift** from what actually ships, which is what
 * happens when a font is added to the CSS and nobody remembers the Markdown.
 * The font-face test below is the one that catches the second, because it reads
 * the families the browser was really told to load.
 */
test.describe('licence notices', () => {
  test('are reachable from the start screen with nothing loaded', async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await page.getByRole('link', { name: 'licenses', exact: true }).click()

    await expect(page).toHaveURL(/\/licenses$/)
    // Still here, not bounced to the upload screen by a route guard.
    await expect(page.getByRole('heading', { name: 'Licenses', level: 1 })).toBeVisible()
  })

  test('are reachable from the foot of the manual', async ({ page }) => {
    await page.goto('./manual', { waitUntil: 'networkidle' })
    await page.getByRole('link', { name: 'Their licenses' }).click()

    await expect(page).toHaveURL(/\/licenses$/)
    await expect(page.getByRole('heading', { name: 'Licenses', level: 1 })).toBeVisible()
  })

  test('name every font family the app actually loads', async ({ page }) => {
    await page.goto('./licenses', { waitUntil: 'networkidle' })

    // The families the browser was told to download, read from the stylesheet
    // rather than from a list kept alongside it. Self-hosted @font-face rules
    // are what create the obligation, so they are what the page is checked
    // against.
    const families = await page.evaluate(() => {
      const found = new Set<string>()
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try {
          rules = sheet.cssRules
        } catch {
          continue // a cross-origin sheet, which this app should never have
        }
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSFontFaceRule) {
            found.add(rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim())
          }
        }
      }
      return Array.from(found)
    })

    expect(families.length, 'no @font-face rules found — did the CSS load?').toBeGreaterThan(0)

    const body = await page.locator('body').innerText()
    for (const family of families) {
      expect(body, `${family} is served by this app but not credited`).toContain(family)
    }
  })

  test('carry the full licence texts, not just the names', async ({ page }) => {
    await page.goto('./licenses', { waitUntil: 'networkidle' })
    const body = await page.locator('body').innerText()

    // The copyright notices, verbatim from upstream.
    expect(body).toContain('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"')
    expect(body).toContain('Copyright 2020 The JetBrains Mono Project Authors')

    // Both licences require their own text to accompany the copy, so a page
    // listing only the notices would not discharge the obligation.
    expect(body).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007')
    expect(body).toContain('OTHER DEALINGS IN THE FONT SOFTWARE.')
    expect(body).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy')
    expect(body).toContain('The above copyright notice and this permission notice shall be included')

    // The libraries are redistributed the same way the fonts are.
    expect(body).toContain('Copyright (c) Facebook, Inc. and its affiliates.')
    expect(body).toContain('Copyright 2018-2025 Stichting DuckDB Foundation')
  })

  test('are Markdown that became HTML, not text', async ({ page }) => {
    await page.goto('./licenses', { waitUntil: 'networkidle' })

    await expect(page.locator('.manual-prose h2').first()).toBeVisible()
    expect(await page.locator('.manual-prose pre').count()).toBeGreaterThan(0)

    // If the build-time conversion stopped running the page would render its
    // own source, licence text included.
    const body = await page.locator('body').innerText()
    expect(body).not.toContain('## Fonts')
  })

  test('read with nothing asked of the network', async ({ page, baseURL }) => {
    // The point of the page is that the app is self-contained. A licence page
    // that reached for a CDN would be arguing against itself.
    const origin = new URL(baseURL!).origin
    const foreign: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (url.startsWith('data:') || url.startsWith('blob:')) return
      if (!url.startsWith(origin)) foreign.push(url)
    })

    await page.goto('./licenses', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Licenses', level: 1 })).toBeVisible()

    expect(foreign, `unexpected off-origin requests:\n${foreign.join('\n')}`).toEqual([])
  })
})
