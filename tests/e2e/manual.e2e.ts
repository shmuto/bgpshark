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

  test('cross-references inside the prose point at sections that exist', async ({ page }) => {
    // The walkthroughs send the reader back and forth — "see The capture may be
    // lying to you" — and those anchors are hand-written against slugs the build
    // generates. A renamed heading breaks them silently.
    await page.goto('./manual', { waitUntil: 'networkidle' })

    const links = page.locator('.manual-prose a[href^="#"]')
    const count = await links.count()
    expect(count).toBeGreaterThan(0)

    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href')
      await expect(page.locator(`.manual-prose ${href}`), `${href} has no heading`).toHaveCount(1)
    }
  })

  test('every screenshot in the walkthroughs resolves and loads', async ({ page }) => {
    // The images are files in `public/manual/`, referenced from Markdown that
    // becomes a string of HTML — so nothing in the build resolves them, and the
    // base path is applied by hand in `markdownPlugin`. A wrong base or a
    // screenshot that was never regenerated shows up here and nowhere else.
    await page.goto('./manual', { waitUntil: 'networkidle' })

    const images = page.locator('.manual-prose img')
    const count = await images.count()
    expect(count).toBeGreaterThan(5)

    for (let i = 0; i < count; i++) {
      const image = images.nth(i)
      const source = await image.getAttribute('src')
      expect(source, 'screenshots are referenced through the app base path').toMatch(
        /^\/bgpshark\/manual\/[\w-]+\.png$/
      )

      // Loading is deferred, so each one has to be brought into view first.
      await image.scrollIntoViewIfNeeded()
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth), {
          message: `${source} did not load`,
        })
        .toBeGreaterThan(0)

      // A caption, from the alt text: a screenshot of a dense screen without a
      // line saying what to look at is decoration.
      const caption = image.locator('xpath=following-sibling::figcaption')
      await expect(caption).not.toBeEmpty()
    }
  })

  test('a link into a section lands on that section', async ({ page }) => {
    // The content is injected as HTML after the first paint, so the browser's
    // own hash handling has nothing to scroll to when it runs. The page has to
    // do it itself, and this is the assertion that says so.
    await page.goto('./manual#filters', { waitUntil: 'networkidle' })

    // Polled rather than measured after a fixed wait: the page scrolls itself
    // once the HTML is in, and images above the anchor settle into their
    // reserved space around the same time. A sleep long enough on an idle
    // machine is not long enough on a loaded one, and the failure looks like a
    // broken anchor rather than a slow one.
    const offsetOf = () =>
      page.evaluate(() => {
        const top = document.getElementById('filters')?.getBoundingClientRect().top
        return top === undefined ? -9999 : Math.round(top)
      })

    await expect
      .poll(async () => {
        const top = await offsetOf()
        return top > -50 && top < 200
      }, { timeout: 5_000 })
      .toBe(true)

    // Read once more so a later regression reports the number it landed on.
    const offset = await offsetOf()
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

/**
 * The manual in Japanese.
 *
 * The property that matters here is not the prose but the anchors. Section ids
 * are derived from the letters in a heading, and a Japanese heading has none of
 * the ones the slugger keeps — so every id would come out empty, the contents
 * list would be blank, and `/manual#filters` would land at the top of the page.
 * The translated headings therefore name their own ids, and both languages
 * answer to the same links. That is what these tests are for.
 */
test.describe('the manual in Japanese', () => {
  async function switchToJapanese(page: import('@playwright/test').Page) {
    await page.goto('./manual', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '日本語' }).click()
    await expect(page.getByRole('heading', { name: 'BGPShark ユーザーマニュアル' })).toBeVisible()
  }

  test('the toggle switches the prose and the contents list', async ({ page }) => {
    await switchToJapanese(page)

    const contents = page.locator('nav[aria-label="Manual contents"]')
    await expect(contents).toContainText('目次')
    await expect(contents).toContainText('症状から調べる')

    // And back, so the reader is not stranded in a language they cannot read.
    await page.getByRole('button', { name: 'English' }).click()
    await expect(page.getByRole('heading', { name: 'BGPShark user manual' })).toBeVisible()
  })

  test('sections keep the English anchors, so one link serves both languages', async ({ page }) => {
    await switchToJapanese(page)

    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.manual-prose h2[id], .manual-prose h3[id]')).map(
        (heading) => heading.id
      )
    )

    // Not merely non-empty: the same ids the English manual publishes, which is
    // the whole point of naming them by hand.
    expect(ids).toContain('filters')
    expect(ids).toContain('investigating-by-symptom')
    expect(ids).toContain('the-capture-may-be-lying-to-you')
    expect(ids.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true)
  })

  test('the two manuals cover the same sections', async ({ page }) => {
    // A section added to one and forgotten in the other is the failure mode of
    // any translated document, and it is silent without this.
    await page.goto('./manual', { waitUntil: 'networkidle' })
    const english = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.manual-prose h2[id], .manual-prose h3[id]')).map(
        (heading) => heading.id
      )
    )

    await switchToJapanese(page)
    const japanese = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.manual-prose h2[id], .manual-prose h3[id]')).map(
        (heading) => heading.id
      )
    )

    expect(japanese).toEqual(english)
  })

  test('internal links resolve in Japanese too', async ({ page }) => {
    await switchToJapanese(page)

    const links = page.locator('.manual-prose a[href^="#"]')
    const count = await links.count()
    expect(count).toBeGreaterThan(0)

    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href')
      await expect(page.locator(`.manual-prose ${href}`), `${href} has no heading`).toHaveCount(1)
    }
  })

  test('the screenshots are the same files and still resolve', async ({ page }) => {
    // The app's own labels are English, so the pictures are shared rather than
    // re-shot — but a translated caption that named a file that does not exist
    // would break just as quietly as an English one.
    await switchToJapanese(page)

    const images = page.locator('.manual-prose img')
    const count = await images.count()
    expect(count).toBeGreaterThan(0)

    for (let i = 0; i < count; i++) {
      const image = images.nth(i)
      const source = await image.getAttribute('src')

      // Loading is deferred, so each one has to be brought into view first —
      // the same dance the English pass does.
      await image.scrollIntoViewIfNeeded()
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth), {
          message: `${source} did not load`,
        })
        .toBeGreaterThan(0)
    }
  })

  test('the choice is remembered', async ({ page }) => {
    await switchToJapanese(page)
    await page.reload({ waitUntil: 'networkidle' })

    await expect(page.getByRole('heading', { name: 'BGPShark ユーザーマニュアル' })).toBeVisible()
  })
})
