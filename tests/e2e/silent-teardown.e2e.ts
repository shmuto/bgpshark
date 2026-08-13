import { test, expect } from '@playwright/test'
import {
  explainedTeardownCapture,
  goToDashboard,
  loadCapture,
  silentTeardownCapture,
} from './helpers'

/**
 * A session that went down with nothing at the BGP layer recording it.
 *
 * The evidence was always in the capture — an `[AR]` and an `[F]` under All
 * Packets — and the complaint in `troubleshooting-scenarios.md` S11 was never
 * that the reset is unfindable, only that nothing pointed at it. So half of
 * what these tests check is that the row exists, and the other half is that its
 * `View →` reaches the frame it names: the packet list shows BGP only until it
 * is switched over, so a row naming an RST would otherwise land the reader on a
 * list that cannot contain it.
 */
test.describe('a teardown nothing explained', () => {
  test('is two rows, one per shape, on a capture that drops both ways', async ({ page }) => {
    await loadCapture(page, 'silent.pcap', silentTeardownCapture())
    await page.waitForURL('**/messages')
    await goToDashboard(page)

    const body = await page.locator('body').innerText()
    expect(body).not.toContain('No issues detected')

    // Separate rows rather than one saying "dropped twice": an RST is something
    // actively rejecting the connection, a FIN something deciding it was
    // finished, and the next thing to check differs.
    expect(body).toContain('was reset with no NOTIFICATION')
    expect(body).toContain('was closed with no NOTIFICATION')

    // It sits next to the flapping warning rather than replacing it. They are
    // symptom and cause: flapping counts how often the session came up, this
    // says how it went down.
    expect(body).toContain('Session flapping detected')
  })

  test('stays quiet when a NOTIFICATION already said why', async ({ page }) => {
    // The false positive this rule is measured against. The resets are still in
    // the capture; a Cease explains them, so they are not this rule's business.
    await loadCapture(page, 'explained.pcap', explainedTeardownCapture())
    await page.waitForURL('**/messages')
    await goToDashboard(page)

    const body = await page.locator('body').innerText()
    expect(body).toContain('NOTIFICATION')
    expect(body).not.toContain('with no NOTIFICATION')
  })

  test('View → lands on the frame it is talking about', async ({ page }) => {
    await loadCapture(page, 'silent.pcap', silentTeardownCapture())
    await page.waitForURL('**/messages')
    await goToDashboard(page)

    const row = page
      .locator('li')
      .filter({ hasText: 'was reset with no NOTIFICATION' })
      .first()
    await row.getByRole('button', { name: /View/ }).click()

    await page.waitForURL('**/messages**')

    // The list has to have switched itself to All Packets, or the RST is not
    // among the rows at all — this is the half of the S11 gap that a row
    // naming evidence it then refuses to show would have left in place.
    await expect(page).toHaveURL(/all=1/)

    // And the selected packet is the reset itself, not the KEEPALIVE before it.
    // Asserted through the frame the link asked for rather than by searching
    // the page for "RST", which appears in the alert text that is still on
    // screen and would pass whether or not anything got selected.
    const requested = new URL(page.url()).searchParams.get('frame')
    expect(requested).not.toBeNull()
    await expect(page.getByText(`Packet #${requested}`)).toBeVisible()

    // That frame is the reset, which is only true if the row pointed at the
    // right one: the detail pane names the flags it carries.
    await expect(page.getByText('RST', { exact: false }).first()).toBeVisible()
  })
})
