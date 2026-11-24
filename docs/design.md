# BGPShark — Requirements & Technical Design

> Authoritative design reference for the current implementation.
> For diagrams of how the modules fit together (load pipeline, filtering, findings, CI), see [`architecture.md`](architecture.md).
> For the rationale behind the DuckDB WASM architecture, see [`design-duckdb-wasm.md`](design-duckdb-wasm.md).
> For fault-coverage tracking across 14 troubleshooting scenarios, see [`troubleshooting-scenarios.md`](troubleshooting-scenarios.md).

## 1. Project Overview

- **Name:** BGPShark (package / repository: `bgpshark`)
- **Concept:** A browser-based pcap analyzer specialized for BGP session troubleshooting without installing Wireshark.
- **Target users:** IXP operators, ISP NOC engineers, network engineers, and networking students.
- **Hosting:** Static SPA on GitHub Pages (`/bgpshark/`).

---

## 2. Functional Requirements

### 2.1 Implemented Features

#### 2.1.1 Capture Loading
- Drag & drop anywhere in the app or file picker on the upload screen
- Supported formats: libpcap (`.pcap`, `.cap`) and pcapng (`.pcapng`), auto-detected by magic number, up to 100 MB (`src/lib/file-constraints.ts`)
- Client-side parsing only; the loaded file is persisted in IndexedDB (as a Blob, saved after the list is shown and not awaited) and restored on reload

#### 2.1.2 BGP Message Extraction
- Extracts BGP sessions on TCP port 179 and detects BGP on non-standard ports by the 16-byte marker (`src/lib/pcap/bgp-detect.ts`)
- Retains non-BGP IP/TCP frames so **All Packets** mode can display TCP handshakes, RSTs, and FINs
- Supports IPv4 and IPv6 transport (`src/lib/pcap/ipv6.ts`), Ethernet II and Linux SLL link types, and strips 802.1Q / QinQ tags
- Reassembles BGP messages split across TCP segments and extracts multiple BGP messages from a single TCP segment
- Recognizes all five BGP message types: `OPEN` (1), `UPDATE` (2), `NOTIFICATION` (3), `KEEPALIVE` (4), and `ROUTE_REFRESH` (5)

#### 2.1.3 OPEN Message Analysis
Decodes Version, My Autonomous System (2-byte/4-byte), Hold Time, BGP Identifier, and Optional Parameters.

Structured capability parsers (`src/lib/bgp/open.ts`):
- Multiprotocol Extensions (Code 1) — AFI/SAFI
- Route Refresh (Code 2)
- Extended Next Hop Encoding (Code 5)
- Graceful Restart (Code 64)
- 4-byte AS Number (Code 65)
- ADD-PATH (Code 69) — per-AFI/SAFI send/receive
- Enhanced Route Refresh (Code 70)

Other IANA-assigned capability codes are named via `CapabilityCodeNames` (`src/lib/bgp/constants.ts`) with raw bytes; unassigned codes are displayed as unknown rather than dropped.

#### 2.1.4 NOTIFICATION Message Analysis
Displays Error Code, Error Subcode, decoded Data (above the raw hex dump), a troubleshooting hint (`src/lib/bgp/errors.ts`), and—for Hold Timer Expired—silence analysis.

- **Data field decoding (`src/lib/bgp/notification-data.ts`):** Implements RFC 4271 §6 and RFC 9003 decodings for rejected message length/type (code 1), unsupported version / bad peer AS / unsupported capabilities (code 2), offending UPDATE attribute with flags (code 3), and Cease shutdown communication text (code 6). Malformed or unspecified payloads fall back to raw hex; raw bytes are always shown underneath the decoded view.
- **Hold Timer Expired silence (`src/lib/bgp/hold-timer.ts`):** Measures elapsed time from the last message sent by the **NOTIFICATION's destination** (the peer that went quiet) to the teardown, compared against the lower Hold Time from the most recent OPEN pair preceding that teardown.
  - Silence ≥ negotiated hold time: normal hold-timer expiry (points to one-way reachability).
  - Silence < negotiated hold time: flagged as firing early (possible packet loss in capture or differing active hold time).
  - Missing OPENs: reports silence without a hold-time comparison.
  - No prior peer messages: reported explicitly rather than as `0s`.
  - Computed against the unfiltered packet list so active filters do not alter the result.

