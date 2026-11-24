import { test, expect } from '@playwright/test'
import { announce, buildScenario, type BgpMessageSpec } from '../../src/lib/build'
import { loadCapture, openMessagesAfterLoad, waitForDatabase } from './helpers'

/**
 * A capture big enough to take more than one database chunk — the loader
 * inserts 250,000 rows at a time, and this flattens to a few hundred thousand —
 * but small enough to load in a few seconds. UPDATEs are packed into full
 * segments, the way a real table transfer arrives, which is the shape that
 * made large captures slow in the first place.
 */
function tableTransfer(updates: number): Buffer {
  const messages: BgpMessageSpec[] = []
  for (let i = 0; i < updates; i++) {
    const prefix = `${10 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}.0/24`
    messages.push(
      announce([prefix], {
        nextHop: '10.0.0.2',
        asPath: [65002, 3356, 100 + (i % 500)],
        communities: ['65002:100'],
      })
    )
  }
  const capture = buildScenario({
    a: { ip: '10.0.0.1', as: 65001, routerId: '1.1.1.1' },
    b: { ip: '10.0.0.2', as: 65002, routerId: '2.2.2.2' },
    steps: [
      { kind: 'handshake' },
      { kind: 'open', from: 'a' },
      { kind: 'open', from: 'b' },
      { kind: 'keepalive', from: 'a' },
      { kind: 'keepalive', from: 'b' },
      { kind: 'send', from: 'b', messages },
    ],
  })
  return Buffer.from(capture.bytes)
}

/**
 * The gauge exists because a large capture used to sit behind a spinner for
 * minutes, indistinguishable from a hang. What it owes the user is that it
 * moves, that it moves forwards, and that it says what it is doing.
 *
 * There are two: the load gauge in front of the packet list, and the header's
 * gauge for the DuckDB insert that runs once the SQL console asks for the
 * capture. Each is read with
 * a MutationObserver installed before the app loads, rather than polled from
 * the test, which is what makes this deterministic: every value React commits
 * is recorded, however quickly the load runs on the machine at hand.
 */
test('loading a capture shows gauges that only move forwards', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: Array<{ value: number; text: string; stage: string }> = []
    ;(window as unknown as { __gauge: typeof seen }).__gauge = seen
    new MutationObserver(() => {
      for (const bar of document.querySelectorAll('[role="progressbar"]')) {
        const entry = {
          value: Number(bar.getAttribute('aria-valuenow')),
          text: bar.getAttribute('aria-valuetext') ?? '',
          stage: bar.getAttribute('data-stage') ?? '',
        }
        const last = [...seen].reverse().find((e) => (e.stage === 'database') === (entry.stage === 'database'))
        if (!last || last.text !== entry.text || last.value !== entry.value) seen.push(entry)
      }
    }).observe(document, { subtree: true, childList: true, attributes: true })
  })

  await loadCapture(page, 'table-transfer.pcap', tableTransfer(40_000))
  await openMessagesAfterLoad(page, 60_000)
  await page.getByRole('link', { name: 'SQL', exact: true }).click()
  await waitForDatabase(page, 60_000)
  await expect(page.getByRole('progressbar')).toHaveCount(0)

  const seen = await page.evaluate(
    () => (window as unknown as { __gauge: Array<{ value: number; text: string; stage: string }> }).__gauge
  )
  const load = seen.filter((entry) => entry.stage !== 'database')
  const database = seen.filter((entry) => entry.stage === 'database')

  expect([...new Set(load.map((entry) => entry.stage))], 'every load stage announces itself, in order').toEqual([
    'reading',
    'parsing',
    'decoding',
  ])
  for (const gauge of [load, database]) {
    for (let i = 1; i < gauge.length; i++) {
      expect(gauge[i].value, `a gauge went backwards: ${gauge[i - 1].text} → ${gauge[i].text}`).toBeGreaterThanOrEqual(
        gauge[i - 1].value
      )
    }
  }

  // Moving *within* a stage is the part a spinner could not do: at least one
  // reading strictly between none and all of the packets. Decoding runs in
  // slices so that its bar moves too, rather than sitting at the start of the
  // stage until the list appears.
  const partway = (gauge: typeof seen) =>
    gauge.filter((entry) => {
      const counted = entry.text.match(/([\d,]+) of ([\d,]+) packets/)
      if (!counted) return false
      const [done, total] = [counted[1], counted[2]].map((n) => Number(n.replace(/,/g, '')))
      return done > 0 && done < total
    })
  const decoding = load.filter((entry) => entry.stage === 'decoding')
  expect(partway(decoding).length, decoding.map((entry) => entry.text).join('\n')).toBeGreaterThan(0)
  expect(partway(database).length, database.map((entry) => entry.text).join('\n')).toBeGreaterThan(0)
})
