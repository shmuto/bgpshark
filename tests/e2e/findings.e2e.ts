import { test, expect } from '@playwright/test'
import { loadCapture, loadSample, prefixCount, showFindings, shownCount } from './helpers'
import { buildScenario } from '../../src/lib/build'

/**
 * The workspace's left column: the sessions in the capture and what went wrong
 * in them, beside every view instead of on a dashboard in front of them.
 */
test.describe('findings beside the views', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('one hard reset on three sessions reads as one finding, not sixteen rows', async ({ page }) => {
    const rail = await showFindings(page)
    await expect(rail.getByRole('heading', { name: /^Findings/ })).toContainText('4 kinds · 18 occurrences')

    const groups = rail.getByRole('region', { name: 'Findings' }).locator('li > div > button')
    await expect(groups).toHaveCount(4)
    // Worst first: the teardown that caused everything else leads.
    await expect(groups.first()).toContainText('Hard Reset')
    await expect(groups.first()).toContainText('3 sessions')
  })

  test('a connection collision is informational and listed last', async ({ page }) => {
    const rail = await showFindings(page)
    const groups = rail.getByRole('region', { name: 'Findings' }).locator('li > div > button')
    await expect(groups.last()).toContainText('Connection Collision Resolution')
    await expect(groups.last()).toContainText('Info:')
  })

  test('different paths from iBGP and eBGP peers are not an AS_PATH change', async ({ page }) => {
    await showFindings(page)
    await expect(page.getByText('(no AS_PATH)')).toHaveCount(0)
    await expect(page.getByText(/AS_PATH changed/)).toHaveCount(0)
  })
})

test.describe('choosing a session', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
  })

  test('narrows the list and the findings, and says so once', async ({ page }) => {
    expect(await shownCount(page)).toBe(50)
    const rail = page.getByRole('complementary', { name: 'Sessions and findings' })
    await rail.getByRole('button', { name: /^1\.1\.1\.1 ↔ 2\.2\.2\.2/ }).click()

    await expect(page.getByTestId('session-scope')).toHaveText('1.1.1.1 ↔ 2.2.2.2')
    await expect.poll(() => shownCount(page)).toBe(17)
    // The session's own findings, with its route flaps counted on it alone.
    await expect(rail.getByRole('heading', { name: /^Findings/ })).toContainText('4 kinds · 6 occurrences')

    await page.getByRole('button', { name: 'Show all sessions' }).click()
    await expect(page.getByTestId('session-scope')).toHaveCount(0)
    await expect.poll(() => shownCount(page)).toBe(50)
  })

  test('route findings are counted over the chosen session, not the capture', async ({ page }) => {
    const rail = page.getByRole('complementary', { name: 'Sessions and findings' })
    const routeFlaps = rail
      .getByRole('region', { name: 'Findings' })
      .locator('li > div > button')
      .filter({ hasText: 'Route flapping' })
    await expect(routeFlaps).toContainText('×6')
    await expect(routeFlaps).toContainText('Across the capture')

    // Every other finding narrowed to the session; this one used to stay at
    // the whole capture's ×6.
    await rail.getByRole('button', { name: /^10\.0\.13\.1 ↔ 10\.0\.13\.3/ }).click()
    await expect(routeFlaps).toContainText('×2')
    await expect(routeFlaps).toContainText('In this session')

    // Its instances still open a packet of that session.
    await routeFlaps.click()
    await rail.getByRole('button', { name: /^1\.1\.1\.1\/32/ }).click()
    // Frame 116: 10.0.13.3 withdrawing 1.1.1.1/32 from 10.0.13.1.
    await expect(page.getByText(/^Packet #\d+$/)).toHaveText('Packet #116')
  })

  test('the scope follows the reader to another tab', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes' }).click()
    const all = await prefixCount(page)

    await page
      .getByRole('complementary', { name: 'Sessions and findings' })
      .getByRole('button', { name: /^10\.0\.13\.1 ↔ 10\.0\.13\.3/ })
      .click()
    await expect(page.getByTestId('session-scope')).toBeVisible()
    await expect.poll(() => prefixCount(page)).toBeLessThanOrEqual(all)

    await page.getByRole('link', { name: 'Messages' }).click()
    await expect(page.getByTestId('session-scope')).toHaveText('10.0.13.1 ↔ 10.0.13.3')
  })
})

