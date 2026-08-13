/**
 * The manual's screenshots, taken from the troubleshooting scenarios.
 *
 * The scenario walkthroughs in `src/pages/manual/manual.md` tell a reader where
 * to click and what they should see when they get there. Prose alone is a poor
 * way to say "what you should see": the screens are dense, and the whole point
 * of a walkthrough is that the reader can compare the picture in the manual
 * against the picture in front of them.
 *
 * So the pictures are generated rather than taken by hand, from the same
 * captures `testlab/scenarios.ts` builds. That matters for one reason above all:
 * a hand-taken screenshot is a claim about the app that nothing checks, and it
 * rots silently the first time a panel is renamed or a column is added. Here the
 * shot is a script that drives the real app — if the click path in the manual no
 * longer exists, this run fails rather than quietly producing a picture of the
 * wrong thing.
 *
 *   bun run screenshots            # every shot, into public/manual/
 *   bun run screenshots s2 s11     # only shots whose file name starts with these
 *
 * The output *is* committed, unlike the captures in `testlab/scenarios/`: the
 * manual ships to a browser and cannot generate its own images. Re-run this
 * after any change to a screen the manual points at, and commit what changes.
 *
 * The images are deliberately light-theme only. The app follows the system
 * theme, so a dark-mode reader sees light screenshots — the alternative is two
 * files per shot and a manual that has to pick between them at render time,
 * which is a lot of machinery for a picture whose job is to show where a number
 * appears on a panel.
 */
import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS } from './scenarios'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'manual')
const BASE_URL = 'http://localhost:5173/bgpshark/'

/**
 * Wide enough that the packet list keeps every column and the Neighbors screen
 * stays in its two-pane layout, short enough that a viewport-sized shot is
 * still readable when the manual scales it down to the width of a paragraph.
 */
const VIEWPORT = { width: 1400, height: 820 }

/**
 * A shot is one capture, one click path, and the thing to photograph at the end
 * of it: a panel when the answer is inside one, or the whole viewport when the
 * point is where the panel sits among the others.
 */
interface Shot {
  /** File name under `public/manual/`, without the extension. */
  file: string
  /** Scenario id prefix, as accepted by `testlab/scenarios.ts`. */
  scenario: string
  /** Drives the app; returns the element to capture, or null for the viewport. */
  take: (page: Page) => Promise<Locator | null>
}

// --- Driving the app --------------------------------------------------------

/** The header link for a screen. */
async function go(page: Page, screen: string): Promise<void> {
  await page.getByRole('link', { name: screen, exact: true }).click()
  await page.waitForTimeout(900)
}

/**
 * The card a piece of text sits in.
 *
 * Every panel in this app is a `rounded-lg` surface with its title in the first
 * row, so the nearest such ancestor of the title is the panel. Addressing them
 * by their visible title rather than by a test id keeps this script honest: a
 * panel the manual names by a title it no longer has should fail here.
 */
function card(page: Page, title: string): Locator {
  return page
    .getByText(title, { exact: false })
    .first()
    .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
}

/** Types a filter expression and waits past the DuckDB debounce. */
async function filter(page: Page, expression: string): Promise<void> {
  await page.getByRole('button', { name: 'Advanced' }).click()
  const input = page.locator('input[type="text"]').first()
  await input.click()
  await input.fill(expression)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1400)
}

/** Runs a query on the SQL screen and waits for the results grid. */
async function query(page: Page, sql: string): Promise<void> {
  const editor = page.locator('textarea').first()
  await editor.click()
  await editor.fill(sql)
  await page.keyboard.press('Control+Enter')
  await page.waitForSelector('text=/Results \\(|Error:/')
  await page.waitForTimeout(700)
}

// --- The shots --------------------------------------------------------------