#### 2.1.4b ROUTE-REFRESH Diff (`src/lib/bgp/route-refresh.ts`)
Selecting a ROUTE-REFRESH message compares the peer's advertised table before and after the refresh (always against the unfiltered packet list):

| Property | Behavior |
|----------|----------|
| Target table | The refresh's **destination** (the peer asked to re-advertise) |
| Re-advertisement window | From the refresh until the peer's End-of-RIB, the next refresh, or end of capture |
| Diff categories | **Added**, **No longer advertised** (inferred from absence in the re-advertisement, not withdrawals), **Attributes changed** (AS_PATH, MED, LOCAL_PREF, Next Hop, or communities), and a count of unchanged routes |
| Boundary warnings | Explicitly notes when the capture began mid-session (incomplete "before" table) or ended without an End-of-RIB |

#### 2.1.5 Packet List View
Virtualized grid showing frame number, timestamp, source/destination IP (plus optional port columns), BGP message type, and a concise **Info** summary (`src/lib/packet-columns.ts`), with **Export** to write the filtered frames back to `.pcap` (`src/lib/pcap/writer.ts`).

#### 2.1.6 Detail View
Structured per-message-type view (`src/components/message/`) paired with a raw hex dump.

#### 2.1.7 UPDATE Message Analysis (`src/lib/bgp/update.ts`)
Parses standard and multiprotocol path attributes: `ORIGIN` (1), `AS_PATH` (2), `NEXT_HOP` (3), `MULTI_EXIT_DISC` (4), `LOCAL_PREF` (5), `ATOMIC_AGGREGATE` (6), `AGGREGATOR` (7), `COMMUNITIES` (8), `ORIGINATOR_ID` (9), `CLUSTER_LIST` (10), `MP_REACH_NLRI` (14), `MP_UNREACH_NLRI` (15), `EXTENDED_COMMUNITIES` (16), `AS4_PATH` (17), `AS4_AGGREGATOR` (18), and `LARGE_COMMUNITIES` (32), plus EVPN NLRI decoding (`src/lib/bgp/evpn.ts`).

**Mid-session decoding for 4-byte AS and ADD-PATH (RFC 7911):**
Because AS width and ADD-PATH Path Identifiers are negotiated in OPEN and absent from UPDATE headers, `UpdateDecoding` distinguishes "ruled out by OPEN" from "OPENs not captured" (`null`). When OPENs are missing, the parser infers the encoding structurally:
1. If only one reading consumes the NLRI block cleanly, use it and attach a packet parse warning.
2. If both readings fit but plain decoding fabricates multiple default routes (`0.0.0.0/0` from zero-padded Path IDs), decode as ADD-PATH with a warning.
3. If neither criterion distinguishes them, fall back to plain decoding with a warning.
4. If neither fits, surface the underlying prefix-length error.

Path Identifiers are retained per prefix and displayed on packet detail chips and in the Route Analysis **Path ID** column.

