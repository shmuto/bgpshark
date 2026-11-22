# DuckDB WASM — Architecture Decision Record

> Records why DuckDB WASM was adopted, how the shipped implementation diverged from the initial proposal, and the trade-offs accepted.
> For the current architecture, see [`design.md` §4.3](design.md#43-data-flow). The authoritative schema is [`src/lib/db/schema.ts`](../src/lib/db/schema.ts).

## Why an in-browser database

Earlier revisions held parsed packets in React state and filtered them with a linear array scan. That broke down in four ways:

1. **Scale:** Captures beyond ~100,000 packets became sluggish.
2. **Filtering:** Unindexed full-array scans on every filter edit.
3. **Extensibility:** Every new query shape required extending a custom evaluator.
4. **Ad-hoc analysis:** Cross-prefix and AS_PATH aggregations were awkward to express without a query language.

DuckDB WASM provides columnar in-browser storage and full SQL with no server component, fitting BGPShark's aggregate- and filter-heavy queries while keeping everything client-side.

## Proposal vs. implementation

| Topic | Initial proposal | Shipped implementation |
|-------|------------------|------------------------|
| Bundle delivery | jsDelivr CDN | Self-hosted in `dist/assets/` via Vite `?url` imports to comply with CSP |
| Query API | `getPackets`, `getNeighborSummary`, `getAsPathStats`, `getPrefixStats` | Two entry points: `getMatchingFrameIndexes` and `executeRawSql` |
| Filter results | Reconstruct `BgpPacket` objects from SQL rows | Return `frameIndex` values only; resolve against parsed objects in memory |
| Aggregation views | Compute in DuckDB | Compute in memory (`useMemo`) so screens stay functional if DuckDB fails |
| React integration | Dedicated `useDuckDB` hook | Folded into `useBgpAnalyzer` and `useFilter` |
| CIDR matching | PostgreSQL `inet` operators | Bit-string columns (`prefix_bits`) with `LIKE 'bits%'` |
| Row ingestion | Per-row prepared statements | Arrow IPC into a staging table, then `INSERT ... SELECT` |

### Key lessons

- **Select, do not reconstitute:** The SQL tables are a flattened projection that cannot losslessly represent every nested capability or attribute. Returning only `frameIndex` values prevents data loss when filters are active (`design.md` §4.3).
- **CSP applies to database features, not just static assets:**
  - Loading via `read_json_auto` failed in production because DuckDB's JSON reader is a dynamically downloaded extension blocked by `connect-src 'self'`.
  - Loading via literal `VALUES` avoided the network but spent ~0.1 ms per row parsing SQL (nearly 2 minutes for an 18 MB / 1.6M-row capture).
  - Loading via built-in **Arrow IPC** (`insertArrowFromIPCStream`) requires no extension and loads the same capture in a few seconds. Arrow buffers are assembled manually because `apache-arrow`'s high-level builders use `new Function`, which the production CSP's `script-src` forbids. Staging tables + named-column `INSERT ... SELECT` let DuckDB bind and cast columns safely.

## Trade-offs accepted

**Benefits:** Columnar filtering at scale, built-in query planning, and ad-hoc SQL without maintaining custom query syntax.

**Costs:**
1. **Bundle size & load time:** Self-hosting adds two WASM bundles (`mvp` and `eh`) to `dist/`; browsers download only one, and loading is deferred until a capture is opened (`design.md` §3.3).
2. **Memory overhead:** DuckDB holds table copies alongside the in-memory `BgpPacket[]`.
3. **JS/SQL boundary conversion** and harder query debugging compared to plain predicates.
4. **Possible initialization failure:** Handled by keeping aggregation views in memory and falling back to the in-memory filter evaluator so only the SQL Console is lost.

## Alternatives rejected

- **IndexedDB with custom indexes:** Lighter footprint, but requires building and maintaining a custom query engine.
- **sql.js (SQLite WASM):** Smaller binary, but row-oriented and poorly suited to aggregate-heavy analytical queries.
- **Web Workers with linear scans:** Improves UI responsiveness without improving algorithmic scale or ad-hoc querying.
