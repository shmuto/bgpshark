# BGP Packet Analyzer - Requirements & Design Document

> This document describes the current design of the application. Related documents:
> `ui-design.md` (screen specifications) and `design-duckdb-wasm.md` (the original
> DuckDB WASM migration proposal — this document is authoritative where the two differ).

## 1. Project Overview

### 1.1 Product Name
BGP Packet Analyzer (repository / package name: `bgpshark`)

### 1.2 Concept
A lightweight, web-based pcap analyzer specialized for BGP session troubleshooting. Quickly inspect and analyze BGP messages in the browser without launching Wireshark.

### 1.3 Target Users
- IXP operators
- ISP NOC engineers
- Network engineers working with BGP
- Networking students

### 1.4 Hosting
GitHub Pages (fully static site)

---

## 2. Functional Requirements

### 2.1 Implemented Features

#### 2.1.1 Pcap File Loading
- Drag & drop (anywhere in the app) or file picker to upload
- Supported formats: libpcap (.pcap) and pcapng (.pcapng), auto-detected by magic number
- Client-side parsing (no server upload)
- The loaded file is persisted in IndexedDB and restored automatically on reload

#### 2.1.2 BGP Message Extraction
- Auto-filter packets on TCP port 179; non-BGP IP packets are also retained and can
  be shown in the message list ("show all packets")
- Multiple BGP messages inside a single TCP segment are all extracted
- Identify BGP message types:
  - OPEN (Type 1)
  - UPDATE (Type 2)
  - NOTIFICATION (Type 3)
  - KEEPALIVE (Type 4)
  - ROUTE-REFRESH (Type 5)

#### 2.1.3 OPEN Message Analysis
| Field | Display |
|-------|---------|
| Version | BGP version (typically 4) |
| My Autonomous System | ASN (2-byte/4-byte support) |
| Hold Time | Seconds |
| BGP Identifier | Router ID (IPv4 format) |
| Optional Parameters | Expanded Capabilities view |

**Capabilities parsed into structured values**
- Multiprotocol Extensions (Code 1) - AFI/SAFI display
- Route Refresh (Code 2)
- Extended Next Hop Encoding (Code 5)
- Graceful Restart (Code 64)
- 4-byte AS Number (Code 65)
- ADD-PATH (Code 69) - per AFI/SAFI send/receive
- Enhanced Route Refresh (Code 70)

Other IANA-assigned codes are recognised by name (`CapabilityCodeNames` in
`src/lib/bgp/constants.ts`) and shown with their raw value; anything unassigned is
listed as an unknown capability rather than dropped.

#### 2.1.4 NOTIFICATION Message Analysis
| Field | Display |
|-------|---------|
| Error Code | Code value + name |
| Error Subcode | Subcode value + name |
| Data | Hex dump of relevant bytes |
| Hint | Common causes & troubleshooting tips |

**Supported Error Codes**
| Code | Name | Example Subcodes |
|------|------|------------------|
| 1 | Message Header Error | Bad Message Length, Bad Message Type |
| 2 | OPEN Message Error | Unsupported Version, Bad Peer AS, Bad BGP Identifier, Unsupported Capability |
| 3 | UPDATE Message Error | Malformed Attribute List, Invalid NEXT_HOP, etc. |
| 4 | Hold Timer Expired | - |
| 5 | FSM Error | - |
| 6 | Cease | Admin Shutdown, Peer De-configured, etc. |

#### 2.1.5 Packet List View
- Timestamp
- Source/Destination IP
- BGP message type
- Summary info (e.g., "OPEN AS65001 Hold=90")

#### 2.1.6 Detail View
- Click packet to show detail panel
- Hierarchical field display
- Hex dump of relevant bytes

#### 2.1.7 UPDATE Message Analysis
Path attributes parsed into structured values:

