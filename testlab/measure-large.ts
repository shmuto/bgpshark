/**
 * Load large captures into the production build and record what each screen
 * costs: time, JS heap and the longest task.
 *
 *   bun run testlab/large-captures.ts              # write the captures first
 *   bunx vite build && bunx vite preview &         # serve the production build (real CSP)
 *   bun run testlab/measure-large.ts               # every capture in testlab/out/large/
 *   bun run testlab/measure-large.ts U-300mb.pcap --json out.json
 *
 * Each capture is opened in a fresh Chromium and walked through the screens a
 * user would visit, in order:
 *
 *   load       drop the file; the packet list shows `Showing N of M packets`
 *   findings   the findings column stops saying they are being worked out
 *   suggest    `prefix = ` typed into the filter box offers a CIDR
 *   filter     `prefix = 20.0.0.0/8` applied, the list settled
 *   routes     the Routes screen shows its route list
 *   sql        the SQL console has the capture in DuckDB, and a query on
 *              `duckdb_memory()` has answered
 *
 * For each stage it records the wall time, the heap at its largest (sampled
 * every 100ms over the DevTools protocol, which answers while the page is
 * busy), the heap in use once garbage is collected (`gc()` twice, then
 * `performance.memory.usedJSHeapSize`), and the longest task the page's own
 * `longtask` observer saw. A crashed tab is reported as such rather than as a
 * timeout. The DuckDB worker is a separate heap and not in these figures; the
 * `duckdb_memory()` answer says what it holds.
 *
 * Captures above the size limit in `src/lib/file-constraints.ts` are refused
 * by the drop zone, so measuring one means raising the limit in a local build
 * only — never commit that.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { chromium, type CDPSession, type Page } from '@playwright/test'
import { LARGE_OUT_DIR } from './large-captures'

const DEFAULT_URL = 'http://localhost:4173/bgpshark/'
const DEFAULT_CHROMIUM = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'
const STAGE_TIMEOUT_MS = 10 * 60_000

export interface StageResult {
  stage: string
  seconds: number
  /** Largest heap seen during the stage, in bytes. */
  peakHeap: number
  /** Heap after two forced collections at the end of the stage, in bytes. */
  liveHeap: number
  /** Longest task that started during the stage, in milliseconds. */
  longestTask: number
  /**
   * Largest resident memory of the tab's renderer process during the stage,
   * in bytes. Not the JS heap: it also holds what the heap does not count —
   * typed arrays' buffers, the capture file itself, the DuckDB worker and its
   * WebAssembly memory.
   */
  peakRss: number
}

export interface CaptureResult {
  capture: string
  megabytes: number
  stages: StageResult[]
  crashed: boolean
  error?: string
  /** The packet counter once loaded. */
  packets?: string
  /** `duckdb_memory()`'s total, as DuckDB formats it. */
  duckdbMemory?: string
}

declare global {
  interface Window {
    __longTasks: Array<{ start: number; duration: number }>
    gc?: () => void
  }
}

/** Heap sampling over CDP, so a busy main thread does not hide the peak. */
class HeapSampler {
  private peak = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight = false

  constructor(private readonly cdp: CDPSession) {}

  start(): void {
    this.peak = 0
    this.timer = setInterval(() => {
      if (this.inFlight) return
      this.inFlight = true
      this.cdp
        .send('Runtime.getHeapUsage')
        .then((usage) => {
          this.peak = Math.max(this.peak, usage.usedSize)
        })
        .catch(() => {})
        .finally(() => {
          this.inFlight = false
        })
    }, 100)
  }

  stop(): number {
    clearInterval(this.timer)
    return this.peak
  }
}

/**
 * The largest renderer process's resident memory, read from /proc every 200ms
 * (Linux only; zero elsewhere). One capture is measured at a time, so the
 * largest renderer is the tab's.
 */
class RssSampler {
  private peak = 0
  private timer: ReturnType<typeof setInterval> | undefined

  start(): void {
    this.peak = 0
    this.timer = setInterval(() => {
      this.peak = Math.max(this.peak, rendererRss())
    }, 200)
  }

  stop(): number {
    clearInterval(this.timer)
    return Math.max(this.peak, rendererRss())
  }
}

function rendererRss(): number {
  if (!existsSync('/proc')) return 0
  let largest = 0
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')) continue
      const kb = Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] ?? 0)
      largest = Math.max(largest, kb * 1024)
    } catch {
      // The process ended between listing and reading.
    }
  }
  return largest
}

