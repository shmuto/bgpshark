import { test, expect } from '@playwright/test'
import { holdTimerExpiryCapture, loadCapture, loadSample } from './helpers'

/**
 * The one number a Hold Timer Expired NOTIFICATION does not carry.
 *
 * The message says a speaker stopped hearing from the other end. Whether that
 * is a reachability problem below BGP or something else depends entirely on how
 * long the silence was against the hold time in force, and both of those are in
 * the capture — so the detail panel does the subtraction. These tests exist
 * because the obvious subtraction is the wrong one: the gap to the previous
 * packet in the list is usually the complaining router's own KEEPALIVE, and the
 * capture here is built so the two answers are thirty seconds apart.
 */
test.describe('the silence before a hold timer teardown', () => {
  test('is measured from the peer and compared against the negotiated hold time', async ({
    page,
  }) => {
    await loadCapture(page, 'holdtimer.pcap', holdTimerExpiryCapture())
    await page.waitForURL('**/messages')
    // The row, not the "NOTIFICATION 1" chip above the list — that one filters.
    await page.getByText('Hold Timer Expired/Unspecific').first().click()

    const panel = page.getByText('Silence before the teardown').locator('..')
    await expect(panel).toBeVisible()
    const text = await panel.innerText()

    // Whose silence: 10.0.0.1 is the end that went quiet, and it is named.
    expect(text).toMatch(/since the last KEEPALIVE from 10\.0\.0\.1/)

    // Which silence: ~90s from the peer, not the ~60s to the previous packet.
    const silence = Number(text.match(/([\d.]+)s since the last/)?.[1])
    expect(silence).toBeGreaterThanOrEqual(90)
    expect(silence).toBeLessThan(91)

    // The lower of the two OPENs — 10.0.0.2 asked for 180, so 180 is not it.
    expect(text).toMatch(/negotiated hold time of\s*90s/)
    expect(text).not.toContain('180')

    // And the reading that follows from a silence that ran the whole hold time.
    expect(text).toMatch(/quiet for the whole hold time/i)
  })

  test('stays the same answer when a filter is hiding the packets it measured', async ({
    page,
  }) => {
    // The measurement walks the packet list, and the list on screen is the
    // filtered one. Indexing against that would make the answer depend on what
    // the reader happened to be filtering for, which is not a property of the
    // capture.
    await loadCapture(page, 'holdtimer.pcap', holdTimerExpiryCapture())
    await page.waitForURL('**/messages')

    await page.getByRole('button', { name: 'Advanced' }).click()
    const input = page.locator('input[type="text"]').first()
    await input.click()
    await input.fill('type == NOTIFICATION')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)

    await page.getByText('Hold Timer Expired/Unspecific').first().click()
    const panel = page.getByText('Silence before the teardown').locator('..')
    await expect(panel).toBeVisible()
    expect(await panel.innerText()).toMatch(/since the last KEEPALIVE from 10\.0\.0\.1/)
  })

  test('says nothing on a NOTIFICATION that is not about the hold timer', async ({ page }) => {
    // The sample's NOTIFICATION is a Cease. A silence measurement there would
    // be a number with no meaning attached to it.
    await loadSample(page)
    await page.getByText('Cease/Hard Reset').first().click()

    await expect(page.getByText('Error Code')).toBeVisible()
    await expect(page.getByText('Silence before the teardown')).toHaveCount(0)
  })
})