| Code | Attribute | Code | Attribute |
|------|-----------|------|-----------|
| 1 | ORIGIN | 10 | CLUSTER_LIST |
| 2 | AS_PATH | 14 | MP_REACH_NLRI |
| 3 | NEXT_HOP | 15 | MP_UNREACH_NLRI |
| 4 | MULTI_EXIT_DISC | 16 | EXTENDED_COMMUNITIES |
| 5 | LOCAL_PREF | 17 | AS4_PATH |
| 6 | ATOMIC_AGGREGATE | 18 | AS4_AGGREGATOR |
| 7 | AGGREGATOR | 32 | LARGE_COMMUNITIES |
| 8 | COMMUNITIES | | |
| 9 | ORIGINATOR_ID | | |

NLRI and withdrawn routes are expanded per prefix, including IPv6 prefixes carried
in MP_REACH_NLRI / MP_UNREACH_NLRI.

#### 2.1.8 Analysis Views
- **Dashboard** (`/dashboard`): summary counts, severity-sorted alerts, neighbor table
  and a message timeline. Aggregations are computed in memory, so the screen works
  even when DuckDB failed to initialize
- **Message Explorer** (`/messages`): packet list, detail view, hex dump, filtering
- **Neighbor Analysis** (`/neighbors`): sessions grouped by Router ID, capability and
  session-event summaries, plus the capability diff (§2.1.10)
- **Route Analysis** (`/routes`): per-prefix announce/withdraw history and flap count
- **SQL Console** (`/sql`): raw SQL against the DuckDB tables, with query templates
- **Capture Builder** (`/build`): §2.1.12

#### 2.1.9 Filtering
Two modes over the same expression language:
- **Simple**: field/operator/value rules built from dropdowns
- **Advanced**: free-form expression with autocomplete

Grammar: `field (= | != | contains | not contains) value`, combined with
`and` / `or` / `not` and parentheses. Fields are defined by `FILTER_FIELDS` in
`src/lib/filter/parser.ts`. The expression is evaluated either in memory
(`filter/parser.ts`) or compiled to SQL (`db/filter-to-sql.ts`) when DuckDB is available.

#### 2.1.10 Capability Diff

On the Neighbor Analysis page (`/neighbors`), selecting a peer within a session shows a
side-by-side diff of the two OPEN messages exchanged on that session
(`CapabilityDiff` in `src/components/neighbor/CapabilityDiff.tsx`):

- Non-capability fields (BGP version, My AS, Hold Time, BGP Identifier) are compared
  first. Hold Time differences are marked informational, not an error, since only the
  minimum is negotiated. A BGP Identifier collision (same Router ID on both sides) and
  an internally inconsistent 4-byte/2-byte AS field are flagged as errors; version
  mismatches are flagged as errors too.
- Capabilities are compared as a three-state diff — advertised by both, only the local
  side, or only the remote side — using an icon *and* text label so the states don't
  rely on colour alone. Multiprotocol Extensions and ADD-PATH are compared per AFI/SAFI
  pair rather than by capability code, so "both support Multiprotocol" doesn't hide one
  side offering IPv4 unicast and the other IPv6 unicast. Repeated capability entries
  within one OPEN are deduplicated.
- Mismatches are listed before matches, since that's what an operator troubleshooting a
  session is scanning for.
- A missing OPEN on one or both sides is handled without breaking the page (one-sided
  comparison notice, or an empty-state message when neither side has one).

#### 2.1.11 Theming

Light and dark themes, following the system preference by default. The header
toggle cycles light → dark → system (`useTheme` in `src/hooks/useTheme.ts`), and the
choice is persisted in localStorage. Colours are defined once as CSS custom
properties in `src/index.css` and consumed through the semantic Tailwind names in
`tailwind.config.js`, so components never name a theme.

#### 2.1.12 Capture Builder

The one screen that runs in the other direction: describe a session and it writes the
pcap. It needs no capture loaded, which is the state you are in when you come looking
for one.