#### 2.1.8 Analysis Views
- **Workspace (`src/components/workspace/`):** The analysis views below are tabs of one workspace. Its left column lists the capture's **Sessions** (address pairs, worst finding per session) and its **Findings** (alerts folded by kind, §2.1.14). Choosing a session sets the workspace **scope** (opening a finding does not; its link already filters to the session, and the findings list stays whole so its instances can be stepped through): Messages and Routes show only that session's packets, and Findings only that session's findings plus those with no session. Above the tabs, a **time strip** (`TimeStrip.tsx`) draws the scope's message volume over the whole capture, with NOTIFICATIONs as rules; dragging across it sets a **time window** that narrows Messages and Routes the same way (a click without a drag clears it). Findings, the Sessions tab's OPEN comparison and SQL are not narrowed by the window: what was negotiated and what the rules found are properties of the capture. Scope and window are held by the workspace layout, so they survive tab changes and are dropped with the capture. Findings are computed in memory, so they stay available without DuckDB. A freshly loaded capture lands on Messages (a deep link's original destination is still honoured); `/dashboard` redirects there, keeping its query string.
- **Message Explorer (`/messages`):** Filter bar, virtualized packet list, detail view, hex dump, and filtered `.pcap` export.
- **Sessions (`/sessions`):** With no session chosen, a table of every session (state at end of capture, message counts, worst finding). With one chosen, its OPEN comparison (§2.1.10), negotiated hold time, per-direction prefix counts, and its OPEN/NOTIFICATION events (or every message). Old `/neighbors?router=&peer=` links redirect here and choose the session they named.
- **Route Analysis (`/routes`):** Per-prefix announce/withdraw history, flap counts, AS_PATH analysis, and best-path attribute columns (shown only when present on the selected route; `ORIGIN` shown only when values differ).
- **SQL Console (`/sql`):** Ad-hoc SQL queries against DuckDB WASM with schema sidebar and templates.
- **Capture Builder (`/builder`):** §2.1.12.
- **User Manual (`/manual`):** §2.1.13.

Screen state is synchronized with URL query parameters (`?filter=`, `?selected=`, `?frame=`, `?all=1`, and route search/sort/mode).

#### 2.1.9 Filtering
One always-visible query box with autocomplete (focused by `/` or Ctrl/⌘+K), plus a **+ Filter** popover that builds a condition from menus and appends it to the box, so the text on screen is always the filter in effect. Packet-detail values (addresses, prefixes, ASNs, next hops, communities) offer "add to filter" / "filter on". Grammar: `field (= | == | != | contains | not contains | < | <= | > | >=) value`, combined with `and`, `or`, `not`, and parentheses. Ordered operators apply to numeric fields only.

`ip` / `peer` and bare values are rewritten into ordinary comparisons while parsing, so both backends see only canonical fields: `ip <op> X` becomes `src_ip <op> X or dst_ip <op> X` (`and` for `!=` / `not contains`); a bare address becomes `ip = X`, a bare CIDR `prefix = X`, `AS<n>` `asn = n`, a bare MAC `mac = X`, and a bare message type `type = X`.

Expressions parse once into an AST (`src/lib/filter/parser.ts`) and run either via DuckDB SQL (`src/lib/db/filter-to-sql.ts`) or in memory when DuckDB is unavailable. Optional numeric attributes (`med`, `local_pref`) are never coerced to `0`: an UPDATE lacking the attribute matches no comparison on that field in either backend.

#### 2.1.10 Capability Diff (`src/components/neighbor/CapabilityDiff.tsx`)
Choosing a session (the workspace scope) shows its two latest OPEN messages side by side on `/sessions`:
- Compares session header fields first (version mismatch, duplicate BGP Identifier, and inconsistent 2-byte/4-byte AS are errors; differing Hold Time is informational).
- Compares capabilities as a three-state diff (both, local only, remote only) with both icon and text label, sorting mismatches before matches. Multiprotocol Extensions and ADD-PATH are compared per AFI/SAFI pair and deduplicated within each OPEN.
- Renders an **ADD-PATH Result** section when both OPENs are present and at least one peer advertises ADD-PATH, reporting the crosswise send/receive outcome per direction and AFI/SAFI via `addPathDirections` (`src/lib/bgp/session.ts`).
- Handles one-sided or missing OPENs gracefully with an informational notice.

