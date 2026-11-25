# Changelog

Notable changes to BGPShark, newest first. Versions follow [Semantic Versioning](https://semver.org/); before 1.0 a minor version may change behaviour.

Each version's section here becomes the top of its GitHub Release notes (`.github/workflows/release.yml`). To release, add a section for the new version, set the same version in `package.json`, merge to `main`, then push the tag `v<version>` on that commit.

## [Unreleased]

### Changed

- **Captures up to 300 MB** (was 100 MB). Measured on four synthetic shapes at 300 MB, every screen opens, the SQL console included, with the heap under 3 GB once garbage is collected and no task over a second; see the Performance section and `docs/design.md` §3.1.
- On a capture with more than 50,000 routes, **Routes** first lists them in capture order, with *sorting...* beside the count, until they are sorted.
- **DuckDB is loaded only for the SQL console.** It is no longer started at page load or filled in the background; the capture is inserted when the SQL console opens. Every other screen, filtering included, works without it.
- **Filtering always runs in memory.** On captures over 20,000 packets it waits for typing to pause and runs in slices, so typing never freezes.
- **`!=` and `not contains` are the complement of `=` and `contains`**, as in Wireshark: `prefix != 10.0.0.0/8` now also matches OPENs and KEEPALIVEs on small captures, as it already did on large ones.

### Fixed

- **Route servers and route reflectors no longer confuse the route findings.** Route state was kept per sender, so one address sending each neighbour its own copy of a route read as one peer. The members' different paths showed up as *AS_PATH changed*, and a withdrawal passed to several members counted as one flap. Flaps and AS_PATH changes are now counted per session (sender and receiver) on the Routes screen, in the findings and in the SQL *Prefix Flapping* template. The route history gains a **To** column when one peer sends the route to several neighbours. Route state takes two bits per route instead of a byte, so 300 sessions of 200,000 routes fit in less heap than the per-sender state took.
- A dense capture under the 100 MB limit (22 million announced routes) ran DuckDB out of memory and lost its SQL console. The tables are now compressed and have no primary keys: that capture takes 139 MB instead of failing at 3.1 GB.

### Performance

Measured at 300 MB in headless Chromium (`testlab/measure-large.ts`):

- The heap a capture needs once loaded and explored, at its largest: 3.55 → 2.51 GB when every UPDATE is its own, 2.40 → 1.94 GB for a table transfer of 1.2 million routes, 1.76 → 1.42 GB for 200 routes per UPDATE, 2.18 → 2.05 GB for EVPN with ADD-PATH. Decoded arrays are exactly as long as they are (each kept room for seventeen elements), packets' byte views are made when read, and a route's parsed prefix when first needed.
- No task holds the page for a second: the longest is 0.21 s, down from 2.8 s. The route history is laid out in slices from chunked columns, the route rules keep a running top five instead of sorting every candidate, and the Routes screen sorts large lists in slices and finds the selected route without building a map of every route.
- The tab's memory at its largest is 0.9–1.3 GB lower; the SQL console's load reuses its column buffers and works out IPv4 `prefix_bits` without BigInts. Its time is bound by the DuckDB worker and moved little (37–99 s at 300 MB).

Measured earlier, on synthetic ~95 MB captures:

- Findings appear in 3–11 s instead of 5–40 s, and the heap peaks at 0.65–1.8 GB instead of 0.9–3.7 GB. The worst case was a table transfer cycling through 1.2 million routes.
- Decoding shares repeated prefixes across a full table (up to about a million). Route statistics find IPv4 routes without building a text key per announcement.
- The SQL console's insert is dictionary-encoded and written once per row instead of twice.

### Development

- `testlab/large-captures.ts` writes synthetic captures of four shapes near the size limit, and `testlab/measure-large.ts` walks them through every screen of the production build, recording time, heap, longest task and renderer memory per stage. `testlab/measure-pipeline.ts` runs the in-memory stages in Node for CPU profiles and heap snapshots. See `testlab/README.md`.
- `bun run pcap` builds a capture file from a preset or a capture description (`.ts` / `.json`), writes it to `testlab/out/`, and with `--dump` lists every frame as the app's parsers decode it. `bun run pcap --new <file>` writes a starter description.
- `src/lib/build` gains `establish()`, `mergeCaptures()`, `keepSide()` and the shared `ROUTER_A` / `ROUTER_B` peers, and each built capture records which peer sent every frame.
- `bun run pcap` also takes existing `.pcap` / `.pcapng` files, and `src/lib/build` can now build what a clean session cannot: verbatim bytes inside a session (`{ type: 'RAW' }`, `bgpMessage`, `hex`), packets that are not a session (`buildPackets`, with UDP, ICMP and raw IP frames), and edits to any capture (`readCapture`, `dropFrames`, `shiftTime`, `overwriteBytes`, `snapFrames`, `patchRecord`, …).

## [0.1.0] - 2026-11-24

The first tagged release. BGPShark is live at <https://shmuto.github.io/bgpshark/>.

### Capture loading and decoding

- Opens `.pcap`, `.pcapng` and `.cap` files up to 100 MB, entirely in the browser; nothing is uploaded.
- Ethernet II and Linux SLL link types, 802.1Q / QinQ tags, IPv4 and IPv6 transport, and BGP on non-standard ports.
- Reassembles BGP messages split across TCP segments.
- Decodes OPEN capabilities, UPDATE path attributes (including MP_REACH / MP_UNREACH, ADD-PATH, large and extended communities), EVPN routes, NOTIFICATION data with troubleshooting hints, and ROUTE-REFRESH.
- Reads 4-byte AS and ADD-PATH UPDATEs correctly even when the capture starts after the OPENs.

### Investigation workspace

- **Messages**: virtualized packet list, structured detail, hex dump, and export of the filtered frames to `.pcap`.
- **Sessions**: every session with its end-of-capture state, a side-by-side OPEN and capability diff, and ADD-PATH negotiation results.
- **Routes**: per-prefix announce and withdraw history, flap counts, and best-path attributes.
- **SQL Console**: ad-hoc SQL over the capture with DuckDB WASM.
- **Findings**: alerts for NOTIFICATIONs, session and route flapping, withdrawal bursts, AS_PATH changes, MAC moves, silent teardowns, Graceful Restart and failed session setup, folded into one row per kind of problem.
- A time strip to narrow every view to a time window, and a session picker to narrow it to one session.

### Filtering

- One Wireshark-style query box with autocomplete, a menu-driven **+ Filter**, and "filter on this value" from packet details.
- CIDR-aware prefix matching; runs on DuckDB when available and in memory otherwise, with the same results.

### Capture Builder

- Generates valid BGP captures from eight presets or custom peer and message sequences, with correct checksums and MTU-based TCP segmentation.

### Everything else

- In-app user manual in English and Japanese, including symptom-based troubleshooting walkthroughs.
- English and Japanese UI, light and dark themes, and restore of the last capture across reloads.
- Strict production Content Security Policy and zero third-party requests.

[Unreleased]: https://github.com/shmuto/bgpshark/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shmuto/bgpshark/releases/tag/v0.1.0
