import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useWorkspace } from '../context/WorkspaceContext'
import { useAutoSelectFirst } from '../hooks/useAutoSelectFirst'
import { useIsCompact } from '../hooks/useMediaQuery'
import { BackToList, PaneDivider } from '../components/common'
import { useSplitPane } from '../hooks/useSplitPane'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { prefixStatsFor, type PrefixEvent, type PrefixStats } from '../lib/bgp/prefix-stats'
import { contains, equals, parsePrefix, type ParsedPrefix } from '../lib/net/prefix'
import { formatDelta, formatTimeOfDayUtc } from '../lib/format-time'
import { collapsePrepends, formatAsPath } from '../lib/bgp/as-path-display'
import { useI18n } from '../i18n'

/** What the text in the search box turned out to be. */
type Search =
  | { kind: 'prefix'; prefix: ParsedPrefix }
  | { kind: 'asn'; asn: string }
  | { kind: 'text'; text: string }

type SortColumn = 'prefix' | 'announced' | 'withdrawn' | 'lastSeen' | 'flap'
type SortDirection = 'asc' | 'desc'

/**
 * Which way a prefix search reads.
 *
 * Containment has a direction, and the two directions are different questions:
 * searching 10.30.0.0/11 asks what is announced inside that block, while
 * searching 10.30.0.0/24 usually asks which announcement carries it — the
 * 10.30.0.0/16 that covers it is an answer no downward search can give. One
 * checkbox cannot say which is meant, so the user picks.
 */
type MatchMode = 'exact' | 'subnets' | 'supernets'

const MATCH_MODE_VALUES: readonly MatchMode[] = ['exact', 'subnets', 'supernets']

function isMatchMode(value: string | null): value is MatchMode {
  return value !== null && (MATCH_MODE_VALUES as readonly string[]).includes(value)
}

/**
 * Which way each column reads when you first click it.
 *
 * A prefix list wants to start alphabetically; a count column is being clicked
 * because you want to know which is worst, so it starts at the top.
 */
const DEFAULT_DIRECTION: Record<SortColumn, SortDirection> = {
  prefix: 'asc',
  announced: 'desc',
  withdrawn: 'desc',
  lastSeen: 'desc',
  flap: 'desc',
}

/** The Messages filter that selects one route of this screen, or null. */
function routeFilter(key: string): string | null {
  if (key.startsWith('[')) {
    const mac = key.match(/[0-9a-f]{2}(?::[0-9a-f]{2}){5}/i)?.[0]
    return mac ? `mac = ${mac}` : null
  }
  return `prefix = ${key}`
}

/** How long the search box waits for typing to pause before applying it. */
const SEARCH_DEBOUNCE_MS = 200

function isSortColumn(value: string | null): value is SortColumn {
  return value !== null && value in DEFAULT_DIRECTION
}