#### 2.1.11 Theming
Light and dark themes following the system preference by default, with a header toggle cycling `light → dark → system` persisted in `localStorage` (`src/hooks/useTheme.ts`). Semantic CSS custom properties in `src/index.css` are mapped to Tailwind tokens in `tailwind.config.js`.

#### 2.1.12 Capture Builder (`src/lib/build/`)
Synthesizes valid `.pcap` files from a peer and step specification (`scenario.ts`, `bgp-encode.ts`, `frame.ts`, `presets.ts`) without requiring a loaded capture. UPDATE encoding (4-byte AS width, ADD-PATH Path Identifiers) is derived from the OPEN capabilities, TCP segment boundaries follow the configured MTU, and IPv4/TCP checksums and Ethernet minimum padding are computed cleanly (`tests/lib/build/checksums.test.ts`). Also used as a library by `testlab/scenarios.ts`.

#### 2.1.13 User Manual (`src/pages/ManualPage.tsx`)
Embedded offline Help page outside `RequireCapture` so it is accessible before loading a capture.

- Authored in Markdown (`src/pages/manual/manual.md` and `manual.ja.md`) and converted to HTML at build time by `markdownPlugin` in `vite.config.ts` (`marked` is a devDependency only).
- Headings (`h2`/`h3`) receive slug IDs (or explicit `{#id}` markers in Japanese) used to build the sidebar table of contents and support hash links such as `/manual#filters`. Both language manuals are verified by `tests/e2e/manual.e2e.ts` to publish the exact same ordered list of heading IDs.
- Screenshots in `public/manual/` are shared across languages with localized captions and intrinsic dimensions injected at build time to prevent layout shifts with lazy loading.

#### 2.1.14 Alert Rules (`src/components/dashboard/alerts.ts`)
The rule engine reports **one alert per problem instance** (not per packet), sorted by severity (`critical`, `warning`, `info`), occurrence count, and recency. Every alert names the rule that produced it (`rule`) and, where it concerns one session, that session (`peering`).

The workspace's **Findings** list then folds instances into **one row per kind of problem** (`groupFindings`, `src/components/dashboard/findings.ts`): alerts sharing a `groupKey` (default: the rule) form a group that ranks by its worst severity and expands to its instances. NOTIFICATIONs are keyed by code and subcode so different faults stay apart. Each group also totals its **occurrences** (each alert's `count`, or one); that is what a row's ×N shows and what the list heading sums, so the two agree. Selecting a session narrows the list to that session's findings, and recomputes the findings no one session owns — withdrawal bursts, route flapping, AS_PATH changes, MAC moves — over that session's packets alone (`scopeAlerts`, `src/components/dashboard/alerts.ts`); left as they were they kept the whole capture's counts. Other findings with no session (the TCP-only rules) are kept as they are. On the bundled sample, 16 instances standing for 18 occurrences fold into 4 rows.

