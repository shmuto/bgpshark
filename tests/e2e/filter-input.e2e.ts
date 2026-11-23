import { test, expect } from '@playwright/test'
import { applyFilter, loadSample, shownCount, showFindings } from './helpers'

test.describe('the filter box', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('Enter after a finished word leaves the query alone', async ({ page }) => {
    // The suggestion list also opens on complete input, as a hint about what
    // could come next. With the first entry pre-selected, this turned
    // "type = NOTIFICATION and" into "type = NOTIFICATION type".
    const input = page.locator('input[type="text"]').first()
    await input.click()
    await input.pressSequentially('type = NOTIFICATION and', { delay: 20 })
    await page.keyboard.press('Enter')

    await expect(input).toHaveValue('type = NOTIFICATION and')
  })

  test('a suggestion the user arrows into is still accepted by Enter', async ({ page }) => {
    const input = page.locator('input[type="text"]').first()
    await input.click()
    await input.pressSequentially('type = ', { delay: 20 })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(input).toHaveValue('type = OPEN')
  })

  test('a typed filter applies', async ({ page }) => {
    const input = page.locator('input[type="text"]').first()
    await input.click()
    await input.fill('type = NOTIFICATION')
    await page.keyboard.press('Escape')

    await expect.poll(() => shownCount(page)).toBe(9)
  })

  test('a half-typed query is not flagged while you are still typing', async ({ page }) => {
    const input = page.locator('input[type="text"]').first()
    await input.click()
    await input.pressSequentially('type = ', { delay: 20 })

    // Every incomplete expression is a syntax error; saying so immediately means
    // the box is red for most of the time spent typing.
    await expect(input).not.toHaveClass(/border-critical/)

    // It still gets reported once the typing stops.
    await expect(input).toHaveClass(/border-critical/, { timeout: 5_000 })
  })

  test('the query box is there from the start, with no mode to switch into', async ({ page }) => {
    await expect(page.getByLabel('Filter', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Simple' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Advanced' })).toHaveCount(0)
  })

  test('the filter, + Filter and the BGP / All toggle share one row', async ({ page }) => {
    const top = async (name: string) =>
      (await page.getByRole('button', { name, exact: true }).boundingBox())!.y
    const input = (await page.getByLabel('Filter', { exact: true }).boundingBox())!
    for (const name of ['+ Filter', 'BGP Only', 'All Packets']) {
      expect(Math.abs((await top(name)) - input.y)).toBeLessThan(input.height)
    }
    // The per-type count badges are gone; `type = X` is a suggestion away.
    await expect(page.getByRole('button', { name: /^UPDATE \d+$/ })).toHaveCount(0)
  })

  test('+ Filter appends a condition built from menus', async ({ page }) => {
    await page.getByLabel('Filter', { exact: true }).fill('type = UPDATE')
    await page.getByRole('button', { name: '+ Filter' }).click()
    await page.getByLabel('Field').selectOption('ip')
    await page.getByLabel('Value').fill('10.0.13.1')
    await page.getByRole('button', { name: 'Add (and)' }).click()
    await expect(page.getByLabel('Filter', { exact: true })).toHaveValue('type = UPDATE and ip = 10.0.13.1')
  })

  test('/ and Ctrl+K jump to the filter box', async ({ page }) => {
    await page.locator('tbody [role="row"]').first().click()
    await page.keyboard.press('/')
    await expect(page.getByLabel('Filter', { exact: true })).toBeFocused()
    // Focusing the box opens its suggestions over the list; close them.
    await page.keyboard.press('Escape')

    await page.locator('tbody [role="row"]').first().click()
    await page.keyboard.press('Control+k')
    await expect(page.getByLabel('Filter', { exact: true })).toBeFocused()
  })

  test('== and a bare address filter like their spelled-out forms', async ({ page }) => {
    const input = page.getByLabel('Filter', { exact: true })
    await input.fill('src_ip = 10.0.13.1 or dst_ip = 10.0.13.1')
    await page.waitForTimeout(1200)
    const both = await shownCount(page)

    await input.fill('10.0.13.1')
    await page.waitForTimeout(1200)
    expect(await shownCount(page)).toBe(both)

    await input.fill('peer == 10.0.13.1')
    await page.waitForTimeout(1200)
    expect(await shownCount(page)).toBe(both)
  })

  test('a value in the packet detail can be applied as a filter', async ({ page }) => {
    await page.getByLabel('Filter', { exact: true }).fill('type = UPDATE')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    await page.locator('tbody [role="row"]').first().click()

    // The buttons appear on hover, the way a reader finds them.
    const onSource = page.getByRole('button', { name: /^Filter on: src_ip = / })
    await onSource.locator('xpath=../..').hover()
    await onSource.click()
    await expect(page.getByLabel('Filter', { exact: true })).toHaveValue(/^src_ip = [\d.]+$/)

    const addAsn = page.getByRole('button', { name: /^Add to filter: asn = / }).first()
    await addAsn.locator('xpath=../..').hover()
    await addAsn.click()
    await expect(page.getByLabel('Filter', { exact: true })).toHaveValue(/^src_ip = [\d.]+ and asn = \d+$/)
  })

  test('All Packets shows the non-BGP frames too', async ({ page }) => {
    const bgpOnly = await shownCount(page)
    await page.getByRole('button', { name: 'All Packets' }).click()
    await expect.poll(() => shownCount(page)).toBeGreaterThan(bgpOnly)
  })
})

