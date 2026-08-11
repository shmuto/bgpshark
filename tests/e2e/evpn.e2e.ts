import { test, expect } from '@playwright/test'
import { applyFilter, evpnCapture, loadCapture, runSql, shownCount } from './helpers'

/**
 * EVPN end to end, on a capture of a MAC moving between two leaves.
 *
 * The unit tests cover the decoder and the filter compiler; what only a browser
 * can show is whether an EVPN route survives the whole trip — parsed, into
 * DuckDB, and back out through a filter or a query. It is a trip with several
 * places to fall off: EVPN carries no prefix, so the columns the rest of the
 * app filters on say nothing about it.
 */
test.beforeEach(async ({ page }) => {
  await loadCapture(page, 'evpn-fabric.pcap', evpnCapture())
  await page.waitForURL('**/messages')
  await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
})

test.describe('EVPN in the message list', () => {
  test('a MAC/IP route is named by its MAC, not by a prefix', async ({ page }) => {
    await expect(page.getByText('[2] 00:0c:29:aa:bb:cc').first()).toBeVisible()
  })

  test('the decoded route and its extended communities are in the detail pane', async ({ page }) => {
    await page.getByText('[2] 00:0c:29:aa:bb:cc').last().click()
    await page.getByText(/Click for details/).click()

    const body = await page.locator('body').innerText()
    expect(body).toContain('EVPN ROUTES')
    expect(body).toContain('10.0.0.1:100')
    expect(body).toContain('Route Target 65002:100')
    expect(body).toContain('Encapsulation VXLAN')
  })
})

test.describe('EVPN filter fields', () => {
  test('a MAC search finds the announcement and the withdrawal alike', async ({ page }) => {
    // Three frames: announced by leaf2, withdrawn by leaf2, announced by leaf1.
    await applyFilter(page, 'mac = 00:0c:29:aa:bb:cc')
    expect(await shownCount(page)).toBe(3)
  })

  test('vni narrows to one bridge domain', async ({ page }) => {
    await applyFilter(page, 'vni = 10100')
    expect(await shownCount(page)).toBe(3)
  })

  test('rt matches the Route Target the far end has to import', async ({ page }) => {
    await applyFilter(page, 'rt = 65002:100')
    expect(await shownCount(page)).toBe(3)
  })

  test('a Route Target that is not there matches nothing', async ({ page }) => {
    await applyFilter(page, 'rt = 65099:999')
    expect(await shownCount(page)).toBe(0)
  })

  test('evpn_type selects one route type', async ({ page }) => {
    // One frame carries both Inclusive Multicast routes.
    await applyFilter(page, 'evpn_type = 3')
    expect(await shownCount(page)).toBe(1)
  })
})

test.describe('EVPN reaches the database', () => {
  test('the evpn columns are populated, not left null', async ({ page }) => {
    await page.getByRole('link', { name: 'SQL', exact: true }).click()
    const body = await runSql(
      page,
      'select evpn_mac, evpn_vni, evpn_rd from nlri where evpn_mac is not null order by evpn_rd'
    )
    expect(body).not.toContain('Error:')
    expect(body).toContain('00:0c:29:aa:bb:cc')
    expect(body).toContain('10100')
    expect(body).toContain('10.0.0.1:100')
  })

  test('a withdrawn EVPN route keeps its MAC too', async ({ page }) => {
    await page.getByRole('link', { name: 'SQL', exact: true }).click()
    const body = await runSql(page, 'select evpn_mac from withdrawn where evpn_mac is not null')
    expect(body).toContain('00:0c:29:aa:bb:cc')
  })

  test('extended communities are a table you can group by', async ({ page }) => {
    await page.getByRole('link', { name: 'SQL', exact: true }).click()
    const body = await runSql(
      page,
      "select value, count(*) as n from extended_communities where kind = 'Route Target' group by value"
    )
    expect(body).not.toContain('Error:')
    expect(body).toContain('65002:100')
  })
})

test.describe('EVPN on the route history', () => {
  test('a MAC that moved is one route with both halves of the move', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Prefix Statistics' })).toBeVisible()

    // Keyed by MAC and VNI, so the leaf it sat behind is not part of its identity.
    const row = page.getByText('[2] 00:0c:29:aa:bb:cc VNI 10100')
    await expect(row).toBeVisible()
    await row.click()

    const body = await page.locator('body').innerText()
    // The RD column is what says the move happened: same MAC, different leaf.
    expect(body).toContain('10.0.0.2:100')
    expect(body).toContain('10.0.0.1:100')
    expect(body).toContain('🔴 Withdraw')
    expect(body).toContain('🟢 Announce')
  })
})
