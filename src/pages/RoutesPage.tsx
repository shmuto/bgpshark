import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useIsCompact } from '../hooks/useMediaQuery'
import { BackToList } from '../components/common'
import type { BgpPrefix, BgpUpdateMessage } from '../lib/bgp/types'
import {
  contains,
  equals,
  formatPrefix,
  parseBgpPrefix,
  parsePrefix,
  type ParsedPrefix,
} from '../lib/net/prefix'

interface PrefixStats {
  /**
   * `prefix/length`. The address alone is not an identity: 10.0.12.0/24 and
   * 10.0.12.0/23 are different routes and must not share a row.
   */
  key: string
  parsed: ParsedPrefix | null
  /** Every AS seen in an AS_PATH announcing this prefix, for AS number searches. */
  asns: Set<string>
  announced: number
  withdrawn: number
  lastSeen: Date
  flap: number
  history: PrefixEvent[]
}

interface PrefixEvent {
  timestamp: Date
  action: 'announce' | 'withdraw'
  asPath?: string
  nextHop?: string
  packetIndex: number
}

/** What the text in the search box turned out to be. */
type Search =
  | { kind: 'prefix'; prefix: ParsedPrefix }
  | { kind: 'asn'; asn: string }
  | { kind: 'text'; text: string }

type SortColumn = 'prefix' | 'announced' | 'withdrawn' | 'lastSeen' | 'flap'
type SortDirection = 'asc' | 'desc'

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

