# DuckDB WASM: the migration proposal

> **What this is.** The proposal written before DuckDB WASM was introduced, kept
> for the reasoning rather than the design. The migration is done and the
> implementation did not follow the proposal. **`design.md` §4.3 is authoritative**,
> and the only definition of the schema is `src/lib/db/schema.ts`.
>
> The original document carried full listings of `loader.ts`, `filter-to-sql.ts`,
> `queries.ts` and a `useDuckDB` hook, plus a copy of the schema and a week-by-week
> plan. None of that survived contact with the implementation, and all of it now has
> a real version in the repository, so it has been cut rather than kept as a second
> answer to questions the code already answers. What is left is the part with no
> other home: why DuckDB, what changed on the way, and what was turned down.

## Why a database at all

The app used to hold parsed packets in React state and filter them by walking the
array. Four things were pushing against that:

1. **Scale.** Captures beyond ~100,000 packets got slow.
2. **Filtering.** A linear scan, with no index, on every keystroke.
3. **Query complexity.** Every new question meant extending a bespoke evaluator.
4. **Aggregation.** AS_PATH statistics and per-prefix history were awkward to
   express and re-derived per render.

DuckDB WASM is an embedded OLAP database that runs in the browser: columnar
storage, real SQL, no server. The bet was that the questions this app asks —
"every prefix inside 10.0.0.0/8", "which AS numbers appear in any path",
"how often did this route go away" — are the questions a column store is good at,
and are cheaper to maintain as SQL than as another branch of a hand-written
evaluator.

## What changed between the proposal and the implementation

| Topic | Proposed | Implemented |
|-------|----------|-------------|
| Bundle delivery | jsDelivr CDN | Self-hosted — imported with Vite's `?url` and served from `dist/assets/`, because of the CSP |
| Query API | `getPackets`, `getNeighborSummary`, `getAsPathStats`, `getPrefixStats` | Two entry points: `getMatchingFrameIndexes` and `executeRawSql` |
| SQL results | Rebuild `BgpPacket` objects from rows | Return frame indexes only, resolved against the already-parsed objects |
| Aggregation screens | Aggregate in DuckDB | In memory (`useMemo`), so the screens survive DuckDB failing |
| React integration | A new `useDuckDB` hook | No new hook; folded into `useBgpAnalyzer` and `useFilter` |
| CIDR matching | PostgreSQL `inet` operators | DuckDB has no `inet` type — bit-string columns plus `LIKE 'bits%'` |
| Row loading | Prepared statements per row | Literal `VALUES`, batched by statement size (see below) |

The first four are one decision seen from four sides, and `design.md` §4.3
explains it under "DuckDB's role is intentionally narrow": DuckDB selects, it does
not reconstitute. The flattened tables cannot represent everything the parser
produces, so anything that round-trips through them loses fidelity — which is
exactly what the proposed `getPackets` did, silently, until a filtered OPEN with an
ADD-PATH capability threw.

The last row is the more recent correction, and the sharper lesson. The loader
originally inserted through `read_json_auto`. That reads well and is fast, but
DuckDB's JSON reader is an **extension**, and DuckDB WASM downloads extensions from
`extensions.duckdb.org` on first use. Under the production CSP that download cannot
happen, so every capture failed to load and the SQL console was dead on the deployed
site — invisible in development, where there is no CSP and the download succeeds.
Self-hosting the runtime was necessary but not sufficient: the constraint applies to
how the database is *used*, not only to how it is served.

## Trade-offs accepted

**In favour.** Columnar storage for filtering; scale; SQL as an extension point that
needs no parser work; `GROUP BY` / `COUNT` / `JOIN` for analysis; query planning
handled for us.

**Against.**

1. **Initial load.** The WASM binary has to be fetched. Self-hosting makes `dist/`
   carry two bundles, but a browser downloads only the one it selects, and the
   import is deferred so the upload screen does not pay for it (`design.md` §3.3).
2. **Memory.** DuckDB's own overhead, on top of the parsed packets that are kept
   anyway.
3. **Type conversion** between SQL and JS at every boundary.
4. **Debugging** a failing query is harder than debugging a predicate.
5. **Initialization can fail.** Some environments will not run the WASM at all, so
   filtering falls back to in-memory evaluation and only the SQL console goes away.

Points 1 and 5 are the reasons the aggregation screens were kept in memory. A
design where every screen needed DuckDB would make item 5 fatal instead of partial.

## Alternatives considered

- **IndexedDB with hand-built indexes.** Lighter, but the query capability would
  have to be written and maintained by us — which is the cost the migration existed
  to remove.
- **sql.js (SQLite WASM).** Smaller than DuckDB, but row-oriented, so the
  aggregate-heavy queries this app asks are the ones it is worst at.
- **Web Workers, keeping the array scan.** Moves the work off the main thread
  without making it less work. Helps responsiveness, not scale.