| Rule | Severity | Fires when | Must stay quiet about |
|------|----------|------------|-----------------------|
| NOTIFICATION | critical (info for Cease / Connection Collision Resolution, 6/7) | Any NOTIFICATION, grouped by sender → receiver, code, and subcode | Collision resolution is RFC 4271 §6.8 behaviour, so it is `info`: listed last and never marks a session as faulty |
| Session flapping | warning | ≥ 4 OPENs between a peer pair | Single establishment; re-establishment after clean Cease; peerings fully accounted for by Graceful Restart |
| Withdrawn burst | warning | ≥ 10 prefixes withdrawn within 10s | Steady-state withdrawals spread over time |
| Route flapping | warning | Prefix withdrawn at least once per announcing peer (top 5 + summary row). A flap is a withdraw of a route that peer had up (or announced before the capture began); re-announces and repeated withdraws are not flaps. The Routes **Flap** column and the SQL *Prefix Flapping* template count the same way | Stable routes never withdrawn |
| AS_PATH changed | warning | Multiple distinct AS_PATHs for a prefix **from the same peer** (and, with ADD-PATH, the same Path Identifier) (top 5 + summary row) | Constant AS prepends; different paths from different peers (iBGP empty path vs. eBGP `65001`) |
| MAC moved | warning | An EVPN MAC/IP route announced by one peer and then by another (top 5) | MAC routes only ever announced by one VTEP |
| One direction | critical | Peering has TCP frames in only one direction | Bidirectional captures |
| Accepted, no BGP | critical | TCP SYN-ACK observed, but only one end sent BGP | Refused connections (handled by `computeTransportAlerts`) |
| Graceful restart | warning (critical if broken) | Teardown without NOTIFICATION followed by both peers re-OPENing with Graceful Restart; reports Restart Time, forwarding-state preservation, and convergence to End-of-RIB. Escalates to critical if forwarding state was not preserved or convergence exceeded Restart Time | Flaps without GR capability; teardowns explained by a NOTIFICATION |
| Silent teardown | critical | A TCP connection that carried BGP **in both directions** ends in RST or FIN with no NOTIFICATION; grouped by `(peering, kind)` | Teardowns explained by a NOTIFICATION (`s3-holdtimer-flap`), sessions that never established (`s14-open-unanswered`), and teardowns accounted for by Graceful Restart (`s8-graceful-restart`) |

When a capture contains **no BGP messages at all**, `computeTransportAlerts` runs instead and classifies TCP port 179 SYNs (refused by RST vs. unanswered).

**Key rule details:**
- **Connection delimiting (`connectionsByPeering`):** TCP frames for a peering are split at every bare `SYN` (excluding `SYN-ACK`) rather than by 4-tuple, because ephemeral ports can be reused across reconnects. Within a connection, `RST` outranks `FIN`, and only the first `FIN` counts.
- **Graceful restart interlock:** Graceful Restart deliberately suppresses both **Session flapping** and **Silent teardown** for connections it accounts for, using the shared `connectionsByPeering` segmentation so the rules cannot disagree.
- **Deep-linking to TCP frames:** Silent teardown alerts link to `/messages?all=1&frame=<n>` so **View →** switches the list to **All Packets** and selects the exact RST/FIN frame.

### 2.2 Future Features

- Multiple captures loaded side by side
- Filter field for TCP flags (to narrow **All Packets** to RST/FIN frames) and `hold_time`
- Formatted timestamp display in the SQL Console results grid (currently renders raw epoch milliseconds)

---

## 3. Non-Functional Requirements

### 3.1 Performance

| Metric | Target |
|--------|--------|
| DuckDB WASM initialization | < 3s |
| Parse 1,000-packet capture | < 2s |
| Filter response | < 500ms |
| Ordinary SQL query | < 1s |
| UI rendering | 60fps |

Key techniques: virtualized packet list (`useVirtualRows`), route-level `React.lazy` code splitting, dynamic DuckDB import, `useMemo` aggregations, debounced SQL filtering, and bit-string columns (`prefix_bits`) for CIDR matching. The DuckDB tables have primary keys but no secondary indexes and no copy of the raw frame bytes: maintaining 24 indexes was most of the insert and gained the filter's queries nothing measurable, and the Base64 frames were read by nothing (see `src/lib/db/schema.ts`). Parsing currently runs on the main thread and can move to a Web Worker if needed.

**Load pipeline.** Reading, parsing and decoding are in front of the packet list and drive the load gauge (`src/lib/load-progress.ts`). Decoding runs in slices of about 12ms (`parseBgpFromPacketsAsync`), so the gauge keeps moving through it; the reassembly and session state carry across slices in the decoder. The decoder keeps one copy of each value a capture repeats — path attribute blocks, individual attributes, prefixes — and hands it to every message carrying it (`src/lib/bgp/shared-decode.ts`); decoded messages are therefore shared and must be treated as read-only. The DuckDB insert runs after the list is shown (`useBgpAnalyzer`), with its own gauge in the header; `dbStatus` is state, so the filter and the SQL console switch to SQL when it lands. The loader flattens and inserts a chunk of rows at a time (`ROWS_PER_FLUSH`) rather than holding every table's rows at once. Each chunk is written straight into Arrow column buffers (`src/lib/db/arrow-columns.ts`), with no row objects in between, and the next chunk is flattened while the DuckDB worker inserts the previous one. Saving to IndexedDB is not awaited.