A scenario is two peers and a sequence of things that happen between them — the TCP
handshake, the OPEN exchange, UPDATEs, a NOTIFICATION, a reset — compiled to frames by
`lib/build/scenario.ts`. Two properties are derived from the scenario rather than asked
for, because a capture that got them wrong is one no session could have produced: how
UPDATEs are encoded (AS width and ADD-PATH Path Identifiers follow from the negotiated
capabilities) and where TCP segment boundaries fall (messages sent in one step are
packed into a byte stream and cut at the MSS).

Output is a real capture, not one only this app can read: IPv4/TCP checksums are
computed over the pseudo-header and short frames are padded to Ethernet's minimum, both
verified in `tests/lib/build/checksums.test.ts`.

The same thing is available as a library, which is the better route for fixtures in
bulk — `testlab/scenarios.ts` uses it to build the thirteen captures behind
`docs/troubleshooting-scenarios.md`. Screen layout is specified in `ui-design.md` §4.7.

### 2.2 Future Features

- Multiple captures loaded side by side

IPv6 transport and pcap export of a filtered result set were both on this list and
are now implemented — `lib/pcap/ipv6.ts` and `lib/pcap/writer.ts` respectively.
`docs/troubleshooting-scenarios.md` tracks what the tool still cannot answer, which
is a more useful backlog than this section: a one-sided capture reported as healthy,
a post-establishment TCP reset that never reaches the dashboard, and best-path
attributes that stop at AS_PATH and Next Hop.

Screen state is already shareable through the URL query string: the Message Explorer
keeps `?filter=` and `?selected=`, Neighbor Analysis `?router=` / `?peer=`, and Route
Analysis its search term, selection, sort and match direction.

---

## 3. Non-Functional Requirements

### 3.1 Performance
- Parse 1000-packet pcap within 3 seconds
- Maintain 60fps UI

### 3.2 Browser Support
- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)

### 3.3 Security
- All packet processing is client-side only; the pcap file is never uploaded
- The loaded file is stored in IndexedDB on the user's machine and is cleared by
  "New File"
- No third-party requests. The DuckDB WASM runtime is self-hosted: `db/database.ts`
  imports the `.wasm` modules and worker scripts with Vite's `?url` suffix, so they
  are emitted into `dist/assets/` and served from the app's own origin
- **Self-hosting the runtime is not the whole of it.** DuckDB fetches its
  *extensions* from `extensions.duckdb.org` the first time one is used, so anything
  outside the core engine is unavailable here by construction. This was not
  theoretical: the loader inserted rows through `read_json_auto`, the JSON reader is
  an extension, and behind the CSP that download failed — so every capture failed to
  load and the SQL console was dead on the deployed site, while development looked
  fine because the dev server ships no policy and the download succeeded.
  `db/loader.ts` now inserts with literal `VALUES`, and
  `tests/e2e/offline.e2e.ts` asserts that nothing leaves the origin