test.describe('opening findings one after another', () => {
  test('each finding selects its own packet while Messages stays open', async ({ page }) => {
    // Messages honours `?selected=` only as it mounts, and it is already open
    // when the first finding is clicked; the second click used to change the
    // filter and leave the first packet selected.
    await loadSample(page)
    const rail = await showFindings(page)
    const packet = page.getByText(/^Packet #\d+$/)

    await rail.getByRole('button', { name: /^10\.0\.14\.1 → 10\.0\.14\.4/ }).first().click()
    await expect(packet).toHaveText('Packet #39')

    await rail.getByRole('button', { name: /^1\.1\.1\.1 → 2\.2\.2\.2/ }).first().click()
    await expect(packet).toHaveText('Packet #12')
    // Opening evidence does not narrow the workspace; the list of findings
    // stays whole so the next instance is still there to click.
    await expect(page.getByTestId('session-scope')).toHaveCount(0)
  })
})

test.describe('a finding that happened more than once', () => {
  test('counts its occurrences, not its rows', async ({ page }) => {
    // The same Hold Timer Expired teardown, three times on one session. The
    // rule folds the three into one alert with `count: 3`; the column used to
    // badge it "×1", the number of rows.
    const cycle = [
      { kind: 'handshake' as const },
      { kind: 'open' as const, from: 'a' as const },
      { kind: 'open' as const, from: 'b' as const },
      { kind: 'keepalive' as const, from: 'a' as const },
      { kind: 'delay' as const, gap: 30_000 },
      { kind: 'keepalive' as const, from: 'b' as const },
      { kind: 'delay' as const, gap: 90_000 },
      { kind: 'send' as const, from: 'b' as const, messages: [{ type: 'NOTIFICATION' as const, errorCode: 4, errorSubcode: 0 }] },
      { kind: 'reset' as const, from: 'b' as const, gap: 50 },
      { kind: 'delay' as const, gap: 5_000 },
    ]
    const built = buildScenario({
      a: { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1', holdTime: 90 },
      b: { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2', holdTime: 90 },
      gap: 200,
      steps: [...cycle, ...cycle, ...cycle],
    })
    await loadCapture(page, 'holdtimer-x3.pcap', Buffer.from(built.bytes))
    const rail = await showFindings(page)

    const finding = rail
      .getByRole('region', { name: 'Findings' })
      .locator('li > div > button')
      .filter({ hasText: 'Hold Timer Expired' })
    await expect(finding).toContainText('×3')
    // When it started and when it last happened, since three teardowns
    // minutes apart and three in a second are different problems.
    await expect(finding).toContainText(/\d{2}:\d{2}:\d{2}\.\d{3}–\d{2}:\d{2}:\d{2}\.\d{3}/)
  })
})

test.describe('opening Messages afresh', () => {
  test('does not carry the previous row number into a shorter list', async ({ page }) => {
    // The selection is a row number held above the view. Selecting row 30 of
    // the whole capture and then opening a 17-message session from Sessions
    // used to leave row 30 selected in a list without one: "Packet #undefined".
    await loadSample(page)
    const row = page.locator('#packet-row-30')
    await row.scrollIntoViewIfNeeded()
    await row.click()
    await expect(page.getByText(/^Packet #\d+$/)).toBeVisible()

    await page.getByRole('link', { name: 'Sessions', exact: true }).click()
    await page
      .getByRole('complementary', { name: 'Sessions and findings' })
      .getByRole('button', { name: /^1\.1\.1\.1 ↔ 2\.2\.2\.2/ })
      .click()
    await page.getByRole('button', { name: 'Messages →' }).click()

    await expect.poll(() => shownCount(page)).toBe(17)
    await expect(page.getByText('Packet Detail', { exact: true })).toBeVisible()
    await expect(page.getByText(/Packet #undefined/)).toHaveCount(0)
    await expect(page.locator('tr[aria-selected="true"]')).toHaveCount(0)
  })
})
