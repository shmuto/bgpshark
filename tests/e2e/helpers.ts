import { expect, type Page } from '@playwright/test'

/**
 * Loads the bundled sample capture through the button a user would press, and
 * waits until the message explorer has something in it.
 *
 * Going through the UI rather than seeding IndexedDB directly means the tests
 * exercise the same path the app takes on a real upload, including the DuckDB
 * load that several of the assertions depend on.
 */
export async function loadSample(page: Page) {
  await page.goto('./', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /sample/i }).first().click()
  await page.waitForURL('**/messages')
  await expect(page.getByText(/Showing \d+ of \d+ packets/)).toBeVisible()
}

/** Loads a capture built in memory, for the cases the sample cannot cover. */
export async function loadCapture(page: Page, name: string, bytes: Buffer) {
  await page.goto('./', { waitUntil: 'networkidle' })
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: 'application/vnd.tcpdump.pcap',
    buffer: bytes,
  })
}

/** The "Showing N of M packets" counter, as a number. */
export async function shownCount(page: Page): Promise<number> {
  const text = await page.getByText(/Showing \d+ of \d+ packets/).first().textContent()
  return Number(text?.match(/Showing (\d+)/)?.[1] ?? -1)
}

/** The "N prefixes" counter on the route analysis screen. */
export async function prefixCount(page: Page): Promise<number> {
  const text = await page.getByText(/\d+ prefixes/).first().textContent()
  return Number(text?.match(/(\d+) prefixes/)?.[1] ?? -1)
}

/**
 * Types a filter expression and waits past the DuckDB debounce, so what the
 * assertion reads is the database's answer rather than the in-memory one that
 * appears first.
 */
export async function applyFilter(page: Page, expression: string) {
  await page.getByRole('button', { name: 'Advanced' }).click()
  const input = page.locator('input[type="text"]').first()
  await input.click()
  await input.fill(expression)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
}

/** Runs a query in the SQL console and returns the page text once it settles. */
export async function runSql(page: Page, sql: string): Promise<string> {
  const editor = page.locator('textarea').first()
  await editor.click()
  await editor.fill(sql)
  await page.keyboard.press('Control+Enter')
  await expect(page.getByText(/Results \(|Error:/).first()).toBeVisible()
  await page.waitForTimeout(600)
  return page.locator('body').innerText()
}

/**
 * A pcapng whose first packets claim more captured bytes than they carry, so
 * the parser produces warnings. Built from the sample rather than committed as
 * a second fixture, so it cannot drift away from it.
 */
export function corruptCapture(sample: Buffer): Buffer {
  const bytes = Buffer.from(sample)
  let offset = 0
  let patched = 0

  while (offset + 8 <= bytes.length) {
    const type = bytes.readUInt32LE(offset)
    const length = bytes.readUInt32LE(offset + 4)
    if (length < 12 || offset + length > bytes.length) break

    // Enhanced Packet Block: bump its captured length past the block's own end.
    if (type === 6 && patched < 3) {
      bytes.writeUInt32LE(bytes.readUInt32LE(offset + 20) + 40, offset + 20)
      patched++
    }
    offset += length
  }

  return bytes
}