- Content Security Policy is injected into the built `index.html` by the `inject-csp`
  plugin in `vite.config.ts`:

  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;
  child-src 'self' blob:; connect-src 'self' blob: data:;
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
  object-src 'none'; base-uri 'self'; form-action 'none'
  ```

  Notes:
  - `wasm-unsafe-eval` is required to compile the DuckDB WebAssembly module
  - `style-src 'unsafe-inline'` is required by inline `style` attributes used for
    resizable panes and timeline positioning
  - The policy is applied to the production build only. In dev, `@vitejs/plugin-react`
    injects the Fast Refresh preamble as an inline script, which the policy would block
  - `frame-ancestors` is omitted because browsers ignore it in a `<meta>` policy;
    clickjacking protection needs a real response header, which GitHub Pages
    cannot set

#### Bundle selection

Only the `mvp` and `eh` DuckDB bundles are shipped. The `coi` bundle is omitted
because it requires cross-origin isolation (COOP/COEP response headers) that GitHub
Pages cannot provide. Self-hosting adds roughly 74 MB to `dist/` (two `.wasm` files);
a browser downloads only the one bundle it selects.

### 3.4 Accessibility
- Keyboard navigation: the packet list is focusable and supports arrow-key selection,
  scrolling the selection into view even when the row is outside the rendered window
- Screen readers: the packet list is exposed as a grid, with `aria-rowcount` reporting
  the total packet count rather than the virtualized slice, plus `aria-rowindex`,
  `aria-selected` and `aria-activedescendant`
- Not yet covered: the remaining screens have no dedicated ARIA work

---

## 4. Technical Design

### 4.1 Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | React 18 |
| Language | TypeScript |
| Build Tool | Vite 6 |
| Package Manager / Runtime | Bun |
| Routing | React Router v7 (`BrowserRouter`, basename `/bgpshark`) |
| Styling | Tailwind CSS over CSS custom properties (light / dark themes) |
| State Management | React Context (`AppContext`) over the `useBgpAnalyzer` hook |
| Query Engine | DuckDB WASM (in-browser OLAP) |
| Persistence | IndexedDB (loaded pcap file) |
| Testing | `bun test` for `tests/lib` (+ happy-dom, Testing Library), Playwright for `tests/e2e` |
| Deployment | GitHub Actions → GitHub Pages |

### 4.2 Directory Structure

```
bgpshark/
├── public/
│   ├── favicon.svg
│   └── sample.pcapng            # The "Load sample" capture, also an e2e fixture
├── CLAUDE.md                    # Orientation for an agent starting a session
├── docs/
│   ├── design.md                # This document
│   ├── ui-design.md             # Screen specifications
│   ├── troubleshooting-scenarios.md  # Thirteen BGP faults vs. what the tool says
│   ├── design-duckdb-wasm.md    # Original DuckDB WASM migration proposal
│   └── todo.md                  # Log of fixed issues
├── src/
│   ├── App.tsx                  # Router and global drop overlay
│   ├── main.tsx
│   ├── index.css                # Theme custom properties + base styles
│   ├── context/
│   │   └── AppContext.tsx       # Global app state provider
│   ├── pages/
│   │   ├── FileUploadPage.tsx   # /
│   │   ├── DashboardPage.tsx    # /dashboard
│   │   ├── MessagesPage.tsx     # /messages
│   │   ├── NeighborsPage.tsx    # /neighbors
│   │   ├── RoutesPage.tsx       # /routes
│   │   ├── SqlConsolePage.tsx   # /sql
│   │   └── BuilderPage.tsx      # /build — describe a session, get a pcap
│   ├── components/
│   │   ├── builder/             # ScenarioEditor + its editing model
│   │   ├── common/              # FileDropzone, PacketList, HexDump, QueryInput, ...
│   │   ├── dashboard/           # SummaryCards, AlertList, NeighborSummaryTable, MessageTimeline
│   │   ├── layout/              # AppHeader, ThemeToggle
│   │   ├── message/             # PacketDetail + per-message-type views
│   │   └── neighbor/            # CapabilityDiff
│   ├── hooks/
│   │   ├── useBgpAnalyzer.ts    # Load → parse → DuckDB → state
│   │   ├── useFileDropzone.ts
│   │   ├── useFilter.ts
│   │   ├── useMediaQuery.ts     # Compact-layout detection
│   │   ├── useSplitPane.ts      # Draggable two-pane divider
│   │   ├── useVirtualRows.ts    # Row virtualization for long lists
│   │   └── useTheme.ts          # Light / dark / system preference
│   ├── lib/
│   │   ├── pcap/
│   │   │   ├── parser.ts        # libpcap parser
│   │   │   ├── pcapng-parser.ts # pcapng parser
│   │   │   ├── bgp-detect.ts    # BGP on non-standard ports, by marker
│   │   │   ├── ipv6.ts          # IPv6 header walking and RFC 5952 formatting
│   │   │   ├── writer.ts        # Frames → pcap, for filtered export
│   │   │   ├── reader.ts        # Binary reading utilities
│   │   │   └── types.ts
│   │   ├── bgp/
│   │   │   ├── parser.ts        # BGP message dispatch
│   │   │   ├── open.ts          # OPEN + capability parsing
│   │   │   ├── update.ts        # UPDATE + path attribute parsing
│   │   │   ├── notification.ts  # NOTIFICATION parsing
│   │   │   ├── evpn.ts          # EVPN NLRI (RFC 7432)
│   │   │   ├── extended-communities.ts
│   │   │   ├── errors.ts        # Error Code/Subcode definitions and hints
│   │   │   ├── neighbor.ts      # Neighbor/session aggregation
│   │   │   ├── session.ts       # Negotiated capabilities per session
│   │   │   ├── session-events.ts
│   │   │   ├── prefix-stats.ts  # Per-prefix history and flap counting
│   │   │   ├── as-path-display.ts
│   │   │   ├── constants.ts     # AFI/SAFI names
│   │   │   └── types.ts
│   │   ├── db/
│   │   │   ├── database.ts      # DuckDB WASM lifecycle
│   │   │   ├── schema.ts        # Table definitions
│   │   │   ├── loader.ts        # BgpPacket[] → tables
│   │   │   ├── queries.ts       # Query API + result mapping
│   │   │   └── filter-to-sql.ts # Filter AST → SQL
│   │   ├── filter/
│   │   │   └── parser.ts        # Filter lexer/parser/evaluator
│   │   ├── net/
│   │   │   └── prefix.ts        # Prefix parsing, bit keys, containment
│   │   ├── build/
│   │   │   ├── bytes.ts         # Byte writer, address encoding, checksums
│   │   │   ├── bgp-encode.ts    # BGP message encoders (mirror of lib/bgp)
│   │   │   ├── frame.ts         # TCP / IPv4 / IPv6 / Ethernet / SLL framing
│   │   │   ├── scenario.ts      # Described session → pcap frames
│   │   │   └── presets.ts       # Ready-made failure scenarios
│   │   ├── file-constraints.ts  # Accepted extensions and size limit
│   │   ├── packet-columns.ts    # What the packet list's Info column shows
│   │   ├── format-time.ts       # One timestamp format, used by every screen
│   │   ├── range.ts
│   │   └── storage.ts           # IndexedDB persistence
├── tests/
│   ├── lib/pcap/                # parser, reader
│   ├── lib/bgp/                 # parser, neighbor, session events, EVPN
│   ├── lib/build/               # encoder round trips, checksum verification
│   ├── lib/db/                  # schema splitting, filter → SQL
│   ├── lib/dashboard/           # alert grouping and thresholds
│   ├── lib/filter/              # filter expressions
│   ├── lib/net/                 # prefix arithmetic
│   ├── e2e/                     # Playwright specs (*.e2e.ts)
│   └── bgp.pcapng               # Test fixture
├── testlab/
│   ├── topology.clab.yml        # ContainerLab BGP topology for capture generation
│   └── scenarios.ts             # Thirteen fault captures, built from lib/build
├── .github/
│   └── workflows/
│       ├── ci.yml               # Pull request checks (lint, unit, build, e2e)
│       └── deploy.yml           # GitHub Pages deployment
├── index.html
├── package.json
├── tsconfig.json
├── playwright.config.ts
├── flake.nix                    # Nix dev shell (Bun, Node, Playwright browsers)
├── vite.config.ts
└── tailwind.config.js
```

### 4.3 Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  User                                                           │
└─────────────────────────────────────────────────────────────────┘
        │ Drop pcap file (anywhere in the app)
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  useFileDropzone / FileDropzone                                 │
│  - Get binary via File API                                      │
│  - Read as ArrayBuffer                                          │
└─────────────────────────────────────────────────────────────────┘
        │ ArrayBuffer
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  useBgpAnalyzer.processBuffer                                   │
│  - isPcapng() → pcapng-parser.ts / parser.ts                    │
│  - Parse headers, sequentially parse packets                    │
│  - Strip Ethernet (or SLL) → VLAN/QinQ → IPv4 or IPv6 → TCP     │
│  - Split into BGP packets (port 179, or by marker) and all IP   │
└─────────────────────────────────────────────────────────────────┘
        │ GenericPacket[]
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  bgp/parser.ts                                                  │
│  - Validate BGP Marker                                          │
│  - Determine Message Type                                       │
│  - Dispatch to type-specific parsers (open/update/notification) │
│  - Multiple messages per TCP segment                            │
└─────────────────────────────────────────────────────────────────┘
        │ BgpPacket[]
        ├──────────────────────────────┐
        ▼                              ▼
┌──────────────────────────┐  ┌────────────────────────────────────┐
│  AppContext (React)      │  │  db/loader.ts → DuckDB WASM        │
│  - packets: BgpPacket[]  │  │  - packets / messages / nlri / ... │
│  - allPackets            │  │                                    │
│  - selectedPacketIndex   │  │  storage.ts → IndexedDB            │
└──────────────────────────┘  │  - raw file for reload restore     │
        │                     └────────────────────────────────────┘
        │                              │
        ▼                              ▼
┌───────────────────────┬─────────────────────────────────────────┐
│  Pages / Components   │  db/queries.ts                          │
│  - PacketList         │  - getPackets(filter)                   │
│  - PacketDetail       │  - executeRawSql (SQL console)          │
│  - HexDump            │  - filter-to-sql.ts for filter → SQL    │
└───────────────────────┴─────────────────────────────────────────┘
```