test.describe('a filter carried in the URL', () => {
  // Every link into this screen — a dashboard alert naming a peer, a summary
  // card, a URL someone pasted into a ticket — arrives this way, and all of
  // them used to land on an unfiltered list.
  test('is applied when the screen is opened on it', async ({ page }) => {
    await loadSample(page)
    await page.goto('./messages?filter=' + encodeURIComponent('type = NOTIFICATION'), {
      waitUntil: 'networkidle',
    })

    await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
    expect(await shownCount(page)).toBe(9)
  })

  test('survives in the URL rather than being cleared on arrival', async ({ page }) => {
    await loadSample(page)
    await page.goto('./messages?filter=' + encodeURIComponent('type = NOTIFICATION'), {
      waitUntil: 'networkidle',
    })
    await page.waitForTimeout(600)

    expect(decodeURIComponent(page.url())).toContain('filter=type = NOTIFICATION')
  })

  test('a finding opens the messages screen on that peer', async ({ page }) => {
    await loadSample(page)
    const rail = await showFindings(page)
    await rail.getByRole('button', { name: /^10\.0\.14\.1 → 10\.0\.14\.4/ }).first().click()
    await page.waitForURL('**/messages**')
    await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
    await page.waitForTimeout(600)

    // Narrowed to one peer pair, not the whole capture.
    expect(await shownCount(page)).toBeLessThan(50)
  })
})

test.describe('a filter in All Packets mode', () => {
  // Switching to All Packets to see a peer's SYN/FIN/RST used to drop the
  // filter entirely, and rendered the BGP frames the filter had not kept as
  // bare TCP segments.
  test('is still applied', async ({ page }) => {
    await loadSample(page)
    await applyFilter(page, 'type = UPDATE')
    const updates = await shownCount(page)

    await page.getByRole('button', { name: 'All Packets' }).click()
    await expect(page.getByText(/BGP \+ 0 non-BGP matched/)).toBeVisible()
    expect(await shownCount(page)).toBe(updates)
  })

  test('keeps BGP frames rendered as BGP', async ({ page }) => {
    await loadSample(page)
    await applyFilter(page, 'src_ip = 10.0.13.1')
    await page.getByRole('button', { name: 'All Packets' }).click()
    await page.waitForTimeout(400)

    const text = await page.locator('tbody [role="row"]').allInnerTexts()
    // Its KEEPALIVEs still read as KEEPALIVEs, and no BGP-carrying segment has
    // fallen back to the bare "[AP] 39557 → 179" rendering.
    expect(text.some((t) => t.includes('KEEPALIVE'))).toBe(true)
    expect(text.some((t) => t.includes('[AP]'))).toBe(false)
    expect(await shownCount(page)).toBeLessThan(119)
  })
})

test.describe('the filter box gets out of the way', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('a value typed in full closes the suggestions over the status bar', async ({ page }) => {
    const input = page.getByLabel('Filter', { exact: true })
    await input.click()
    await input.pressSequentially('ip = 10.0.13.1', { delay: 20 })

    // The lone suggestion would repeat what is already typed.
    await expect(page.getByRole('main').getByRole('button', { name: /^10\.0\.13\.1/ })).toHaveCount(0)
    const status = page.getByText(/Showing \d+ of \d+ packets/)
    const box = (await status.boundingBox())!
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.textContent ?? '',
      [box.x + 5, box.y + box.height / 2]
    )
    expect(hit).toMatch(/Showing/)
  })

  test('a parse error is spaced off the packet count', async ({ page }) => {
    const input = page.getByLabel('Filter', { exact: true })
    await input.fill('type')
    await page.keyboard.press('Escape')
    const error = page.getByText(/Expected operator after "type"/)
    await expect(error).toBeVisible({ timeout: 5_000 })

    const count = (await page.getByText(/Showing \d+ of \d+ packets/).boundingBox())!
    const message = (await error.boundingBox())!
    expect(message.x - (count.x + count.width)).toBeGreaterThanOrEqual(8)
  })
})
