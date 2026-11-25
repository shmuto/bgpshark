import { test, expect } from '@playwright/test'
import { bestPathCapture, loadCapture, openMessagesAfterLoad, routeServerCapture, showFindings } from './helpers'

/**
 * A capture taken on an IXP route server, where one address sends every member
 * its own copy of each route.
 *
 * Route state is kept per session — sender and receiver — so each member's
 * copy goes up and down on its own, and the paths different members are sent
 * under their own policies are not compared with each other. See
 * `routeServerCapture` for the capture.
 */
test.describe('a capture taken on a route server', () => {
  test.beforeEach(async ({ page }) => {
    await loadCapture(page, 'route-server.pcap', routeServerCapture())
    await openMessagesAfterLoad(page)
  })

  test('different paths to different members are not an AS_PATH change', async ({ page }) => {
    const rail = await showFindings(page)
    await expect(rail.getByText(/AS_PATH changed/)).toHaveCount(0)
  })

  test('a withdrawal passed on to two members is a flap for each, and for the member it came from', async ({ page }) => {
    const rail = await showFindings(page)
    await expect(rail.getByText('Route flapping: 203.0.113.0/24')).toBeVisible()

    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    const row = page.getByRole('row').filter({ hasText: '203.0.113.0/24' }).first()
    await expect(row.getByRole('cell').last()).toHaveText('3')
  })

  test('the route history says which member each copy went to', async ({ page }) => {
    await page.getByRole('link', { name: 'Routes', exact: true }).click()
    await page.getByText('203.0.113.0/24').first().click()

    const history = page.getByRole('region', { name: /^Route History/ })
    await expect(history.getByRole('columnheader', { name: 'To', exact: true })).toBeVisible()
    const text = await history.innerText()
    expect(text).toContain('192.0.2.11')
    expect(text).toContain('192.0.2.12')
  })
})

test('an ordinary peering has no To column: the receiver is the other end', async ({ page }) => {
  await loadCapture(page, 'bestpath.pcap', bestPathCapture())
  await openMessagesAfterLoad(page)
  await page.getByRole('link', { name: 'Routes', exact: true }).click()
  await page.getByText('172.20.0.0/16').first().click()

  const history = page.getByRole('region', { name: /^Route History/ })
  await expect(history.getByRole('columnheader', { name: 'From', exact: true })).toBeVisible()
  await expect(history.getByRole('columnheader', { name: 'To', exact: true })).toHaveCount(0)
})
