import { test, expect } from '@playwright/test'
import { goToDashboard, loadCapture, loadSample, oneDirectionCapture, unansweredOpenCapture } from './helpers'

/**
 * The two alerts that fire on something missing from the capture.
 *
 * Every other dashboard rule reacts to a message that arrived. These react to
 * one that never did, which is how a fault at the far end appears when the
 * capture was taken on one router — and both of these captures used to be
 * summarised as "every session looks healthy".
 */
test.describe('sessions that never got going', () => {
  test('a connection accepted and then never answered is called out', async ({ page }) => {
    await loadCapture(page, 'open-unanswered.pcap', unansweredOpenCapture())
    await page.waitForURL('**/messages')
    await goToDashboard(page)

    const body = await page.locator('body').innerText()
    expect(body).not.toContain('No issues detected')
    expect(body).toContain('sends no BGP')
    // What the successful handshake rules out is the useful half of the row.
    expect(body).toContain('port 179')
    // And the neighbour table must not contradict it two rows further down.
    expect(body).toContain('Never up')
  })

  test('a capture with one direction in it is called out, without blaming the capture', async ({ page }) => {
    await loadCapture(page, 'one-direction.pcap', oneDirectionCapture())
    await page.waitForURL('**/messages')
    await goToDashboard(page)

    const body = await page.locator('body').innerText()
    expect(body).not.toContain('No issues detected')
    expect(body).toContain('Only one direction')
    // Both readings, since the file cannot tell them apart and one of them is
    // an outage rather than a capture problem.
    expect(body).toContain('not arriving')
  })

  test('a healthy capture is still reported as healthy', async ({ page }) => {
    // The rules judge whole sessions, so a false positive here would fire on
    // every capture in the suite rather than on an edge case.
    await loadSample(page)
    await goToDashboard(page)

    const body = await page.locator('body').innerText()
    expect(body).not.toContain('sends no BGP')
    expect(body).not.toContain('Only one direction')
    expect(body).not.toContain('Never up')
  })
})
