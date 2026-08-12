import { test, expect } from '@playwright/test'

/**
 * The third-party licence notices.
 *
 * Self-hosting the fonts is what makes the "no third-party requests" promise
 * true, and it is also what turns using them into redistributing them: the SIL
 * Open Font License asks that the copyright notice and the licence text
 * accompany the copy, and every visitor's browser downloads a copy.
 *
 * The notices are a static file, which needs no test — but the *relationship*
 * between that file and the CSS does. The realistic regression is not a page
 * that broke; it is a fifth @font-face added to `index.css` by someone who did
 * not know a text file three directories away had to change too. So this reads
 * the families the browser was actually told to download and asserts the served
 * file names each one. Nothing here checks prose.
 */
test('every self-hosted font family is credited in THIRD-PARTY-LICENSES.txt', async ({
  page,
  baseURL,
}) => {
  await page.goto('./', { waitUntil: 'networkidle' })

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

  // Fetched over HTTP rather than read off disk: the file is only useful if it
  // is actually served, and `public/` reaching the build is the other half of
  // what this asserts.
  const response = await page.request.get(new URL('THIRD-PARTY-LICENSES.txt', baseURL!).href)
  expect(response.status(), 'the licence file is not being served').toBe(200)
  const notices = await response.text()

  for (const family of families) {
    expect(notices, `${family} is served by this app but not credited`).toContain(family)
  }

  // The licence text itself, not just the names — the notices alone would not
  // discharge either licence.
  expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1')
  expect(notices).toContain('The above copyright notice and this permission notice shall be included')
})
