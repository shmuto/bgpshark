# Working on BGPShark

Notes for an AI agent starting a session here. The [README](README.md) covers
what the app is and how it is put together; this covers what is not obvious from
reading the code, and what will waste your time if you discover it the hard way.

## Orientation

A browser-based pcap analyzer for BGP session troubleshooting. Everything runs
client-side: parse in the browser, query with DuckDB WASM, persist in IndexedDB.
No server, no third-party requests.

```bash
bun install
bun run dev        # http://localhost:5173/bgpshark/
bun test           # parsers and prefix arithmetic, no browser  (~350 tests, fast)
bun run test:e2e   # drives the real app in Chromium — see the caveat below
bun run lint
bun run build      # tsc -b && vite build
```

`README.md` has the architecture table and the filter syntax reference.
`docs/design.md` is the requirements and technical design;
`docs/troubleshooting-scenarios.md` maps fourteen real BGP faults to what the
tool does and does not say about each, and is the fastest way to understand what
this app is *for*.

## Running the browser tests

`bun run test:e2e` fails out of the box in a container that cannot download
browsers, with *"Looks like Playwright was just installed or updated"*. This one
ships Chromium revision **1194** at `/opt/pw-browsers`, the pinned
`@playwright/test` 1.61.1 wants revision **1228**, the directory layout changed
between the two, and `bunx playwright install` cannot fix it because the CDN is
blocked by the agent proxy (403 `host not permitted`).

Point `CHROMIUM_PATH` at the binary and the revision lookup is skipped:

```bash
CHROMIUM_PATH=/opt/pw-browsers/chromium bun run test:e2e
```

Same for a one-off script:

```ts
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
```

Expect **98 passing**. If more than a couple fail, something is actually wrong.

One test is flaky *in this container* and nowhere else:
`navigation.e2e.ts:21` ("reloading keeps the screen you were on") waits on an
IndexedDB restore, and loses the race under parallel load. It passes reliably at
`--workers=2` and always in isolation. Re-run it alone before believing it.

## What used to bite here, and does not any more

Worth knowing because the symptoms are memorable and you may find them in older
notes or a stale branch.

Loading any capture used to raise *"1 warning loading this capture"* and
*"This capture could not be loaded into DuckDB, so SQL is unavailable"*, with a
wasm trap in the console. That was not an environment quirk: the loader inserted
rows via `read_json_auto`, DuckDB's JSON reader is an **extension**, and DuckDB
WASM downloads extensions from `extensions.duckdb.org` on first use. The
production CSP is `connect-src 'self' blob: data:`, so the download could not
succeed there either — **the SQL console was broken on the deployed site**, and
this container merely surfaced it early by blocking the same request.

The loader now inserts with literal `VALUES` (`insertRows` in
`src/lib/db/loader.ts`) and touches no network at all.
`tests/e2e/offline.e2e.ts` asserts that no request leaves the origin while a
capture is loaded and queried, which is the assertion that generalises: it holds
whether or not a CSP is there to catch the violation.

**The e2e suite drives the dev server, which ships no CSP** (`vite.config.ts`
injects it at build time only). That is the gap that let this ship. When
touching anything that fetches, verify against the real thing:

```bash
bun run build && bun run preview     # http://localhost:4173/bgpshark/
```

## Driving the app from a script

Much of this app's behaviour is only visible in a browser, and reading the
components is a poor substitute for loading a capture and looking. A throwaway
Playwright script beats adding a test when you are still investigating:

```ts
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`))

