# Changelog

Notable changes to BGPShark, newest first. Versions follow [Semantic Versioning](https://semver.org/); before 1.0 a minor version may change behaviour.

Each version's section here becomes the top of its GitHub Release notes (`.github/workflows/release.yml`). To release, add a section for the new version, set the same version in `package.json`, merge to `main`, then push the tag `v<version>` on that commit.

## [Unreleased]

### Development

- `bun run pcap` builds a capture file from a preset or a capture description (`.ts` / `.json`), writes it to `testlab/out/`, and with `--dump` lists every frame as the app's parsers decode it. `bun run pcap --new <file>` writes a starter description.
- `src/lib/build` gains `establish()`, `mergeCaptures()`, `keepSide()` and the shared `ROUTER_A` / `ROUTER_B` peers, and each built capture records which peer sent every frame.

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
