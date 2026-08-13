import { test, expect } from '@playwright/test'
import { goToDashboard, gracefulRestartCapture, loadCapture, silentTeardownCapture } from './helpers'

/**
 * A reload the two ends had agreed to ride out, told apart from a crash loop.
 *
 * The two mean opposite things — a graceful restart kept forwarding while the
 * control plane came back, a crash loop did not — and the dashboard used to
 * call both of them "Session flapping detected". Everything that separates them
 * is in the capture: the capability on both OPENs saying how long the speaker
 * expected to be away and whether it kept forwarding, and the gap between the
 * session returning and the End-of-RIB that says the routes did.
 */
test.describe('a router that restarted gracefully', () => {
  test('is reported as a restart, with the numbers that make it one', async ({ page }) => {
    await loadCapture(page, 'gr.pcap', gracefulRestartCapture())
    await page.waitForURL('**/messages')
    await goToDashboard(page)

    const body = await page.locator('body').innerText()
    expect(body).toContain('10.0.0.1 restarted gracefully')

    // What it promised and what it did — the pair that answers "was forwarding
    // preserved", which is the question S8 is asked with.
    expect(body).toContain('120s')
    expect(body).toContain('kept forwarding state')
    // Convergence, measured rather than assumed. The capture takes 3s.
    expect(body).toMatch(/Routes were back 3(\.\d)?s/)
  })

  test('replaces the flapping row rather than sitting beside it', async ({ page }) => {
    // The complaint in S8 exactly: a reload and a crash loop read identically.
    await loadCapture(page, 'gr.pcap', gracefulRestartCapture())
    await page.waitForURL('**/messages')
    await goToDashboard(page)

    const body = await page.locator('body').innerText()
    expect(body).not.toContain('Session flapping detected')
    // And the reset it came back from is not separately reported as a teardown
    // nobody explained, because the restart is the explanation.
    expect(body).not.toContain('with no NOTIFICATION')
  })

  test('says so when forwarding was not preserved', async ({ page }) => {
    // Same restart, one flag different, and the operational reading inverts:
    // the dataplane dropped traffic for the whole window.
    await loadCapture(page, 'gr-nf.pcap', gracefulRestartCapture({ forwarding: false }))
    await page.waitForURL('**/messages')
    await goToDashboard(page)

    const body = await page.locator('body').innerText()
    expect(body).toContain('restarted gracefully')
    expect(body).toContain('did not advertise preserved forwarding state')
  })

  test('a session without the capability is still a flap', async ({ page }) => {
    // The control: same shape of teardown and reconnect, no capability, so
    // nobody agreed to hold the routes and nothing was graceful about it.
    await loadCapture(page, 'silent.pcap', silentTeardownCapture())
    await page.waitForURL('**/messages')
    await goToDashboard(page)

    const body = await page.locator('body').innerText()
    expect(body).not.toContain('restarted gracefully')
    expect(body).toContain('Session flapping detected')
    expect(body).toContain('with no NOTIFICATION')
  })
})
