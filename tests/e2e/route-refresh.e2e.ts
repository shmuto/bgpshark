import { test, expect } from '@playwright/test'
import { loadCapture, routeRefreshCapture } from './helpers'

/**
 * What a soft clear actually brought back.
 *
 * Anyone sending a ROUTE-REFRESH has just changed a policy and wants to know
 * whether the routes that returned are the ones they expected. Both halves were
 * always visible as messages; the difference between them was the reader's to
 * take by eye, which is the whole of S9.
 *
 * Selecting the refresh is also how a capture holding several of them chooses
 * which interval to compare — the message is the divider.
 */
test.describe('what a route refresh changed', () => {
  /** The refresh row in the packet list, not the type chip above it — that one filters. */
  async function selectTheRefresh(page: import('@playwright/test').Page) {
    await page.getByText('IPv4/Unicast').first().click()
    await expect(page.getByText('What the refresh changed')).toBeVisible()
  }

  test('names the route that came back tagged', async ({ page }) => {
    await loadCapture(page, 'refresh.pcap', routeRefreshCapture('gained'))
    await page.waitForURL('**/messages')
    await selectTheRefresh(page)

    const body = await page.locator('body').innerText()
    // The peer being compared is the refresh's destination, which is the end
    // asked to re-advertise.
    expect(body).toContain('10.0.0.1 re-advertised IPv4 Unicast')
    expect(body).toContain('Added (1)')
    expect(body).toContain('10.1.1.0/24')
    expect(body).toContain('65001:999')
    // And the route that came back identical is counted rather than listed.
    expect(body).toContain('1 route came back unchanged')
  })

  test('names the route that did not come back, though nothing withdrew it', async ({ page }) => {
    // The other half of the same complaint, and the reason this cannot be read
    // from withdrawals: after a refresh the peer re-sends its table, and a
    // route it no longer has is absent rather than withdrawn.
    await loadCapture(page, 'refresh-lost.pcap', routeRefreshCapture('lost'))
    await page.waitForURL('**/messages')
    await selectTheRefresh(page)

    const body = await page.locator('body').innerText()
    expect(body).toContain('No longer advertised (1)')
    expect(body).toContain('10.2.0.0/24')
    expect(body).toContain('was not re-advertised')
  })

  test('a route named by the diff opens the packet it was announced in', async ({ page }) => {
    // A row that names evidence has to reach it, the same bargain the teardown
    // alert makes — here the packet that last carried the route.
    await loadCapture(page, 'refresh.pcap', routeRefreshCapture('gained'))
    await page.waitForURL('**/messages')
    await selectTheRefresh(page)

    await page.getByRole('button', { name: '10.1.1.0/24' }).click()

    // The detail pane has moved off the refresh and onto the UPDATE carrying it.
    await expect(page.getByText('BGP UPDATE Message').first()).toBeVisible()
  })

  test('says nothing on a message that is not a refresh', async ({ page }) => {
    await loadCapture(page, 'refresh.pcap', routeRefreshCapture('gained'))
    await page.waitForURL('**/messages')

    await page.getByText('AS65001 Hold=90').first().click()

    await expect(page.getByText('What the refresh changed')).toHaveCount(0)
  })
})