If DuckDB WASM fails to initialize, the app stays usable: filtering falls back to
in-memory evaluation in `filter/parser.ts` and only the SQL console is unavailable.

#### DuckDB's role is intentionally narrow

`db/queries.ts` exposes exactly two entry points: `getMatchingFrameIndexes`
(SQL-accelerated filtering, called from `useFilter.ts`) and `executeRawSql` (the SQL
console, called from `SqlConsolePage.tsx`). Earlier revisions also had DuckDB-backed
queries for packet counts, single-packet lookup, and neighbor/AS-path/prefix
statistics, but nothing outside `src/lib/db/` ever called them and they were removed.
Neighbor Analysis and Route Analysis compute their aggregations in memory with
`useMemo` over the already-parsed `BgpPacket[]` instead of querying DuckDB, which is
what keeps those screens usable when DuckDB fails to initialize.

**DuckDB selects, it does not reconstitute.** `getMatchingFrameIndexes` returns frame
indexes and nothing else; the caller resolves them against the `BgpPacket[]` it
already holds. The tables are a flattened projection built for querying and cannot
represent everything the parser produces — the `capabilities` table has columns for a
single AFI/SAFI pair and one AS number, which cannot hold ADD-PATH's per-family list,
Graceful Restart's forwarding state, or Extended Next Hop's entries, and
`raw_data_base64` is not a substitute for the parsed structure.

