import { test, expect } from '@playwright/test'
import { announce, buildScenario, withdraw, type ScenarioStep } from '../../src/lib/build'
import { loadCapture, openMessagesAfterLoad, showFindings } from './helpers'

/**
 * A capture past BACKGROUND_FINDINGS_MIN_PACKETS: one UPDATE per frame, the
 * shape of a busy session rather than of a table transfer, and with a prefix
 * that goes away and comes back so there is a route finding to wait for.
 */
function busySession(updates: number): Buffer {
  const steps: ScenarioStep[] = [
    { kind: 'handshake' },
    { kind: 'open', from: 'a' },
    { kind: 'open', from: 'b' },
    { kind: 'keepalive', from: 'a' },
    { kind: 'keepalive', from: 'b' },
  ]
  for (let i = 0; i < updates; i++) {
    const prefix = `10.${(i >> 8) & 255}.${i & 255}.0/24`
    steps.push({
      kind: 'send',
      from: 'b',
      gap: 0.001,
      messages: [announce([prefix], { nextHop: '10.0.0.2', asPath: [65002, 100 + (i % 50)] })],
    })
  }
  for (let flap = 0; flap < 3; flap++) {
    steps.push({ kind: 'send', from: 'b', gap: 0.5, messages: [withdraw(['10.0.0.0/24'])] })
    steps.push({
      kind: 'send',
      from: 'b',
      gap: 0.5,
      messages: [announce(['10.0.0.0/24'], { nextHop: '10.0.0.2', asPath: [65002, 100] })],
    })
  }
  const capture = buildScenario({
    a: { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1' },
    b: { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2' },
    steps,
  })
  return Buffer.from(capture.bytes)
}

/**
 * On a large capture the findings wait for route statistics worked out in the
 * background, so the packet list is usable meanwhile. What that owes the
 * reader: the findings column says it is still working rather than "no
 * issues", and the findings do arrive.
 */
test('a large capture shows its findings once the background analysis is done', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { __pending: boolean }).__pending = false
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="findings-pending"]')) {
        ;(window as unknown as { __pending: boolean }).__pending = true
      }
    }).observe(document, { subtree: true, childList: true })
  })

  await loadCapture(page, 'busy-session.pcap', busySession(25_000))
  await openMessagesAfterLoad(page, 60_000)

  await expect(page.getByTestId('findings-pending')).toHaveCount(0, { timeout: 30_000 })
  expect(await page.evaluate(() => (window as unknown as { __pending: boolean }).__pending)).toBe(true)

  const rail = await showFindings(page)
  await expect(rail).not.toContainText('No issues detected')
  await expect(rail).toContainText('10.0.0.0/24')
})