export function RoutesPage() {
  const { packets } = useApp()
  const navigate = useNavigate()
  // The box holds a draft until Search (or Enter) commits it, so the button does
  // what it says. Emptying the box clears the filter without a round trip.
  const [searchDraft, setSearchDraft] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [includeSubnets, setIncludeSubnets] = useState(true)
  const [selectedPrefix, setSelectedPrefix] = useState<string | null>(null)
  const [sortColumn, setSortColumn] = useState<SortColumn>('flap')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  // Too narrow for two columns: show the list, or the detail, but not halves of
  // both.
  const isCompact = useIsCompact()
  const showList = !isCompact || selectedPrefix === null
  const showDetail = !isCompact || selectedPrefix !== null

  // Extract all prefix events from packets
  const prefixStats = useMemo(() => {
    const stats = new Map<string, PrefixStats>()

    /**
     * Records one announce or withdraw against `prefix/length`. Every caller
     * goes through here so the four NLRI sources cannot drift apart on how a
     * route is keyed.
     */
    const record = (
      prefix: BgpPrefix,
      action: 'announce' | 'withdraw',
      timestamp: Date,
      packetIndex: number,
      detail: { asPath?: string; nextHop?: string; asns?: string[] } = {}
    ) => {
      const key = formatPrefix(prefix)
      let stat = stats.get(key)
      if (!stat) {
        stat = {
          key,
          parsed: parseBgpPrefix(prefix),
          asns: new Set(),
          announced: 0,
          withdrawn: 0,
          lastSeen: timestamp,
          flap: 0,
          history: [],
        }
        stats.set(key, stat)
      }

      if (action === 'announce') {
        stat.announced++
      } else {
        stat.withdrawn++
      }
      stat.flap++
      stat.lastSeen = timestamp
      for (const asn of detail.asns ?? []) {
        stat.asns.add(asn)
      }
      stat.history.push({
        timestamp,
        action,
        asPath: detail.asPath,
        nextHop: detail.nextHop,
        packetIndex,
      })
    }

    packets.forEach((packet, packetIndex) => {
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const update = msg as BgpUpdateMessage

        // Get AS_PATH and NEXT_HOP from path attributes
        let asNumbers: string[] = []
        let asPath = ''
        let nextHop = ''
        for (const attr of update.pathAttributes || []) {
          if (attr.parsed?.type === 'AS_PATH') {
            asNumbers = attr.parsed.segments.flatMap(s => s.asNumbers).map(String)
            asPath = asNumbers.join(' ')
          }
          if (attr.parsed?.type === 'NEXT_HOP') {
            nextHop = attr.parsed.address
          }
        }

        // Process NLRI (announced prefixes)
        for (const nlri of update.nlri || []) {
          record(nlri, 'announce', packet.timestamp, packetIndex, { asPath, nextHop, asns: asNumbers })
        }

        // Process withdrawn routes
        for (const wr of update.withdrawnRoutes || []) {
          record(wr, 'withdraw', packet.timestamp, packetIndex)
        }

        // Process MP_REACH_NLRI / MP_UNREACH_NLRI (IPv6 and other families)
        for (const attr of update.pathAttributes || []) {
          if (attr.parsed?.type === 'MP_REACH_NLRI') {
            for (const nlri of attr.parsed.nlri || []) {
              record(nlri, 'announce', packet.timestamp, packetIndex, {
                asPath,
                nextHop: attr.parsed.nextHop,
                asns: asNumbers,
              })
            }
          }
          if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
            for (const nlri of attr.parsed.withdrawnRoutes || []) {
              record(nlri, 'withdraw', packet.timestamp, packetIndex)
            }
          }
        }
      }
    })

    // Sort history by timestamp
    for (const stat of stats.values()) {
      stat.history.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    }

    return Array.from(stats.values())
  }, [packets])

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
  const filteredPrefixes = useMemo(() => {
    if (!search) return prefixStats

    switch (search.kind) {
      case 'asn':
        return prefixStats.filter(stat => stat.asns.has(search.asn))

      case 'prefix':
        return prefixStats.filter(stat => {
          if (!stat.parsed) return false
          if (!includeSubnets) return equals(search.prefix, stat.parsed)
          // A query carrying a mask asks for everything inside it; a bare address
          // asks which announcements cover that address.
          return search.prefix.hasMask
            ? contains(search.prefix, stat.parsed)
            : contains(stat.parsed, search.prefix)
        })

      case 'text':
        return prefixStats.filter(stat => stat.key.toLowerCase().includes(search.text))
    }
  }, [prefixStats, search, includeSubnets])

  const sortedPrefixes = useMemo(() => {
    const factor = sortDirection === 'asc' ? 1 : -1
    return [...filteredPrefixes].sort((a, b) => {
      switch (sortColumn) {
        case 'prefix':
          // Numeric order, so 10.0.9.0/24 comes before 10.0.12.0/24 rather than
          // after it the way a string comparison would have it. Prefixes with no
          // parsed form keep a stable place at the end.
          if (!a.parsed || !b.parsed) return a.key.localeCompare(b.key) * factor
          if (a.parsed.family !== b.parsed.family) return (a.parsed.family - b.parsed.family) * factor
          if (a.parsed.bits !== b.parsed.bits) return (a.parsed.bits < b.parsed.bits ? -1 : 1) * factor
          return (a.parsed.length - b.parsed.length) * factor
        case 'lastSeen':
          return (a.lastSeen.getTime() - b.lastSeen.getTime()) * factor
        default:
          return (a[sortColumn] - b[sortColumn]) * factor
      }
    })
  }, [filteredPrefixes, sortColumn, sortDirection])

  const toggleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(column)
      setSortDirection(DEFAULT_DIRECTION[column])
    }
  }

  // Get selected prefix stats
  const selectedPrefixStats = selectedPrefix
    ? prefixStats.find(s => s.key === selectedPrefix)
    : null

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
              setSearchQuery(searchDraft)
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
                if (!e.target.value.trim()) setSearchQuery('')
              }}
              placeholder="10.0.0.0/8, 10.0.13.1 or AS65001"
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
            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={includeSubnets}
                onChange={(e) => setIncludeSubnets(e.target.checked)}
                className="rounded border-hair-strong"
              />
              Include subnets
            </label>
            {search?.kind === 'asn' && (
              <span className="text-xs text-dim">Prefixes with AS{search.asn} in their AS_PATH</span>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 p-4 gap-4">
        {/* Prefix Statistics */}
        {showList && (
        <div className="w-full flex-1 lg:w-1/2 lg:flex-none bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-hair flex items-center gap-2 shrink-0">
            <span>📊</span>
            <h2 className="font-semibold text-strong">Prefix Statistics</h2>
            <span className="text-xs text-muted ml-auto">{filteredPrefixes.length} prefixes</span>
          </div>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken sticky top-0">
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
                {sortedPrefixes.map((stat) => (
                  <tr
                    key={stat.key}
                    onClick={() => setSelectedPrefix(stat.key)}
                    className={`cursor-pointer hover:bg-surface-sunken ${
                      selectedPrefix === stat.key ? 'bg-accent-subtle' : ''
                    }`}
                  >
                    <td className="px-4 py-2 font-mono text-strong">{stat.key}</td>
                    <td className="px-4 py-2 text-right text-ok">{stat.announced}</td>
                    <td className="px-4 py-2 text-right text-critical">{stat.withdrawn}</td>
                    <td className="px-4 py-2 text-right font-mono text-muted">
                      {formatTime(stat.lastSeen)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className={stat.flap > 10 ? 'text-warning font-medium' : 'text-muted'}>
                        {stat.flap}
                        {stat.flap > 10 && ' ⚠'}
                      </span>
                    </td>
                  </tr>
                ))}
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

        {/* Route History and the paths it arrived over */}
        {showDetail && (
        <div className="w-full flex-1 lg:w-1/2 lg:flex-none flex flex-col min-h-0 gap-4">
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
                    <th className="px-4 py-2 font-medium">Action</th>
                    <th className="px-4 py-2 font-medium">AS_PATH</th>
                    <th className="px-4 py-2 font-medium">Next Hop</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hair">
                  {selectedPrefixStats.history.slice().reverse().map((event, idx) => (
                    <tr
                      key={idx}
                      onClick={() => handleHistoryClick(event)}
                      className="cursor-pointer hover:bg-surface-sunken"
                    >
                      <td className="px-4 py-2 font-mono text-muted">
                        {formatTime(event.timestamp)}
                      </td>
                      <td className="px-4 py-2">
                        {event.action === 'announce' ? (
                          <span className="text-ok">🟢 Announce</span>
                        ) : (
                          <span className="text-critical">🔴 Withdraw</span>
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-muted">
                        {event.asPath || '-'}
                      </td>
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
                    {variant.path.map((asn, hop) => (
                      <span key={hop} className="flex items-center gap-1">
                        {hop > 0 && <span className="text-dim">▶</span>}
                        <span className="font-mono rounded bg-surface-sunken px-1.5 py-0.5 text-body">
                          AS{asn}
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

function formatTime(date: Date): string {
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const ms = String(date.getMilliseconds()).padStart(3, '0').slice(0, 2)
  return `${time}.${ms}`
}
