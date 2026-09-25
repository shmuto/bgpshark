import { test, expect } from '@playwright/test'
import { announce, buildScenario, type BgpMessageSpec } from '../../src/lib/build'
import { loadCapture, waitForDatabase } from './helpers'

/**
 * A capture big enough to take more than one database batch — the loader
 * inserts 10,000 rows at a time, and this flattens to a few hundred thousand —
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
 * The gauges exist because a large capture used to sit behind a spinner for
 * minutes, indistinguishable from a hang. What they owe the reader is that
 * they move, that they move forwards, and that they say what they are doing.
 *
 * There are two, and they are held to that separately. The capture gauge
 * covers what the screens wait for — reading, parsing, decoding — and is gone
 * once the packet list appears. The DuckDB gauge covers the load that now runs
 * after that, with the list already usable, and counts rows as they go in.
 *
 * Both are read with a MutationObserver installed before the app loads, rather
 * than polled from the test: every value React commits is recorded, however
 * quickly the load runs on the machine at hand.
 */
test('loading a capture shows gauges that only move forwards', async ({ page }) => {
  await page.addInitScript(() => {
    type Entry = { value: number; text: string; stage: string }
    const seen: Record<string, Entry[]> = { capture: [], database: [] }
    let listShownWhileDatabaseLoading = false
    ;(window as unknown as { __gauges: typeof seen; __overlap: () => boolean }).__gauges = seen
    ;(window as unknown as { __overlap: () => boolean }).__overlap = () => listShownWhileDatabaseLoading
    const record = (list: Entry[], bar: Element | null) => {
      if (!bar) return
      const entry = {
        value: Number(bar.getAttribute('aria-valuenow')),
        text: bar.getAttribute('aria-valuetext') ?? '',
        stage: bar.getAttribute('data-stage') ?? '',
      }
      const last = list[list.length - 1]
      if (!last || last.text !== entry.text || last.value !== entry.value) list.push(entry)
    }
    new MutationObserver(() => {
      record(seen.capture, document.querySelector('[role="progressbar"][aria-label="Loading capture"]'))
      const database = document.querySelector('[role="progressbar"][aria-label="Loading into DuckDB"]')
      record(seen.database, database)
      if (database && document.body.textContent?.match(/Showing \d+ of \d+ packets/)) {
        listShownWhileDatabaseLoading = true
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })

  await loadCapture(page, 'table-transfer.pcap', tableTransfer(40_000))
  await page.waitForURL('**/messages', { timeout: 60_000 })
  await waitForDatabase(page)
  await expect(page.getByRole('progressbar')).toHaveCount(0)

  const { capture, database } = await page.evaluate(
    () => (window as unknown as { __gauges: Record<string, Array<{ value: number; text: string; stage: string }>> }).__gauges
  )
  const forwards = (entries: typeof capture) => {
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].value, `went backwards: ${entries[i - 1].text} → ${entries[i].text}`).toBeGreaterThanOrEqual(
        entries[i - 1].value
      )
    }
  }

  expect([...new Set(capture.map((entry) => entry.stage))], 'every stage announces itself, in order').toEqual([
    'reading',
    'parsing',
    'decoding',
  ])
  forwards(capture)
  forwards(database)

  // The point of the split: the packet list was usable while DuckDB was
  // still going, not after.
  expect(await page.evaluate(() => (window as unknown as { __overlap: () => boolean }).__overlap())).toBe(true)

  // Moving *within* the database load is the part a spinner could not do: at
  // least one reading strictly between none and all of the rows.
  const partway = database.filter((entry) => {
    const counted = entry.text.match(/([\d,]+) of ([\d,]+) rows/)
    if (!counted) return false
    const [done, total] = [counted[1], counted[2]].map((n) => Number(n.replace(/,/g, '')))
    return done > 0 && done < total
  })
  expect(partway.length, database.map((entry) => entry.text).join('\n')).toBeGreaterThan(0)
})
