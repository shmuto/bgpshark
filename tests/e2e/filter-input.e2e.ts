import { test, expect } from '@playwright/test'
import { applyFilter, loadSample, shownCount } from './helpers'

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

  test('a type badge writes its filter into the box, and nothing contradicts it', async ({ page }) => {
    await page.getByRole('button', { name: /^UPDATE \d+/ }).click()
    await expect(page.getByLabel('Filter', { exact: true })).toHaveValue('type = UPDATE')
    await expect(page.getByText('No filters applied')).toHaveCount(0)
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

  test('a dashboard alert opens the messages screen on that peer', async ({ page }) => {
    await loadSample(page)
    await page.getByRole('link', { name: 'Dashboard' }).click()
    await page.getByRole('button', { name: 'View →' }).first().click()
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

test.describe('apply-as-filter buttons in the packet detail', () => {
  test('on Source and Destination they sit left of the address, clear of the port', async ({ page }) => {
    await loadSample(page)
    await page.locator('tbody [role="row"]').first().click()

    const add = page.getByRole('button', { name: /^Add to filter: src_ip = / })
    const value = add.locator('xpath=../..')
    await value.hover()
    await expect(add).toBeVisible()

    const buttons = (await add.locator('xpath=..').boundingBox())!
    const address = (await value.boundingBox())!
    // Entirely to the left of the address, so nothing covers ":port".
    expect(buttons.x + buttons.width).toBeLessThanOrEqual(address.x + 1)
  })

  test('a filterable value is marked before it is hovered', async ({ page }) => {
    await loadSample(page)
    await page.locator('tbody [role="row"]').first().click()
    const text = page.getByRole('button', { name: /^Add to filter: src_ip = / }).locator('xpath=../../span[1]')
    await expect(text).toHaveCSS('text-decoration-style', 'dotted')
  })
})