An earlier `getPackets` rebuilt whole `BgpPacket` objects from those rows. It cast
every capability to `MULTIPROTOCOL | FOUR_OCTET_AS`, so any other capability came back
with its list missing, and the OPEN detail view threw as soon as a filter was applied
— visible only under a filter, because the unfiltered path used the parsed objects.
Keeping frame indexes as the only thing crossing this boundary makes that class of
loss structurally impossible rather than something each new field has to remember.

### 4.4 Key Type Definitions

Authoritative definitions live in `src/lib/pcap/types.ts` and `src/lib/bgp/types.ts`.
The central shapes:

```typescript
// bgp/types.ts
type BgpMessageTypeName =
  | 'OPEN' | 'UPDATE' | 'NOTIFICATION' | 'KEEPALIVE' | 'ROUTE_REFRESH';

interface BgpPacket {
  frameIndex: number;      // 1-based index in the pcap file
  timestamp: Date;
  srcIp: string;
  dstIp: string;
  srcPort: number;
  dstPort: number;
  messages: BgpMessage[];  // One TCP segment may carry several BGP messages
  rawData: Uint8Array;
  parseWarnings: string[];
}

interface BgpOpenMessage {
  type: 'OPEN';
  version: number;
  myAs: number;            // 2-byte AS field on the wire
  holdTime: number;
  bgpIdentifier: string;   // Router ID in dotted-decimal
  optParamLength: number;
  capabilities: BgpCapability[];
  fourByteAs?: number;     // From the 4-byte AS capability, when present
}

interface BgpNotificationMessage {
  type: 'NOTIFICATION';
  errorCode: number;
  errorSubcode: number;
  errorCodeName: string;
  errorSubcodeName: string;
  data: Uint8Array;
  hint: string;            // Troubleshooting hint from errors.ts
}
```