**Large captures.** What limits capture size is the tab's JS heap (about 4 GB), not parse time: how much a decoded capture weighs depends on how often its values repeat. Values repeated on nearly every frame are shared rather than copied (`src/lib/pcap/shared-values.ts`, shared attribute flags), and a decoded path attribute keeps no copy of its bytes. Above `SYNC_FILTER_MAX_PACKETS` (20,000) packets the per-keystroke in-memory filter pass is skipped once DuckDB holds the capture; the filter box's value suggestions are gathered in slices from its first focus (`filterValuesForAsync`), reading each shared attribute list and prefix once, and join the list when done; filter suggestions and prefix statistics are computed once per packet array (`prefixStatsFor`). Each route's history is kept as typed columns pointing back into the decoded packets, prefixes and per-attribute-list announcements, about 12 bytes an event rather than a 65-byte object (`RouteHistory`); the Routes screen rebuilds the selected route's events when it is opened. Above `BACKGROUND_FINDINGS_MIN_PACKETS` (20,000) the findings are worked out in ~12 ms slices so the list is usable while they are — first the route statistics they read (`prefixStatsForAsync`), then the rules themselves (`alertsForAsync`, `scopedAlertsForAsync`; each rule's loops are generators run by `src/lib/sliced.ts`, so the sliced and synchronous runs are one body). The findings column says so until they appear. Measured in headless Chromium on synthetic, UPDATE-heavy captures whose attribute lists repeat from UPDATE to UPDATE, the list opens in about 2.5–4 s for 50 MB, 4–10 s for 100 MB and 8–17 s for 200 MB, with findings after 3.5–6 s, 6.5–12 s and 14–25 s, SQL ready after 10–12 s for 50 MB and 37–47 s for 200 MB, and the heap at most 0.2–0.35 GB, 0.4–0.7 GB and 0.7–1.3 GB. When every UPDATE carries its own prefix, AS_PATH and MED, 100 MB opens its list in about 7 s, shows findings after 40–43 s and is ready for SQL after 46–51 s with the heap at 1.7 GB; 200 MB of that reaches 3.5 GB and stops responding, which is why `MAX_FILE_SIZE` stops at 100 MB.

### 3.2 Browser Support
Latest Chrome/Edge, Firefox, and Safari.

### 3.3 Security & Privacy
- **Local-only processing:** Capture files never leave the browser and are stored solely in IndexedDB until cleared with **New File**.
- **Zero third-party requests:** DuckDB WASM binaries (only `mvp` and `eh` bundles; `coi` is omitted because GitHub Pages cannot send COOP/COEP headers) and workers are self-hosted via Vite `?url` imports into `dist/assets/`.
- **CSP-compatible database loading:** Because DuckDB downloads extensions from `extensions.duckdb.org` on demand and `script-src` forbids `new Function`, `src/lib/db/loader.ts` loads rows via built-in Arrow IPC with hand-assembled Arrow buffers. `tests/e2e/offline.e2e.ts` enforces both zero off-origin requests and zero `eval`/`Function` usage.
- **Production CSP:** Injected into built `index.html` by `cspPlugin` in `vite.config.ts` (disabled in dev for React Fast Refresh):

  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;
  child-src 'self' blob:; connect-src 'self' blob: data:;
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
  object-src 'none'; base-uri 'self'; form-action 'none'
  ```

  `wasm-unsafe-eval` is required for WebAssembly compilation; `style-src 'unsafe-inline'` is used by resizable pane and timeline inline styles; `frame-ancestors` is omitted because browsers ignore it in `<meta>` tags.

### 3.4 Accessibility
- **Implemented:** Full keyboard navigation (Tab, Enter, arrow keys with virtualized scroll-into-view, pane-divider nudging), ARIA grid semantics on the packet list (`aria-rowcount`, `aria-rowindex`, `aria-selected`, `aria-activedescendant`), `aria-label` on icon-only controls, `role="img"` on the timeline SVG, and non-color-only status indicators.
- **Remaining targets:** Broader `aria-label` coverage outside the packet list, `scope` attributes on table headers, ARIA live region for notifications, and WCAG AA contrast verification.

### 3.5 Error Handling
No failure is allowed to silently display empty data:

| Failure | User feedback | Recovery |
|---------|---------------|----------|
| Invalid file type or size | Inline error under drop zone | Select another file |
| Partial parse failure | Warning banner under header; valid frames still load | Inspect warnings |
| DuckDB init failure | Notice in SQL Console and load banner | Filtering falls back to in-memory |
| SQL query error | DuckDB error message in results panel | Edit query |
| Uncaught render error | Error boundary screen | Reset to upload screen |

---

## 4. Technical Design

### 4.1 Tech Stack

| Layer | Technology |
|-------|------------|
| Framework / Language | React 18, TypeScript |
| Build / Runtime | Vite 6, Bun |
| Routing | React Router v7 (`BrowserRouter`, basename `/bgpshark`) |
| Styling | Tailwind CSS over semantic CSS custom properties |
| State Management | React Context (`AppContext`) over `useBgpAnalyzer` |
| Query Engine | DuckDB WASM (in-browser OLAP, Arrow IPC ingestion) |
| Persistence | IndexedDB (raw capture file) |
| Testing | `bun test` (`tests/lib`, happy-dom, Testing Library), Playwright (`tests/e2e`) |
| Deployment | GitHub Actions → GitHub Pages (with `404.html` SPA fallback) |

### 4.2 Directory Structure

| Directory | Responsibility |
|-----------|----------------|
| `public/` | Static assets (`favicon.svg`, `sample.pcapng`, `THIRD-PARTY-LICENSES.txt`, `manual/*.png`) |
| `docs/` | Architecture diagrams, technical design, DuckDB ADR, troubleshooting scenario assessment |
| `src/pages/` | Route-level pages and Markdown sources for the user manual (`manual/`) |
| `src/components/` | Feature UI components (`builder/`, `common/`, `dashboard/`, `layout/`, `message/`, `neighbor/`, `workspace/`) |
| `src/hooks/` | State, filtering, virtualization, theming, split pane, and file drop hooks |
| `src/lib/pcap/` | libpcap/pcapng parsers, IPv6 walking, BGP marker detection, pcap writer |
| `src/lib/bgp/` | Message & path attribute parsers, EVPN, error hints, hold-timer, route-refresh, neighbor & prefix stats |
| `src/lib/build/` | BGP encoders, TCP/IP/Ethernet framing, scenario compiler, presets |
| `src/lib/db/` | DuckDB lifecycle, schema, Arrow IPC loader, query API, filter-to-SQL compiler |
| `src/lib/filter/` | Filter expression lexer, parser, and in-memory evaluator |
| `src/lib/net/` | Prefix parsing, bit keys, and CIDR containment |
| `tests/lib/` | Unit tests mirroring `src/lib/` and dashboard alerts |
| `tests/e2e/` | Playwright end-to-end specs (`*.e2e.ts`) |
| `testlab/` | ContainerLab topology, fault scenario generator (`scenarios.ts`), screenshot generator (`screenshots.ts`) |

### 4.3 Data Flow

```mermaid
flowchart TB
    drop["User drops / selects file"] -- "ArrayBuffer" --> proc["useBgpAnalyzer.processBuffer<br/>pcap / pcapng parser: Ethernet/SLL → VLAN/QinQ → IPv4/IPv6 → TCP<br/>TCP reassembly & BGP message dispatch (bgp/parser.ts)"]
    proc -- "BgpPacket[] + GenericPacket[]" --> ctx["AppContext (React)<br/>packets, allPackets"]
    proc -. "after the list is shown" .-> loader["db/loader.ts → DuckDB WASM<br/>(Arrow IPC)"]
    proc -. "not awaited" .-> store["storage.ts → IndexedDB<br/>(raw file)"]
    ctx --> pages["Pages & components<br/>Workspace: Messages, Sessions, Routes, SQL"]
    loader --> queries["db/queries.ts<br/>getMatchingFrameIndexes(filter)<br/>executeRawSql(sql)"]
    queries -- "frame indexes / result rows" --> pages
```

The step-by-step sequence, state machines and filter decision flow are drawn in [`architecture.md` §4–§8](architecture.md#4-loading-a-capture).

If DuckDB WASM fails to initialize, filtering automatically falls back to `src/lib/filter/parser.ts` and all screens except the SQL Console remain usable.

#### DuckDB's role is intentionally narrow

`src/lib/db/queries.ts` exposes only two entry points: `getMatchingFrameIndexes` (SQL-accelerated filtering) and `executeRawSql` (SQL Console).

**DuckDB selects; it does not reconstitute.** `getMatchingFrameIndexes` returns `frameIndex` values, which are resolved against the already-parsed `BgpPacket[]` in memory. Because the SQL tables are a flattened projection that cannot represent every nested capability or attribute losslessly, keeping `frameIndex` as the sole join key prevents field loss when filters are active. Authoritative TypeScript types live in `src/lib/pcap/types.ts` and `src/lib/bgp/types.ts`.

---

## 5. UI Design

### 5.1 Color Tokens

Components reference semantic roles rather than raw hex colors (`src/index.css` + `tailwind.config.js`):

| Role | CSS Variables | Tailwind Example |
|------|---------------|------------------|
| Canvas & surfaces | `--canvas`, `--surface`, `--surface-sunken`, `--surface-raised` | `bg-canvas`, `bg-surface` |
| Borders | `--hair`, `--hair-strong` | `border-hair` |
| Typography | `--text-strong`, `--text-body`, `--text-muted`, `--text-dim` | `text-muted` |
| Accent | `--accent`, `--accent-hover`, `--accent-fg`, `--accent-subtle` | `bg-accent` |
| Severity | `--critical`, `--warning`, `--ok` (with `-subtle` variants) | `text-critical` |
| BGP message types | `--msg-open`, `--msg-update`, `--msg-notification`, `--msg-keepalive`, `--msg-route-refresh` | `text-bgp-open` |

### 5.2 Layout

The app is an SPA with a thin header (capture name, language, theme, and a menu holding Build, Help and the repository link). The upload screen (`/`) is shown when no capture is loaded, though files can be dropped anywhere at any time. Once a capture is open, the analysis views share one workspace: sessions and findings in a left column (a drawer below the `lg` breakpoint) and the views as tabs. **Messages** (`/messages`) uses a resizable two-pane layout (filter bar above a virtualized packet list on the left and structured detail + hex dump on the right).

---

## 6. Constraints & Assumptions

- **TCP reassembly cap:** Reassembly buffers per directional flow are capped at `BGP_MAX_MESSAGE_LENGTH`; flows exceeding this limit are treated as desynced and dropped with a warning.
- **Link layers:** Ethernet II (link type 1) and Linux cooked capture / SLL (113), with 802.1Q and QinQ VLAN tags stripped.
- **Transport:** IPv4 and IPv6 over TCP (port 179, plus non-standard ports detected by BGP message marker).
- **File size:** Capped at 100 MB per capture (`src/lib/file-constraints.ts`). The binding constraint is memory — the parsed packets in the JS heap plus DuckDB WASM — not parse time; see §3.1 for what larger captures cost.