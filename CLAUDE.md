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
`docs/troubleshooting-scenarios.md` maps thirteen real BGP faults to what the
tool does and does not say about each, and is the fastest way to understand what
this app is *for*.

## Environment caveats

These bite on a fresh container and neither is a bug in the repo. Both are
per-container: a new session starts from the same state.

### DuckDB WASM cannot read JSON here

The loader inserts via `read_json_auto` (`src/lib/db/loader.ts`), and that
function traps in this container's Chromium — `RuntimeError: null function or
function signature mismatch`. DuckDB itself is fine; `select 1` and `version()`
return normally. Only the JSON reader is affected.

What you will see, and should not go chasing:

- a **"1 warning loading this capture"** banner on every capture,
- **"This capture could not be loaded into DuckDB, so SQL is unavailable"** with
  the SQL console's textarea disabled,
- **15 of 83 e2e tests failing** — all of `sql-console.e2e.ts`, the "EVPN reaches
  the database" block, `warnings.e2e.ts`, and two filter tests. 68 pass.

The app degrades on purpose: filtering falls back to the in-memory evaluator, so
every screen except the SQL console still works. CI does not have this problem.

If you need the SQL console to verify something, patch `insertJsonData` in
`src/lib/db/loader.ts` to emit `INSERT INTO … VALUES` batches instead of
`read_json_auto`, and **revert it before committing** — it is a sandbox
workaround, not an improvement.

### Playwright cannot find its browser

`bun run test:e2e` fails out of the box with *"Looks like Playwright was just
installed or updated"*. The container ships Chromium revision **1194** at
`/opt/pw-browsers`, the pinned `@playwright/test` 1.61.1 wants revision **1228**,
and the directory layout changed between them. `bunx playwright install` does not
help — the CDN is blocked by the agent proxy (403 `host not permitted`).

Bridge the two with symlinks, once per container:

```bash
# headless shell: 1.61.1 expects chrome-headless-shell-linux64/chrome-headless-shell
mkdir -p /opt/pw-browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64
for f in /opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/*; do
  ln -sfn "$f" /opt/pw-browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/"$(basename "$f")"
done
ln -sfn /opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  /opt/pw-browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell
touch /opt/pw-browsers/chromium_headless_shell-1228/{INSTALLATION_COMPLETE,DEPENDENCIES_VALIDATED}

# full browser: expects chrome-linux64/chrome
mkdir -p /opt/pw-browsers/chromium-1228/chrome-linux64
for f in /opt/pw-browsers/chromium-1194/chrome-linux/*; do
  ln -sfn "$f" /opt/pw-browsers/chromium-1228/chrome-linux64/"$(basename "$f")"
done
touch /opt/pw-browsers/chromium-1228/{INSTALLATION_COMPLETE,DEPENDENCIES_VALIDATED}
```

For a one-off script rather than the suite, skip all of that and launch the
version-agnostic symlink directly:

```ts
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
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

Generate captures to feed it with `bun run testlab/scenarios.ts` (thirteen
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