`frameIndex` is the join key between the in-memory `BgpPacket[]` and the DuckDB
`packets` table, so query results can be mapped back to the parsed objects.

### 4.5 Pcap Format Specification

#### Global Header (24 bytes)
| Offset | Length | Field |
|--------|--------|-------|
| 0 | 4 | Magic Number (0xa1b2c3d4 or 0xd4c3b2a1) |
| 4 | 2 | Version Major |
| 6 | 2 | Version Minor |
| 8 | 4 | Reserved1 (thiszone) |
| 12 | 4 | Reserved2 (sigfigs) |
| 16 | 4 | SnapLen |
| 20 | 4 | Network (Link-Layer Type) |

#### Packet Header (16 bytes)
| Offset | Length | Field |
|--------|--------|-------|
| 0 | 4 | Timestamp (seconds) |
| 4 | 4 | Timestamp (microseconds) |
| 8 | 4 | Captured Length |
| 12 | 4 | Original Length |

### 4.6 BGP Message Structure

#### Common Header (19 bytes)
| Offset | Length | Field |
|--------|--------|-------|
| 0 | 16 | Marker (all 1s) |
| 16 | 2 | Length |
| 18 | 1 | Type |

#### OPEN Message
| Offset | Length | Field |
|--------|--------|-------|
| 0 | 1 | Version |
| 1 | 2 | My Autonomous System |
| 3 | 2 | Hold Time |
| 5 | 4 | BGP Identifier |
| 9 | 1 | Opt Param Length |
| 10 | variable | Optional Parameters |

---

## 5. UI Design

Full screen specifications are in `ui-design.md`. This section only summarises the
overall shape.

### 5.1 Layout

The app is a multi-page SPA: a persistent header with navigation, and one page per
analysis view. The Message Explorer (`/messages`) uses the classic two-pane layout.

```
┌─────────────────────────────────────────────────────────────────┐
│  🦈 BGPShark  [Dashboard][Messages][Neighbors][Routes][SQL]     │
│               📁 file.pcap  [+ New File]  [☀ Light]  [GitHub]   │
├─────────────────────────────────────────────────────────────────┤
│  🔍 Filter: type = NOTIFICATION and src_ip = 10.0.0.1           │
├────────────────────────────┬────────────────────────────────────┤
│  Packet List               │  Packet Detail                     │
│  ─────────────────────────│  ────────────────────────────────  │
│  #  Time     Type    Info  │                                    │
│  1  00:00.00 OPEN    AS65001│  ▼ BGP OPEN Message               │
│  2  00:00.01 OPEN    AS65002│    Version: 4                     │
│  3  00:05.00 KEEPALIVE     │    My AS: 65001                    │
│ >4  00:10.00 NOTIFICATION  │    Hold Time: 90                   │
│                            │    BGP Identifier: 10.0.0.1        │
│                            │                                    │
│                            │  ▼ Capabilities                    │
│                            │    Multiprotocol: IPv4 Unicast     │
│                            │    4-byte AS: 65001                │
│                            │    Route Refresh: Supported        │
│                            │                                    │
│                            │  ▼ Hex Dump                        │
│                            │  0000: ff ff ff ff ff ff ff ff     │
│                            │  0008: ff ff ff ff ff ff ff ff     │
└────────────────────────────┴────────────────────────────────────┘
```

