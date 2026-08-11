import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useIsCompact } from '../hooks/useMediaQuery'
import { BackToList, PaneDivider } from '../components/common'
import { useSplitPane } from '../hooks/useSplitPane'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { aggregatePrefixStats, type PrefixEvent, type PrefixStats } from '../lib/bgp/prefix-stats'
import { contains, equals, parsePrefix, type ParsedPrefix } from '../lib/net/prefix'
import { formatDelta, formatTimeOfDayUtc } from '../lib/format-time'
import { collapsePrepends, formatAsPath } from '../lib/bgp/as-path-display'

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

const MATCH_MODES: { value: MatchMode; label: string; hint: string }[] = [
  { value: 'exact', label: 'Exact', hint: 'Only the prefix and mask length typed' },
  { value: 'subnets', label: 'Subnets', hint: 'Routes announced inside the block typed' },
  { value: 'supernets', label: 'Supernets', hint: 'Less specific routes that cover the block typed' },
]

function isMatchMode(value: string | null): value is MatchMode {
  return MATCH_MODES.some(mode => mode.value === value)
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

function isSortColumn(value: string | null): value is SortColumn {
  return value !== null && value in DEFAULT_DIRECTION
}

export function RoutesPage() {
  const { packets } = useApp()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  /**
   * What you are looking at lives in the URL, the way it already does on the
   * neighbors screen.
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
   * Narrow to the routes one peer announced. Arrives from the neighbours
   * screen, where the question "what is this peer sending me" starts.
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

  // The box holds a draft until Search (or Enter) commits it, so the button does
  // what it says. Emptying the box clears the filter without a round trip.
  const [searchDraft, setSearchDraft] = useState(searchQuery)

  // Too narrow for two columns: show the list, or the detail, but not halves of
  // both.
  const isCompact = useIsCompact()
  const split = useSplitPane('routes')
  const showList = !isCompact || selectedPrefix === null
  const showDetail = !isCompact || selectedPrefix !== null

  // The one pass over the capture. Searching and sorting work on the result, so
  // typing in the box or clicking a header never walks the packets again.
  const prefixStats = useMemo(() => aggregatePrefixStats(packets), [packets])

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
        return prefixStats.filter(stat => stat.asns.has(search.asn))

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

  const handleHistoryClick = (event: PrefixEvent) => {
    navigate(`/messages?selected=${event.packetIndex}`)
  }

  /**
   * EVPN routes carry a Route Distinguisher and nothing else does, so the
   * column only appears when the selected route has one. On a MAC move it is
   * the column that tells the story: the RD changes and the MAC does not.
   */
  const showRdColumn = selectedPrefixStats?.history.some((event) => event.rd) ?? false

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-canvas">
      {/* Search Bar */}
      <div className="p-4 bg-surface border-b border-hair">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3">
            <span className="text-dim">🔍</span>
            <span className="text-sm font-medium text-strong">Prefix Search</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              updateParams({ q: searchDraft.trim() || null })
            }}
            className="mt-2 flex items-center gap-3"
          >
            <input
              type="text"
              value={searchDraft}
              onChange={(e) => {
                setSearchDraft(e.target.value)
                // Clearing the box should restore the full list without also
                // having to press Search.
                if (!e.target.value.trim()) updateParams({ q: null })
              }}
              placeholder="10.0.0.0/8, 10.0.13.1, AS65001 or a MAC"
              className="flex-1 px-3 py-2 border border-hair-strong rounded-lg focus:ring-2 focus:ring-accent focus:border-accent text-sm"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-accent text-accent-fg rounded-lg hover:bg-accent-hover text-sm"
            >
              Search
            </button>
          </form>
          <div className="mt-2 flex items-center gap-4">
            {/* Radios rather than a checkbox: these are three different
                questions about the block typed, not one question with a
                modifier on it. */}
            <div role="radiogroup" aria-label="Match" className="flex items-center gap-2">
              <span className="text-sm text-muted">Match</span>
              {/* The focus ring goes round the whole control rather than the
                  segment: the segments are clipped to the rounded corners, so
                  an outline on one of them would be cut off, and arrow keys
                  move between them anyway. */}
              <div className="flex rounded-lg border border-hair-strong overflow-hidden has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
                {MATCH_MODES.map(mode => (
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
                    <span className="block px-3 py-1 text-sm text-muted hover:bg-surface-sunken peer-checked:bg-accent peer-checked:text-accent-fg">
                      {mode.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {search?.kind === 'asn' && (
              <span className="text-xs text-dim">Prefixes with AS{search.asn} in their AS_PATH</span>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div ref={split.containerRef} className="flex-1 flex flex-col lg:flex-row min-h-0 p-4 gap-4 lg:gap-0">
        {/* Prefix Statistics */}
        {showList && (
        <div
          className="w-full flex-1 lg:flex-none bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-0"
          style={isCompact ? undefined : { width: `calc(${split.percent}% - 0.5rem)` }}
        >
          <div className="px-4 py-3 border-b border-hair flex items-center gap-2 shrink-0">
            <span>📊</span>
            <h2 className="font-semibold text-strong">Prefix Statistics</h2>
            {peerFilter.length > 0 && (
              <button
                onClick={() => updateParams({ peer: null })}
                title="Show routes from every peer"
                className="text-xs bg-accent-subtle text-accent rounded px-2 py-0.5 hover:opacity-75"
              >
                from {peerFilter.join(', ')} ✕
              </button>
            )}
            <span className="text-xs text-muted ml-auto">{filteredPrefixes.length} prefixes</span>
          </div>
          <div ref={rows.containerRef} onScroll={rows.onScroll} className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead ref={rows.measureHeaderRef} className="bg-surface-sunken sticky top-0">
                <tr className="text-left text-muted">
                  <SortableHeader column="prefix" {...{ sortColumn, sortDirection, toggleSort }}>
                    Prefix
                  </SortableHeader>
                  <SortableHeader column="announced" align="right" {...{ sortColumn, sortDirection, toggleSort }}>
                    Announced
                  </SortableHeader>
                  <SortableHeader column="withdrawn" align="right" {...{ sortColumn, sortDirection, toggleSort }}>
                    Withdrawn
                  </SortableHeader>
                  <SortableHeader column="lastSeen" align="right" {...{ sortColumn, sortDirection, toggleSort }}>
                    Last Seen
                  </SortableHeader>
                  <SortableHeader column="flap" align="right" {...{ sortColumn, sortDirection, toggleSort }}>
                    Flap
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
                    <td className="px-4 py-2 font-mono text-strong">{stat.key}</td>
                    <td className="px-4 py-2 text-right text-ok">{stat.announced}</td>
                    <td className="px-4 py-2 text-right text-critical">{stat.withdrawn}</td>
                    <td className="px-4 py-2 text-right font-mono text-muted">
                      {formatTimeOfDayUtc(stat.lastSeen)}
                    </td>
                    <td className="px-4 py-2 text-right">
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
                No prefixes found
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
            label="Resize the prefix list"
          />
        )}

        {/* Route History and the paths it arrived over */}
        {showDetail && (
        <div className="w-full flex-1 flex flex-col min-h-0 gap-4 lg:ml-2">
        <div className="bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-0 flex-1">
          <div className="px-4 py-3 border-b border-hair flex items-center gap-2 shrink-0">
            <BackToList onClick={() => setSelectedPrefix(null)} />
            <span>📜</span>
            <h2 className="font-semibold text-strong truncate">
              Route History{selectedPrefix ? `: ${selectedPrefix}` : ''}
            </h2>
          </div>
          <div className="flex-1 overflow-auto">
            {selectedPrefixStats ? (
              <table className="w-full text-sm">
                <thead className="bg-surface-sunken sticky top-0">
                  <tr className="text-left text-muted">
                    <th className="px-4 py-2 font-medium">Time</th>
                    <th className="px-4 py-2 font-medium" title="Time since the previous event">Δ</th>
                    <th className="px-4 py-2 font-medium">Action</th>
                    <th className="px-4 py-2 font-medium">AS_PATH</th>
                    {showRdColumn && (
                      <th
                        className="px-4 py-2 font-medium"
                        title="Route Distinguisher — which leaf advertised this route"
                      >
                        RD
                      </th>
                    )}
                    <th className="px-4 py-2 font-medium" title="The peer this event arrived from">From</th>
                    <th className="px-4 py-2 font-medium">Next Hop</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hair">
                  {/* Newest first, so the gap shown on a row is the one back to
                      the event before it in time — the wait that produced it. */}
                  {selectedPrefixStats.history.slice().reverse().map((event, idx, rows) => (
                    <tr
                      key={idx}
                      onClick={() => handleHistoryClick(event)}
                      className="cursor-pointer hover:bg-surface-sunken"
                    >
                      <td className="px-4 py-2 font-mono text-muted">
                        {formatTimeOfDayUtc(event.timestamp)}
                      </td>
                      <td className="px-4 py-2 font-mono text-dim whitespace-nowrap">
                        {idx < rows.length - 1
                          ? formatDelta(event.timestamp.getTime() - rows[idx + 1].timestamp.getTime())
                          : '-'}
                      </td>
                      <td className="px-4 py-2">
                        {event.action === 'announce' ? (
                          <span className="text-ok">🟢 Announce</span>
                        ) : (
                          <span className="text-critical">🔴 Withdraw</span>
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-muted">
                        {event.asPath ? formatAsPath(event.asPath) : '-'}
                      </td>
                      {showRdColumn && (
                        <td className="px-4 py-2 font-mono text-muted">{event.rd ?? '-'}</td>
                      )}
                      <td className="px-4 py-2 font-mono text-muted">{event.source}</td>
                      <td className="px-4 py-2 font-mono text-muted">
                        {event.nextHop || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-center text-dim py-8">
                Select a prefix to view history
              </div>
            )}
          </div>
        </div>

        {asPathVariants.length > 0 && (
          <div className="bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-0 shrink-0 max-h-64">
            <div className="px-4 py-3 border-b border-hair flex items-center gap-2 shrink-0">
              <span>🔗</span>
              <h2 className="font-semibold text-strong">AS_PATH Analysis</h2>
              <span className="text-xs text-muted ml-auto">
                {asPathVariants.length === 1
                  ? 'single path'
                  : `${asPathVariants.length} distinct paths`}
              </span>
            </div>
            <div className="flex-1 overflow-auto p-3 space-y-2">
              {asPathVariants.map((variant, idx) => (
                <div
                  key={variant.path.join(' ')}
                  className="flex items-center gap-2 flex-wrap text-sm"
                >
                  <div className="flex items-center gap-1 flex-wrap">
                    {collapsePrepends(variant.path).map((hop, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span className="text-dim">▶</span>}
                        <span className="font-mono rounded bg-surface-sunken px-1.5 py-0.5 text-body">
                          AS{hop.asn}
                          {hop.repeat > 1 && (
                            <span className="text-muted" title={`prepended ${hop.repeat} times`}>
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
                    {idx === 0 ? '' : 'alternate, '}
                    seen {variant.count} time{variant.count > 1 ? 's' : ''}
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
  children: React.ReactNode
}

function SortableHeader({
  column,
  sortColumn,
  sortDirection,
  toggleSort,
  align = 'left',
  children,
}: SortableHeaderProps) {
  const active = column === sortColumn

  return (
    <th className={`px-4 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => toggleSort(column)}
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