const SHOTS: Shot[] = [
  {
    // The screen the manual tells everyone to start on, with something on it.
    file: 'dashboard',
    scenario: 's3',
    take: async (page) => {
      await go(page, 'Dashboard')
      return null
    },
  },
  {
    file: 's1-tcp-refused',
    scenario: 's1',
    take: async (page) => {
      await go(page, 'Dashboard')
      return card(page, 'Alerts')
    },
  },
  {
    file: 's2-capability-diff',
    scenario: 's2',
    take: async (page) => {
      await go(page, 'Neighbors')
      await page.getByText('1.1.1.1').first().click()
      await page.waitForTimeout(400)
      await page.getByText('10.0.0.1 ↔ 10.0.0.2').first().click()
      await page.waitForTimeout(800)
      const diff = card(page, '🔍 Capability Diff')
      await diff.scrollIntoViewIfNeeded()
      return diff
    },
  },
  {
    file: 's3-holdtimer-alerts',
    scenario: 's3',
    take: async (page) => {
      await go(page, 'Dashboard')
      return card(page, 'Alerts')
    },
  },
  {
    // The NOTIFICATION selected, so the measured silence sits next to the error
    // code it explains. Viewport rather than the panel alone: half the point is
    // that this needs no SQL and no navigation beyond clicking the message.
    file: 's3-holdtimer-gap',
    scenario: 's3',
    take: async (page) => {
      await go(page, 'Messages')
      await page.getByText('Hold Timer Expired/Unspecific').first().click()
      await page.waitForTimeout(600)
      await page.getByText('Silence before the teardown').first().waitFor()
      return null
    },
  },
  {
    // The NOTIFICATION selected, so the decoded attribute, the hint and the raw
    // bytes are all in shot — the decode is only trustworthy next to the bytes.
    file: 's6-notification',
    scenario: 's6',
    take: async (page) => {
      await go(page, 'Messages')
      await page.getByText('NOTIFICATION').last().click()
      await page.waitForTimeout(600)
      return null
    },
  },
  {
    // Both teardown rows next to the flapping warning they do not replace —
    // the manual's point is that these are symptom and cause, not duplicates.
    file: 's11-teardown-alerts',
    scenario: 's11',
    take: async (page) => {
      await go(page, 'Dashboard')
      return card(page, 'Alerts')
    },
  },
  {
    // The reset selected: the packet list shows the gap, the detail names the flags.
    file: 's11-tcp-reset',
    scenario: 's11',
    take: async (page) => {
      await go(page, 'Messages')
      await page.getByRole('button', { name: /All Packets/i }).click()
      await page.waitForTimeout(700)
      await page.getByText('[AR]').first().click()
      await page.waitForTimeout(500)
      return null
    },
  },
  {
    // Every row from one address, and a handshake with no SYN-ACK in it.
    file: 's12-one-direction',
    scenario: 's12',
    take: async (page) => {
      await go(page, 'Messages')
      await page.getByRole('button', { name: /All Packets/i }).click()
      await page.waitForTimeout(700)
      await page.getByText('[S]', { exact: true }).first().click()
      await page.waitForTimeout(500)
      return null
    },
  },
  {
    // The query as well as its answer: this one is worth copying, not just reading.
    //
    // This is also the one shot that re-diffs on every run without anything
    // having changed: the SQL console prints how long the query took, and that
    // is a wall clock. If `git status` offers you this file and nothing else,
    // compare the two before committing — it is usually 75ms against 89ms.
    file: 's4-bestpath',
    scenario: 's4',
    take: async (page) => {
      await go(page, 'SQL')
      await query(
        page,
        `select n.prefix || '/' || n.prefix_length as route, p.src_ip,
       (select string_agg(a.asn, ' ' order by a.as_index)
          from as_path a where a.message_id = m.id) as as_path,
       (select max(med_value)  from path_attributes where message_id = m.id) as med,
       (select max(local_pref) from path_attributes where message_id = m.id) as local_pref
from nlri n join messages m on m.id = n.message_id join packets p using(frame_index)
order by route, p.src_ip`
      )
      return null
    },
  },
  {
    // Searching by AS, then the leaked prefix's own AS_PATH.
    file: 's5-route-leak',
    scenario: 's5',
    take: async (page) => {
      await go(page, 'Routes')
      await page.getByPlaceholder(/AS65001/).fill('AS15169')
      await page.waitForTimeout(700)
      await page.getByText('8.8.8.0/24').first().click()
      await page.waitForTimeout(600)
      return null
    },
  },
  {
    file: 's10-churn-alerts',
    scenario: 's10',
    take: async (page) => {
      await go(page, 'Dashboard')
      return card(page, 'Alerts')
    },
  },
  {
    // Sorted worst-first, which takes two clicks: the first sorts ascending.
    file: 's10-churn-routes',
    scenario: 's10',
    take: async (page) => {
      await go(page, 'Routes')
      const flap = page.getByText('Flap', { exact: false }).first()
      await flap.click()
      await page.waitForTimeout(300)
      await flap.click()
      await page.waitForTimeout(500)
      await page.getByText('10.100.0.0/24').first().click()
      await page.waitForTimeout(600)
      return null
    },
  },
  {
    // The withdrawal selected, so the MAC, VNI and RD are visible in the detail.
    file: 's13-mac-move',
    scenario: 's13',
    take: async (page) => {
      await go(page, 'Messages')
      await filter(page, 'mac = 00:0c:29:aa:bb:cc')
      await page.getByText('1 withdrawn').first().click()
      await page.waitForTimeout(600)
      return null
    },
  },
]