The upload screen (`/`) is a separate page; the drop zone is not part of the
analysis layout, though files can be dropped anywhere in the app at any time.

### 5.2 NOTIFICATION Display Example

```
▼ BGP NOTIFICATION Message

  Error Code: 2 (OPEN Message Error)
  Error Subcode: 2 (Bad Peer AS)

  ┌─────────────────────────────────────────────────────────┐
  │ 💡 Common Cause                                         │
  │                                                         │
  │ The remote-as configured in your neighbor statement     │
  │ does not match the ASN sent by the peer.                │
  │                                                         │
  │ Check:                                                  │
  │ - Your "neighbor X.X.X.X remote-as" value               │
  │ - Peer's "router bgp" configuration                     │
  └─────────────────────────────────────────────────────────┘

  Data (hex):
  0000: 00 00 fd e9
```

---

## 6. Development Status

### Done

- pcap and pcapng parsing, Ethernet / Linux SLL, VLAN and QinQ tags
- BGP parsing: OPEN (with capabilities), UPDATE (with path attributes), NOTIFICATION,
  KEEPALIVE, ROUTE-REFRESH
- Dashboard, Message Explorer, Neighbor Analysis, Route Analysis, SQL Console
- Sample capture offered on the upload screen
- Filter expression language with in-memory and SQL backends
- DuckDB WASM query engine, IndexedDB persistence
- TCP segment reassembly, so messages split across segments are parsed
- Virtualized packet list with grid accessibility semantics
- Error boundary with a reset path out of a crash loop
- GitHub Pages deployment via GitHub Actions
- ContainerLab test topology (`testlab/`) for generating capture fixtures
- Capability diff: side-by-side OPEN comparison on the Neighbor Analysis page
- Light / dark theme following the system preference
- Screen state in the URL query string (filter, selection, sort, match direction)
- Playwright end-to-end suite, run on pull requests and before deploy
- IPv6 transport, and BGP on non-standard ports detected by message marker
- EVPN route decoding, and the filter fields that address it
- Exporting the filtered packet list back to pcap
- Capture Builder, and `testlab/scenarios.ts` on the same library

### Next

- Multiple captures loaded side by side
- The gaps in `docs/troubleshooting-scenarios.md`: a one-sided capture reported as
  healthy, a post-establishment TCP reset that never reaches the dashboard, and
  best-path attributes (MED, LOCAL_PREF, communities) missing from the route history
  and the filter language

---

## 7. Constraints & Assumptions

- BGP messages spanning TCP segments are reassembled per directional flow. The
  leftover buffer is capped at `BGP_MAX_MESSAGE_LENGTH`; beyond that the flow is
  treated as desynced and dropped with a warning, so a permanently misaligned or
  heavily retransmitting flow cannot grow it without bound
- IPv4 transport only. IPv6 prefixes are supported inside UPDATE messages via
  MP_REACH_NLRI / MP_UNREACH_NLRI, but BGP sessions carried over IPv6 are not parsed
- Link layer: Ethernet II (link type 1) and Linux cooked capture / SLL (113).
  802.1Q and QinQ tags are stripped
- BGP over TCP port 179 only

---

## 8. Success Criteria

- Parse pcap and display BGP messages within 3 seconds
- Correctly display all major fields for OPEN/NOTIFICATION
- Enable first-level BGP session troubleshooting without Wireshark installed