async function liveHeap(page: Page): Promise<number> {
  return page.evaluate(async () => {
    // Twice, with a turn of the event loop between, so that what a first
    // collection's finalisers release is collected too.
    window.gc?.()
    await new Promise((resolve) => setTimeout(resolve, 50))
    window.gc?.()
    return (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize
  })
}

async function measureCapture(path: string, url: string, executablePath: string | undefined): Promise<CaptureResult> {
  const result: CaptureResult = {
    capture: basename(path),
    megabytes: Number((Bun.file(path).size / 1024 / 1024).toFixed(1)),
    stages: [],
    crashed: false,
  }
  const browser = await chromium.launch({
    executablePath,
    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
  })
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    page.setDefaultTimeout(STAGE_TIMEOUT_MS)
    page.on('crash', () => {
      result.crashed = true
    })
    await page.addInitScript(() => {
      window.__longTasks = []
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__longTasks.push({ start: entry.startTime, duration: entry.duration })
        }
      }).observe({ type: 'longtask', buffered: true })
    })
    const cdp = await context.newCDPSession(page)
    const sampler = new HeapSampler(cdp)
    const rss = new RssSampler()

    await page.goto(url, { waitUntil: 'networkidle' })

    const stage = async (name: string, work: () => Promise<void>) => {
      if (result.crashed) throw new Error('tab crashed')
      const startedAt = await page.evaluate(() => performance.now())
      sampler.start()
      rss.start()
      const t0 = performance.now()
      await work()
      const seconds = (performance.now() - t0) / 1000
      const peakHeap = sampler.stop()
      const peakRss = rss.stop()
      const longestTask = await page.evaluate(
        (from) => Math.max(0, ...window.__longTasks.filter((t) => t.start >= from).map((t) => t.duration)),
        startedAt
      )
      const live = await liveHeap(page)
      const row = { stage: name, seconds, peakHeap: Math.max(peakHeap, live), liveHeap: live, longestTask, peakRss }
      result.stages.push(row)
      console.log(
        `  ${name.padEnd(9)} ${seconds.toFixed(1).padStart(6)}s  peak ${gb(row.peakHeap)}  live ${gb(live)}  ` +
          `longest task ${(longestTask / 1000).toFixed(2)}s  renderer ${gb(peakRss)}`
      )
    }

    const counter = page.getByText(/Showing \d+ of \d+ packets/).first()

    await stage('load', async () => {
      await page.locator('input[type="file"]').first().setInputFiles(path)
      await counter.waitFor()
      result.packets = (await counter.textContent()) ?? undefined
    })

    await stage('findings', async () => {
      await page.getByTestId('findings-pending').waitFor({ state: 'detached' })
    })

    const input = page.locator('input[type="text"]').first()
    await stage('suggest', async () => {
      await input.click()
      await input.fill('prefix = ')
      // The suggestion list is a plain div of buttons; a CIDR among them is
      // the prefix suggestions having been gathered.
      await page.locator('div:not([role]) > button', { hasText: /^\s*\d+\.\d+\.\d+\.\d+\/\d+/ }).first().waitFor()
    })

    await stage('filter', async () => {
      await input.fill('prefix = 20.0.0.0/8')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Escape')
      // The pass is debounced, so "filtering..." may not be up yet.
      await page.waitForTimeout(600)
      await page.getByText('filtering...').waitFor({ state: 'detached' })
    })

    await stage('routes', async () => {
      await page.getByRole('link', { name: 'Routes', exact: true }).click()
      // The heading renders with the sorted list, not before it; the findings
      // column can say "N prefixes" too, so that text alone is no sign.
      await page.locator('#routes-prefix-statistics').waitFor()
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))))
    })

    await stage('sql', async () => {
      await page.getByRole('link', { name: 'SQL', exact: true }).click()
      const editor = page.locator('textarea').first()
      await editor.waitFor()
      await page.waitForFunction(() => !document.querySelector('textarea')?.disabled, undefined, {
        timeout: STAGE_TIMEOUT_MS,
        polling: 200,
      })
      await editor.fill(
        "select format_bytes(sum(memory_usage_bytes)::bigint) as total from duckdb_memory()"
      )
      await page.keyboard.press('Control+Enter')
      await page.getByText(/Results \(|Error:/).first().waitFor()
      const main = await page.getByRole('main').innerText()
      result.duckdbMemory = main.match(/\d+(\.\d+)?\s*[KMG]i?B/)?.[0]
    })
  } catch (e) {
    result.error = e instanceof Error ? e.message.split('\n')[0] : String(e)
    console.log(`  failed: ${result.crashed ? 'tab crashed' : result.error}`)
  } finally {
    await browser.close()
  }
  return result
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`
}

/** A Markdown table of the results, one row per capture. */
export function summarize(results: CaptureResult[]): string {
  const at = (r: CaptureResult, name: string) => r.stages.find((s) => s.stage === name)
  const sec = (s: StageResult | undefined) => (s ? `${s.seconds.toFixed(1)}s` : '—')
  const lines = [
    '| Capture | List | Findings | Suggest | Filter | Routes | SQL | Live heap at most | Peak heap | Longest task | Renderer at most | DuckDB |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of results) {
    const live = Math.max(0, ...r.stages.map((s) => s.liveHeap))
    const peak = Math.max(0, ...r.stages.map((s) => s.peakHeap))
    const task = Math.max(0, ...r.stages.map((s) => s.longestTask))
    const rssPeak = Math.max(0, ...r.stages.map((s) => s.peakRss))
    lines.push(
      `| ${r.capture} (${r.megabytes} MiB) | ${sec(at(r, 'load'))} | ${sec(at(r, 'findings'))} | ${sec(at(r, 'suggest'))} | ` +
        `${sec(at(r, 'filter'))} | ${sec(at(r, 'routes'))} | ${sec(at(r, 'sql'))} | ${gb(live)} | ${gb(peak)} | ` +
        `${(task / 1000).toFixed(2)}s | ${gb(rssPeak)} | ${r.crashed ? 'tab crashed' : r.error ? `failed: ${r.error}` : (r.duckdbMemory ?? '—')} |`
    )
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args.splice(at, 2)[1] : undefined
  }
  const url = option('--url') ?? DEFAULT_URL
  const json = option('--json')
  const executablePath = process.env.CHROMIUM_PATH ?? DEFAULT_CHROMIUM
  const paths =
    args.length > 0
      ? args.map((arg) => (existsSync(arg) ? resolve(arg) : join(LARGE_OUT_DIR, arg)))
      : readdirSync(LARGE_OUT_DIR)
          .filter((name) => name.endsWith('.pcap'))
          .sort()
          .map((name) => join(LARGE_OUT_DIR, name))

  const results: CaptureResult[] = []
  for (const path of paths) {
    console.log(basename(path))
    results.push(await measureCapture(path, url, existsSync(executablePath) ? executablePath : undefined))
  }
  console.log('\n' + summarize(results))
  if (json) writeFileSync(json, JSON.stringify(results, null, 2))
}
