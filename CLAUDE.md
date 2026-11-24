# Working on BGPShark

Quick orientation and invariants for contributors and AI agents working in this repository. For product overview, see [`README.md`](README.md); for architecture diagrams (load pipeline, filter backends, findings, CI), see [`docs/architecture.md`](docs/architecture.md); for specifications, see [`docs/design.md`](docs/design.md) and [`docs/troubleshooting-scenarios.md`](docs/troubleshooting-scenarios.md).

## Commands

```bash
bun install
bun run dev          # Dev server at http://localhost:5173/bgpshark/ (no CSP)
bun test             # Unit tests under tests/lib
bun run test:e2e     # Playwright e2e suite under tests/e2e (Chromium + DuckDB WASM)
E2E_PREVIEW=1 bun run test:e2e  # Same suite against the production build, with the real CSP (what CI runs)
bun run lint         # ESLint
bun run build        # Type-check (src, tests, testlab) + production build to dist/
bun run preview      # Serve production build (with real CSP) at http://localhost:4173/bgpshark/
bun run screenshots  # Regenerate manual screenshots in public/manual/
bun run og-image     # Regenerate the link-preview card public/og-image.png (uses public/manual/workspace.png)
```

In environments where Playwright cannot download its pinned browser or a system Chromium/Chrome binary is preinstalled, pass `CHROMIUM_PATH` to skip the revision lookup:

```bash
CHROMIUM_PATH=/path/to/chromium bun run test:e2e
```

## Critical invariants

- **Strict production CSP & zero third-party requests:**
  - `vite.config.ts` injects the Content Security Policy at **build time only**—the dev server ships no CSP.
  - Production forbids all off-origin fetches (`connect-src 'self' blob: data:`) and forbids dynamic code evaluation (`script-src 'self' 'wasm-unsafe-eval'`, no `eval` or `new Function`).
  - Never use DuckDB features that download remote extensions (e.g. `read_json_auto`) or libraries that rely on `new Function` (e.g. `apache-arrow` high-level builders—`src/lib/db/loader.ts` constructs Arrow IPC buffers manually for this reason).
  - Whenever touching asset loading, DuckDB queries, or dependencies, verify with `bun run build && bun run preview` and `tests/e2e/offline.e2e.ts`.
- **Dual filter backends:** Filter expressions are parsed once into an AST (`src/lib/filter/parser.ts`) and executed either via DuckDB SQL (`src/lib/db/filter-to-sql.ts`) or in memory when DuckDB is unavailable. Any change to filter fields or semantics must be applied to **both** backends.
  - *Known difference on negation:* In memory, `prefix != 10.0.0.0/8` matches only UPDATE packets, whereas the SQL backend also returns OPENs and KEEPALIVEs (pinned by `tests/e2e/prefix-matching.e2e.ts`).
- **Alert rules are specified:** [`docs/design.md`](docs/design.md) §2.1.14 defines every rule's trigger conditions and required false-positive exclusions. When adding or modifying an alert rule, update that table and test against the scenario corpus in `testlab/scenarios.ts`.
- **Manual prose & screenshots:**
  - The user manual (`src/pages/manual/manual.md` and `manual.ja.md`) is converted to HTML at build time by `markdownPlugin` in `vite.config.ts`. Edit the Markdown files, not `ManualPage.tsx`.
  - Keep `h2`/`h3` anchor IDs strictly synchronized between English and Japanese (Japanese headings use explicit `{#id}` suffixes; enforced by `tests/e2e/manual.e2e.ts`).
  - Manual screenshots (`public/manual/*.png`) are committed. Re-run `bun run screenshots` after changing any UI referenced by the manual and commit updated images.

## Testing & conventions

- **Tests mirror source:** Unit tests live in `tests/lib/**` (`bun test`). Browser specs live in `tests/e2e/*.e2e.ts` (named `.e2e.ts` so `bun test` does not execute them). See `tests/e2e/helpers.ts` for shared capture-loading helpers.
- **Build test fixtures in code:** Generate captures using `src/lib/build` or `bun run testlab/scenarios.ts` rather than committing opaque binary pcaps.
- **Type-checking covers scripts:** `tsconfig.json` includes `src`, `tests`, and `testlab`, so `bun run build` validates test and lab scripts too.
- **Comments explain *why*:** Preserve and match the codebase's existing docblocks explaining module rationale and prevented failure modes.
- **UI navigation notes for debugging:**
  - **Capability Diff** appears on the **Sessions** tab once a session is chosen (in the workspace's left column or the tab's own table); with none chosen the tab is a table of sessions.
  - **Filter errors** render in a red row directly under the filter box (`data-testid="filter-error"`), in the UI language, and leave the list unfiltered.
  - **TCP-level frames** (`SYN`, `RST`, `FIN`) appear only when the packet list is switched to **All Packets**.

## Git

Branch, commit, and push as instructed for the session. Do not open a pull request unless asked.

Releases: add the version's section to `CHANGELOG.md` and bump `package.json` in a pull request; after it merges, push the tag `v<version>` on that `main` commit. `.github/workflows/release.yml` refuses a tag that does not match `package.json`.