await page.goto('http://localhost:5173/bgpshark/', { waitUntil: 'networkidle' })
await page.locator('input[type="file"]').first().setInputFiles({
  name: 'x.pcap', mimeType: 'application/vnd.tcpdump.pcap', buffer: readFileSync(path),
})
await page.waitForURL('**/messages')
await page.waitForTimeout(2500)          // parse + DuckDB load
console.log(await page.locator('body').innerText())
```

`page.locator('body').innerText()` is the highest-signal assertion available —
the screens are text-dense, so one dump usually answers the question. See
`tests/e2e/helpers.ts` for the same moves written properly.

Generate captures to feed it with `bun run testlab/scenarios.ts` (fourteen
troubleshooting scenarios) or the `src/lib/build` library directly. Do not go
looking for pcaps to download.

### UI facts that cost time to rediscover

- **Capability Diff** lives at Neighbors → click a *router* → click a *session*.
  It does not appear at the router level.
- **Filter errors** render next to the "Showing N of M packets" counter, not
  under the input. An invalid expression shows the error *and* leaves the list
  unfiltered — "Showing 5 of 5" next to a red message means the filter did not
  apply, not that everything matched.
- **TCP-level frames** (SYN, RST, FIN) only appear with the packet list switched
  to **All Packets**; the default is BGP only.

## Conventions

- **Comments explain why, at length.** This codebase leans on prose — file-level
  docblocks that state what a module is for and which failure it exists to
  prevent. Match that register; do not strip it back to terse one-liners.
- **Tests mirror source.** `tests/lib/**` mirrors `src/lib/**` and runs under
  `bun test`. Browser tests are `tests/e2e/*.e2e.ts` — named `.e2e.ts` and not
  `.spec.ts` precisely so `bun test` cannot pick them up.
- **Fixtures are built, not committed.** See `evpnCapture()` in
  `tests/e2e/helpers.ts`: a capture written next to the assertions that depend on
  it, so what it contains stays legible. `testlab/scenarios.ts` follows the same
  rule and gitignores its output.
- **Filters have two backends.** A filter expression is parsed to an AST once,
  then either evaluated in memory (`src/lib/filter/parser.ts`) or compiled to SQL
  (`src/lib/db/filter-to-sql.ts`). A change to filter semantics has to land in
  both, and the e2e suite only covers the SQL path when DuckDB is up.
- **`tsconfig.json` includes `src`, `tests` and `testlab`**, so `bun run build`
  typechecks scripts too.
- **Dashboard alert rules are specified, not just implemented.** `design.md`
  §2.1.14 lists every rule with what it fires on *and* what it must stay quiet
  about. Adding a rule means adding a row and naming the capture that would
  make it a false positive — the corpus in `testlab/scenarios.ts` usually
  already holds one.
- **Prose ships as Markdown, converted at build time.** The user manual is
  `src/pages/manual/manual.md`; `markdownPlugin` in `vite.config.ts` turns an
  imported `.md` into a string of HTML, so `marked` is a devDependency and no
  Markdown parser reaches the browser. Edit the Markdown, not the component.
  The plugin also slugs `h2`/`h3` ids, which is how the page builds its own
  table of contents and how `/manual#filters` works.
- **The manual's screenshots are generated, and are not optional.** `bun run
  screenshots` (`testlab/screenshots.ts`) drives the real app over the scenario
  captures and writes `public/manual/*.png`, which *are* committed. Re-run it
  after changing any screen the manual points at, and commit what changes — the
  script fails rather than photographing the wrong thing when a click path
  breaks, but nothing re-runs it for you. It starts its own dev server if one is
  not already up, and takes `CHROMIUM_PATH` like the e2e suite does.
  In the Markdown the images are written `![alt](manual/x.png)`: the plugin
  prefixes the base path, reads the PNG's dimensions so lazy loading does not
  shift the page under a `#anchor`, and turns the alt text into a caption.

### Known inconsistency

The two filter backends disagree on negation. In memory, `prefix != 10.0.0.0/8`
only ever matches UPDATE packets — the evaluator loops over UPDATE messages and
returns false when there are none (`parser.ts`, the `prefix` case) — while the
SQL backend also returns OPENs and KEEPALIVEs, which carry no prefix and
therefore do not match the negated condition. `prefix-matching.e2e.ts:34` pins
the SQL answer; the in-memory answer is only visible when DuckDB is unavailable.
Worth knowing before concluding a filter is broken.

## Git

Branch, commit and push as instructed for the session. Do not open a pull request
unless asked.