// --- Running ----------------------------------------------------------------

/**
 * The capture a shot needs, built in memory rather than read off disk.
 *
 * The file name goes into the shot — it is in the header of every screen — so
 * it is the scenario's full id rather than the prefix the shot asked for.
 */
async function captureFor(id: string): Promise<{ name: string; bytes: Buffer }> {
  const scenario = SCENARIOS.find((s) => s.id === id || s.id.startsWith(`${id}-`))
  if (!scenario) throw new Error(`No scenario matches "${id}"`)
  const { bytes } = await scenario.build()
  return { name: `${scenario.id}.pcap`, bytes: Buffer.from(bytes) }
}

/**
 * A panel, cut off at the bottom of the viewport if it is taller than one.
 *
 * Playwright will happily photograph an element taller than the window, but a
 * page that cannot scroll any further pads the difference with empty
 * background — a panel of fourteen alerts comes out as eleven alerts and a grey
 * void. Clipping to the intersection with the viewport gives a picture that is
 * honestly cut short instead, which is what a reader sees on their own screen.
 */
async function panelShot(page: Page, target: Locator): Promise<Buffer> {
  const box = await target.boundingBox()
  if (!box) throw new Error('The panel to photograph is not visible')

  const clip = {
    x: box.x,
    y: Math.max(box.y, 0),
    width: box.width,
    height: Math.min(box.height, VIEWPORT.height - Math.max(box.y, 0)),
  }
  return page.screenshot({ animations: 'disabled', clip })
}

/**
 * One shot, in a context of its own.
 *
 * A fresh context per shot is the cheap way to get a fresh IndexedDB: the app
 * restores the last capture on load, and a shot that inherited the previous
 * one would photograph the wrong file without failing.
 */
async function run(browser: Browser, shot: Shot): Promise<void> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1.5 })
  const page = await context.newPage()

  try {
    const capture = await captureFor(shot.scenario)
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.locator('input[type="file"]').first().setInputFiles({
      name: capture.name,
      mimeType: 'application/vnd.tcpdump.pcap',
      buffer: capture.bytes,
    })
    await page.waitForURL('**/messages')
    // The packet list is up as soon as the parser finishes; DuckDB takes longer,
    // and a filtered shot taken before it is ready photographs the in-memory
    // answer instead of the one the manual describes.
    await page.waitForSelector('text=/Showing \\d+ of \\d+ packets/')
    await page.waitForTimeout(2500)

    const target = await shot.take(page)
    const path = join(OUT_DIR, `${shot.file}.png`)
    const png = target ? await panelShot(page, target) : await page.screenshot({ animations: 'disabled' })
    writeFileSync(path, png)
    console.log(`${shot.file.padEnd(22)} ${String(png.length / 1024 | 0).padStart(5)} KB`)
  } finally {
    await context.close()
  }
}

/**
 * A dev server, started only if one is not already listening.
 *
 * The alternative is making the caller remember to start one, which turns a
 * regenerate-the-screenshots step into two steps and a confusing timeout.
 */
async function withDevServer<T>(body: () => Promise<T>): Promise<T> {
  const alreadyUp = await fetch(BASE_URL).then(
    () => true,
    () => false
  )
  if (alreadyUp) return body()

  const server = Bun.spawn(['bun', 'run', 'dev'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore' })
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      const up = await fetch(BASE_URL).then(
        () => true,
        () => false
      )
      if (up) return await body()
      await Bun.sleep(500)
    }
    throw new Error(`Dev server did not come up at ${BASE_URL}`)
  } finally {
    server.kill()
  }
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2)
  const selected =
    wanted.length === 0 ? SHOTS : SHOTS.filter((shot) => wanted.some((arg) => shot.file.startsWith(arg)))

  if (selected.length === 0) {
    console.error(`No shot matched ${wanted.join(', ')}. Known shots:`)
    for (const shot of SHOTS) console.error(`  ${shot.file}`)
    process.exit(1)
  }

  mkdirSync(OUT_DIR, { recursive: true })

  await withDevServer(async () => {
    // CHROMIUM_PATH is the same escape hatch playwright.config.ts offers, for a
    // machine that has a working Chromium but not the revision Playwright wants.
    const browser = await chromium.launch(
      process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
    )
    try {
      for (const shot of selected) await run(browser, shot)
    } finally {
      await browser.close()
    }
  })
}

await main()