export function RoutesPage() {
  const { packets } = useApp()
  // Narrowed to the session chosen in the workspace. History rows still have
  // to open the right packet, and their indexes count from the scoped list, so
  // they are mapped back to the capture's own index before linking.
  const { scopedPackets } = useWorkspace()
  const { t } = useI18n()
  const rt = t.routes
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  /**
   * What you are looking at lives in the URL, the way it does on Messages.
   *
   * Reading a capture means sending someone a link to the thing you found, and
   * reloading without losing your place. The search, the selected prefix and the
   * sort are all part of "the thing you found".
   */
  const searchQuery = searchParams.get('q') ?? ''
  const selectedPrefix = searchParams.get('prefix')
  const sortColumn = isSortColumn(searchParams.get('sort')) ? (searchParams.get('sort') as SortColumn) : 'flap'
  const sortDirection: SortDirection = searchParams.get('dir') === 'asc' ? 'asc' : 'desc'
  // A bare link searches downwards, which is what a link to a block is usually
  // about.
  /**
   * Narrow to the routes one peer announced. Links from the old neighbours
   * screen carried it, and a shared link still can, so it is honoured.
   */
  const peerFilter = useMemo(
    () => (searchParams.get('peer') ?? '').split(',').filter(Boolean),
    [searchParams]
  )

  const matchMode: MatchMode = isMatchMode(searchParams.get('match'))
    ? (searchParams.get('match') as MatchMode)
    : 'subnets'

  const updateParams = useCallback(
    (changes: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          for (const [key, value] of Object.entries(changes)) {
            if (value === null) {
              prev.delete(key)
            } else {
              prev.set(key, value)
            }
          }
          return prev
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const setSelectedPrefix = useCallback(
    (prefix: string | null) => updateParams({ prefix }),
    [updateParams]
  )
  const setMatchMode = useCallback(
    (mode: MatchMode) => updateParams({ match: mode === 'subnets' ? null : mode }),
    [updateParams]
  )

  // The box applies itself once typing pauses, like the search on Neighbors;
  // Search (or Enter) still commits at once. The pause keeps a half-typed
  // `10.0.1` from re-filtering the table on every keystroke.
  const [searchDraft, setSearchDraft] = useState(searchQuery)
  useEffect(() => {
    const draft = searchDraft.trim()
    if (draft === searchQuery) return
    const timer = setTimeout(() => updateParams({ q: draft || null }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchDraft, searchQuery, updateParams])
  /**
   * Route History reads oldest first by default, the same way Messages and
   * Neighbors do, so a timeline does not flip direction between screens. The
   * header toggles it for the "what happened last" question.
   */
  const [historyOrder, setHistoryOrder] = useState<'asc' | 'desc'>('asc')

  // Too narrow for two columns: show the list, or the detail, but not halves of
  // both.
  const isCompact = useIsCompact()
  const split = useSplitPane('routes')
  const showList = !isCompact || selectedPrefix === null
  const showDetail = !isCompact || selectedPrefix !== null

  // The one pass over the capture. Searching and sorting work on the result, so
  // typing in the box or clicking a header never walks the packets again.
  const prefixStats = useMemo(() => prefixStatsFor(scopedPackets), [scopedPackets])

  /** Decide what kind of search the text is before matching anything against it. */
  const search = useMemo((): Search | null => {
    const text = searchQuery.trim()
    if (!text) return null

    // `AS65001` or a bare AS number. Neither can be read as an address.
    const asn = text.match(/^(?:as)?(\d+)$/i)
    if (asn) return { kind: 'asn', asn: asn[1] }

    const prefix = parsePrefix(text)
    if (prefix) return { kind: 'prefix', prefix }

    // Not an address at all (a half-typed one, say) — fall back to substring.
    return { kind: 'text', text: text.toLowerCase() }
  }, [searchQuery])

  // Filter prefixes
  const peerFilteredPrefixes = useMemo(() => {
    if (peerFilter.length === 0) return prefixStats
    const peers = new Set(peerFilter)
    return prefixStats.filter((stat) => stat.history.some((event) => peers.has(event.source)))
  }, [prefixStats, peerFilter])

  const filteredPrefixes = useMemo(() => {
    const prefixStats = peerFilteredPrefixes
    if (!search) return prefixStats

    switch (search.kind) {
      case 'asn':
        return prefixStats.filter(stat => stat.asns.includes(search.asn))

      case 'prefix':
        return prefixStats.filter(stat => {
          if (!stat.parsed) return false
          // A bare address is its own /32 and follows the same direction as
          // everything else, so 10.0.13.1 and 10.0.13.1/32 always agree.
          switch (matchMode) {
            case 'exact':
              return equals(search.prefix, stat.parsed)
            case 'subnets':
              return contains(search.prefix, stat.parsed)
            case 'supernets':
              return contains(stat.parsed, search.prefix)
          }
        })

      case 'text':
        return prefixStats.filter(stat => stat.key.toLowerCase().includes(search.text))
    }
  }, [peerFilteredPrefixes, search, matchMode])

  const sortedPrefixes = useMemo(() => {
    const factor = sortDirection === 'asc' ? 1 : -1

    /**
     * What separates two routes the chosen column cannot tell apart.
     *
     * Flap is now a count of transitions, so a capture where nothing flapped
     * leaves every row at zero. Falling back to how much was said about each
     * route puts the ones worth looking at first instead of leaving the order
     * to chance, and it stays a busiest-first tiebreak whichever way the column
     * itself is pointing.
     */
    const tiebreak = (a: PrefixStats, b: PrefixStats) =>
      b.eventCount - a.eventCount || a.key.localeCompare(b.key)

    return [...filteredPrefixes].sort((a, b) => {
      switch (sortColumn) {
        case 'prefix':
          // Numeric order, so 10.0.9.0/24 comes before 10.0.12.0/24 rather than
          // after it the way a string comparison would have it. Prefixes with no
          // parsed form keep a stable place at the end.
          if (!a.parsed || !b.parsed) return a.key.localeCompare(b.key) * factor
          if (a.parsed.family !== b.parsed.family) return (a.parsed.family - b.parsed.family) * factor
          if (a.parsed.bits !== b.parsed.bits) return (a.parsed.bits < b.parsed.bits ? -1 : 1) * factor
          return (a.parsed.length - b.parsed.length) * factor || tiebreak(a, b)
        case 'lastSeen':
          return (a.lastSeenMs - b.lastSeenMs) * factor || tiebreak(a, b)
        default:
          return (a[sortColumn] - b[sortColumn]) * factor || tiebreak(a, b)
      }
    })
  }, [filteredPrefixes, sortColumn, sortDirection])

  // Only the rows near the viewport are mounted: a busy capture holds tens of
  // thousands of routes, and asking the browser to lay all of them out is what
  // made arriving on this screen hang.
  useAutoSelectFirst(!isCompact, selectedPrefix, sortedPrefixes[0]?.key, setSelectedPrefix)
  const rows = useVirtualRows(sortedPrefixes.length)

  const toggleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      updateParams({ dir: sortDirection === 'asc' ? 'desc' : 'asc' })
    } else {
      updateParams({ sort: column, dir: DEFAULT_DIRECTION[column] })
    }
  }

  // Get selected prefix stats. Looked up rather than scanned for, so a capture
  // with tens of thousands of routes does not walk the list on every render.
  const statsByPrefix = useMemo(
    () => new Map(prefixStats.map(stat => [stat.key, stat])),
    [prefixStats]
  )
  const selectedPrefixStats = selectedPrefix ? statsByPrefix.get(selectedPrefix) ?? null : null

  /**
   * The distinct AS_PATHs this prefix was announced with, most seen first.
   *
   * A prefix arriving over more than one path is the interesting case — it is
   * either multihoming or a route leak, and which one you are looking at is a
   * judgement the numbers here support rather than make.
   */
  const asPathVariants = useMemo(() => {
    if (!selectedPrefixStats) return []

    const counts = new Map<string, { path: string[]; count: number; lastSeen: Date }>()
    for (const event of selectedPrefixStats.history) {
      if (event.action !== 'announce') continue
      const asPath = event.asPath?.trim()
      if (!asPath) continue

      const existing = counts.get(asPath)
      if (existing) {
        existing.count++
        if (event.timestamp > existing.lastSeen) existing.lastSeen = event.timestamp
      } else {
        counts.set(asPath, { path: asPath.split(/\s+/), count: 1, lastSeen: event.timestamp })
      }
    }

    return Array.from(counts.values()).sort((a, b) => b.count - a.count)
  }, [selectedPrefixStats])

  /**
   * Opens the UPDATE behind a history row, with the list narrowed to this
   * route, so the reader lands among the other events of the same story
   * rather than somewhere in the whole capture. EVPN routes are narrowed by
   * their MAC where they have one, since `prefix` does not name them.
   */
  const handleHistoryClick = (event: PrefixEvent) => {
    const filter = selectedPrefix ? routeFilter(selectedPrefix) : null
    const params = new URLSearchParams()
    if (filter) params.set('filter', filter)
    const index = packets.indexOf(scopedPackets[event.packetIndex])
    params.set('selected', String(index >= 0 ? index : event.packetIndex))
    navigate(`/messages?${params.toString()}`)
  }

  /**
   * EVPN routes carry a Route Distinguisher and nothing else does, so the
   * column only appears when the selected route has one. On a MAC move it is
   * the column that tells the story: the RD changes and the MAC does not.
   */
  const showRdColumn = selectedPrefixStats?.history.some((event) => event.rd) ?? false

  /**
   * The best-path attributes, each shown only when the selected route actually
   * carries it.
   *
   * Four more columns on every route would be four columns of `-` on most of
   * them: LOCAL_PREF is iBGP-only, MED is optional, and plenty of captures have
   * neither. Showing a column only when it has something to say keeps the
   * comparison — two peers announcing the same prefix, side by side — narrow
   * enough to read across.
   */
  const showMedColumn =
    selectedPrefixStats?.history.some((event) => event.med !== undefined) ?? false
  const showLocalPrefColumn =
    selectedPrefixStats?.history.some((event) => event.localPref !== undefined) ?? false
  /**
   * ORIGIN earns a column only when it *varies*. It is IGP on almost every route
   * in practice, and a column of identical values costs width that MED,
   * LOCAL_PREF and the communities need — those are what decide a best path
   * argument. When it does differ between two announcements it is suddenly the
   * interesting column, and then it appears.
   */
  const showOriginColumn =
    new Set(
      selectedPrefixStats?.history
        .filter((event) => event.origin !== undefined)
        .map((event) => event.origin)
    ).size > 1
  const showCommunitiesColumn =
    selectedPrefixStats?.history.some((event) => (event.communities?.length ?? 0) > 0) ?? false
  /**
   * The ADD-PATH Path Identifier, shown only on a route that has one — which is
   * to say only on a session that negotiated ADD-PATH for this family.
   *
   * It earns a column because without it two rows of this table can be
   * identical in every visible field and still be different routes: same
   * prefix, same peer, same time, two paths. A withdraw of one of them then
   * reads as the prefix going away, which is the wrong answer and an
   * unarguable-looking one.
   */
  const showPathIdColumn =
    selectedPrefixStats?.history.some((event) => event.pathId !== undefined) ?? false

  const matchModes: { value: MatchMode; label: string; hint: string }[] = [
    { value: 'exact', label: rt.matchExact, hint: rt.matchExactHint },
    { value: 'subnets', label: rt.matchSubnets, hint: rt.matchSubnetsHint },
    { value: 'supernets', label: rt.matchSupernets, hint: rt.matchSupernetsHint },
  ]

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-canvas">
      {/* Search Bar — one row: the box applies itself as you type, so it
          needs neither a heading to explain it nor a button to submit it, and
          the Match control sits beside the query it qualifies. */}
      <div className="px-4 py-2 bg-surface border-b border-hair">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault()
              updateParams({ q: searchDraft.trim() || null })
            }}
            className="relative flex-1 min-w-[16rem]"
          >
            <svg
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-dim pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              aria-label={rt.searchAria}
              value={searchDraft}
              onChange={(e) => {
                setSearchDraft(e.target.value)
                // Clearing the box restores the full list at once rather than
                // after the typing pause.
                if (!e.target.value.trim()) updateParams({ q: null })
              }}
              placeholder={rt.searchPlaceholder}
              className="w-full pl-8 pr-8 py-1.5 border border-hair-strong rounded focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent text-xs font-mono placeholder:font-sans placeholder:text-dim"
            />
            {searchDraft && (
              <button
                type="button"
                aria-label={rt.clearSearchAria}
                onClick={() => {
                  setSearchDraft('')
                  updateParams({ q: null })
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-dim hover:text-strong"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </form>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {/* Radios rather than a checkbox: these are three different
                questions about the block typed, not one question with a
                modifier on it. */}
            <div role="radiogroup" aria-label={rt.matchLabel} className="flex items-center gap-2">
              <span className="text-xs text-muted">{rt.matchLabel}</span>
              {/* The focus ring goes round the whole control rather than the
                  segment: the segments are clipped to the rounded corners, so
                  an outline on one of them would be cut off, and arrow keys
                  move between them anyway. */}
              <div className="flex rounded border border-hair-strong overflow-hidden has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
                {matchModes.map(mode => (
                  <label
                    key={mode.value}
                    title={mode.hint}
                    className="relative cursor-pointer border-l border-hair-strong first:border-l-0"
                  >
                    {/* Laid over the whole segment rather than hidden, so the
                        radio itself is what a click and a screen reader land
                        on. */}
                    <input
                      type="radio"
                      name="match"
                      value={mode.value}
                      checked={matchMode === mode.value}
                      onChange={() => setMatchMode(mode.value)}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer peer"
                    />
                    <span className="block px-3 py-1 text-xs text-muted hover:bg-surface-sunken peer-checked:bg-accent peer-checked:text-accent-fg">
                      {mode.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {search?.kind === 'asn' && (
              <span className="text-xs text-dim">{rt.asnSearchNote(search.asn)}</span>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div ref={split.containerRef} className="flex-1 flex flex-col lg:flex-row min-h-0 p-2 gap-2 lg:gap-0">
        {/* Prefix Statistics */}
        {showList && (
        <div
          role="region"
          aria-labelledby="routes-prefix-statistics"
          className="w-full flex-1 lg:flex-none bg-surface border border-hair flex flex-col min-h-0"
          style={isCompact ? undefined : { width: `calc(${split.percent}% - 0.5rem)` }}
        >
          <div className="px-3 py-2 border-b border-hair flex items-center gap-2 shrink-0">
            <h2 id="routes-prefix-statistics" className="text-xs font-semibold text-strong">{rt.prefixStatistics}</h2>
            {peerFilter.length > 0 && (
              <button
                onClick={() => updateParams({ peer: null })}
                title={rt.showAllPeersTitle}
                className="text-xs bg-accent-subtle text-accent rounded px-2 py-0.5 hover:opacity-75"
              >
                {rt.fromPeers(peerFilter.join(', '))}
              </button>
            )}
            <span className="text-xs text-muted ml-auto">{rt.prefixesCount(filteredPrefixes.length)}</span>
          </div>
          <div ref={rows.containerRef} onScroll={rows.onScroll} className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead ref={rows.measureHeaderRef} className="bg-surface-sunken sticky top-0">
                <tr className="text-left text-muted">
                  <SortableHeader column="prefix" {...{ sortColumn, sortDirection, toggleSort }}>
                    {rt.colPrefix}
                  </SortableHeader>
                  <SortableHeader column="announced" align="right" {...{ sortColumn, sortDirection, toggleSort }}>
                    {rt.colAnnounced}
                  </SortableHeader>
                  <SortableHeader column="withdrawn" align="right" {...{ sortColumn, sortDirection, toggleSort }}>
                    {rt.colWithdrawn}
                  </SortableHeader>
                  <SortableHeader column="lastSeen" align="right" {...{ sortColumn, sortDirection, toggleSort }}>
                    {rt.colLastSeen}
                  </SortableHeader>
                  {/* The one column whose meaning is not its name: say what it
                      counts where the number is read. */}
                  <SortableHeader
                    column="flap"
                    align="right"
                    title={rt.colFlapTitle}
                    {...{ sortColumn, sortDirection, toggleSort }}
                  >
                    {rt.colFlap}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-hair">
                {/* Spacers stand in for the rows that are not mounted, so the
                    scrollbar still measures the whole list. They carry no rule
                    of their own, or the divider between real rows would double
                    up at the edges of the window. */}
                {rows.topSpacerHeight > 0 && (
                  <tr aria-hidden="true" style={{ height: rows.topSpacerHeight, borderTopWidth: 0 }}>
                    <td colSpan={5} style={{ padding: 0, border: 0 }} />
                  </tr>
                )}
                {sortedPrefixes.slice(rows.startIndex, rows.endIndex).map((stat, i) => (
                  <tr
                    key={stat.key}
                    ref={i === 0 ? rows.measureRowRef : undefined}
                    onClick={() => setSelectedPrefix(stat.key)}
                    className={`cursor-pointer hover:bg-surface-sunken ${
                      selectedPrefix === stat.key ? 'bg-accent-subtle' : ''
                    }`}
                  >
                    <td className="px-3 py-1 font-mono text-strong">{stat.key}</td>
                    <td className="px-3 py-1 text-right text-ok">{stat.announced}</td>
                    <td className="px-3 py-1 text-right text-critical">{stat.withdrawn}</td>
                    <td className="px-3 py-1 text-right font-mono text-muted">
                      {formatTimeOfDayUtc(stat.lastSeen)}
                    </td>
                    <td className="px-3 py-1 text-right">
                      <span className={stat.flap > 10 ? 'text-warning font-medium' : 'text-muted'}>
                        {stat.flap}
                        {stat.flap > 10 && ' ⚠'}
                      </span>
                    </td>
                  </tr>
                ))}
                {rows.bottomSpacerHeight > 0 && (
                  <tr aria-hidden="true" style={{ height: rows.bottomSpacerHeight, borderTopWidth: 0 }}>
                    <td colSpan={5} style={{ padding: 0, border: 0 }} />
                  </tr>
                )}
              </tbody>
            </table>
            {sortedPrefixes.length === 0 && (
              <div className="text-center text-dim py-8">
                {rt.noPrefixesFound}
              </div>
            )}
          </div>
        </div>
        )}

        {!isCompact && (
          <PaneDivider
            isDragging={split.isDragging}
            onDragStart={split.startDrag}
            onReset={split.reset}
            onNudge={split.nudge}
            label={rt.resizePrefixList}
          />
        )}

        {/* Route History and the paths it arrived over */}
        {/* min-w-0: a flex item defaults to min-width:auto, so without it the
            Route History table's width propagated up and pushed this pane —
            AS_PATH Analysis included — past the right edge of the window,
            instead of scrolling inside the table's own container. */}
        {showDetail && (
        <div className="w-full flex-1 flex flex-col min-h-0 min-w-0 gap-2 lg:ml-1">
        <div role="region" aria-labelledby="routes-history" className="bg-surface border border-hair flex flex-col min-h-0 flex-1">
          <div className="px-3 py-2 border-b border-hair flex items-center gap-2 shrink-0">
            <BackToList onClick={() => setSelectedPrefix(null)} />
            <h2 id="routes-history" className="text-xs font-semibold text-strong truncate">
              {rt.routeHistory(selectedPrefix)}
            </h2>
          </div>
          <div className="flex-1 overflow-auto">
            {selectedPrefixStats ? (
              <table className="w-full text-xs">
                <thead className="bg-surface-sunken sticky top-0">
                  <tr className="text-left text-muted">
                    <th
                      className="px-3 py-1.5 font-medium whitespace-nowrap"
                      aria-sort={historyOrder === 'asc' ? 'ascending' : 'descending'}
                    >
                      <button
                        type="button"
                        onClick={() => setHistoryOrder(historyOrder === 'asc' ? 'desc' : 'asc')}
                        title={historyOrder === 'asc' ? rt.oldestFirstTitle : rt.newestFirstTitle}
                        className="inline-flex items-center gap-1 hover:text-strong"
                      >
                        {rt.colTimeUtc} <span aria-hidden="true">{historyOrder === 'asc' ? '▲' : '▼'}</span>
                      </button>
                    </th>
                    <th className="px-3 py-1.5 font-medium" title={rt.colDeltaTitle}>Δ</th>
                    <th className="px-3 py-1.5 font-medium">{rt.colAction}</th>
                    <th className="px-3 py-1.5 font-medium">AS_PATH</th>
                    {showPathIdColumn && (
                      <th
                        className="px-3 py-1.5 font-medium"
                        title={rt.colPathIdTitle}
                      >
                        {rt.colPathId}
                      </th>
                    )}
                    {showRdColumn && (
                      <th
                        className="px-3 py-1.5 font-medium"
                        title={rt.colRdTitle}
                      >
                        RD
                      </th>
                    )}
                    <th className="px-3 py-1.5 font-medium" title={rt.colFromTitle}>{rt.colFrom}</th>
                    <th className="px-3 py-1.5 font-medium">{rt.colNextHop}</th>
                    {showMedColumn && (
                      <th
                        className="px-3 py-1.5 font-medium"
                        title={rt.colMedTitle}
                      >
                        MED
                      </th>
                    )}
                    {showLocalPrefColumn && (
                      <th
                        className="px-3 py-1.5 font-medium"
                        title={rt.colLocalPrefTitle}
                      >
                        LOCAL_PREF
                      </th>
                    )}
                    {showOriginColumn && (
                      <th className="px-3 py-1.5 font-medium" title={rt.colOriginTitle}>
                        {rt.colOrigin}
                      </th>
                    )}
                    {showCommunitiesColumn && (
                      <th className="px-3 py-1.5 font-medium">{rt.colCommunities}</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-hair">
                  {/* Whichever way the rows run, the gap on a row is the one
                      back to the event before it in time — the wait that
                      produced it. */}
                  {(historyOrder === 'asc'
                    ? selectedPrefixStats.history
                    : selectedPrefixStats.history.slice().reverse()
                  ).map((event, idx, rows) => {
                    const earlier = historyOrder === 'asc' ? rows[idx - 1] : rows[idx + 1]
                    return (
                    <tr
                      key={idx}
                      onClick={() => handleHistoryClick(event)}
                      className="cursor-pointer hover:bg-surface-sunken"
                    >
                      <td className="px-3 py-1 font-mono text-muted whitespace-nowrap">
                        {formatTimeOfDayUtc(event.timestamp)}
                      </td>
                      <td className="px-3 py-1 font-mono text-dim whitespace-nowrap">
                        {earlier ? formatDelta(event.timestamp.getTime() - earlier.timestamp.getTime()) : '-'}
                      </td>
                      <td className="px-3 py-1 whitespace-nowrap">
                        {event.action === 'announce' ? (
                          <span className="text-ok">{rt.actionAnnounce}</span>
                        ) : (
                          <span className="text-critical">{rt.actionWithdraw}</span>
                        )}
                      </td>
                      <td className="px-3 py-1 font-mono text-muted whitespace-nowrap">
                        {event.asPath ? formatAsPath(event.asPath) : '-'}
                      </td>
                      {showPathIdColumn && (
                        <td className="px-3 py-1 font-mono text-muted">{event.pathId ?? '-'}</td>
                      )}
                      {showRdColumn && (
                        <td className="px-3 py-1 font-mono text-muted">{event.rd ?? '-'}</td>
                      )}
                      <td className="px-3 py-1 font-mono text-muted whitespace-nowrap">{event.source}</td>
                      <td className="px-3 py-1 font-mono text-muted whitespace-nowrap">
                        {event.nextHop || '-'}
                      </td>
                      {/* `-` means the attribute was not on the UPDATE, which is
                          not the same as a value of zero — hence `?? '-'` rather
                          than a falsy check. */}
                      {showMedColumn && (
                        <td className="px-3 py-1 font-mono text-muted">{event.med ?? '-'}</td>
                      )}
                      {showLocalPrefColumn && (
                        <td className="px-3 py-1 font-mono text-muted">{event.localPref ?? '-'}</td>
                      )}
                      {showOriginColumn && (
                        <td className="px-3 py-1 font-mono text-muted">{event.origin ?? '-'}</td>
                      )}
                      {showCommunitiesColumn && (
                        <td
                          className="px-3 py-1 font-mono text-muted"
                          title={event.communities?.join(' ')}
                        >
                          {event.communities?.join(' ') || '-'}
                        </td>
                      )}
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <div className="text-center text-dim py-8">
                {rt.selectPrefix}
              </div>
            )}
          </div>
        </div>

        {asPathVariants.length > 0 && (
          <div role="region" aria-labelledby="routes-as-path" className="bg-surface border border-hair flex flex-col min-h-0 shrink-0 max-h-64">
            <div className="px-3 py-2 border-b border-hair flex items-center gap-2 shrink-0">
              <h2 id="routes-as-path" className="text-xs font-semibold text-strong">{rt.asPathAnalysis}</h2>
              <span className="text-xs text-muted ml-auto">
                {asPathVariants.length === 1
                  ? rt.singlePath
                  : rt.distinctPaths(asPathVariants.length)}
              </span>
            </div>
            <div className="flex-1 overflow-auto p-3 space-y-2">
              {asPathVariants.map((variant, idx) => (
                <div
                  key={variant.path.join(' ')}
                  className="flex items-center gap-2 flex-wrap text-xs"
                >
                  <div className="flex items-center gap-1 flex-wrap">
                    {collapsePrepends(variant.path).map((hop, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span className="text-dim">▶</span>}
                        <span className="font-mono rounded bg-surface-sunken px-1.5 py-0.5 text-body">
                          AS{hop.asn}
                          {hop.repeat > 1 && (
                            <span className="text-muted" title={rt.prependedTitle(hop.repeat)}>
                              {' '}×{hop.repeat}
                            </span>
                          )}
                        </span>
                      </span>
                    ))}
                  </div>
                  <span className="ml-auto text-xs text-muted whitespace-nowrap">
                    {/* The most seen path first; the others are what makes this
                        panel worth looking at. */}
                    {rt.pathSeen(idx > 0, variant.count)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        </div>
        )}
      </div>
    </div>
  )
}

interface SortableHeaderProps {
  column: SortColumn
  sortColumn: SortColumn
  sortDirection: SortDirection
  toggleSort: (column: SortColumn) => void
  align?: 'left' | 'right'
  /** What the column counts, for the columns whose name does not say. */
  title?: string
  children: React.ReactNode
}

function SortableHeader({
  column,
  sortColumn,
  sortDirection,
  toggleSort,
  align = 'left',
  title,
  children,
}: SortableHeaderProps) {
  const active = column === sortColumn

  return (
    <th className={`px-3 py-1.5 font-medium ${align === 'right' ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => toggleSort(column)}
        title={title}
        aria-sort={active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`inline-flex items-center gap-1 transition-colors hover:text-strong ${
          active ? 'text-strong' : ''
        }`}
      >
        {children}
        {/* The inactive arrow stays in the layout so the header does not shift
            when a column is picked. */}
        <span className={active ? '' : 'opacity-0'} aria-hidden="true">
          {sortDirection === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  )
}
