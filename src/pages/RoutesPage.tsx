import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
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

export function RoutesPage() {
  const { packets } = useApp()
  const navigate = useNavigate()
  // The box holds a draft until Search (or Enter) commits it, so the button does
  // what it says. Emptying the box clears the filter without a round trip.
  const [searchDraft, setSearchDraft] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [includeSubnets, setIncludeSubnets] = useState(true)
  const [selectedPrefix, setSelectedPrefix] = useState<string | null>(null)

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

    return Array.from(stats.values()).sort((a, b) => b.flap - a.flap)
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

  // Get selected prefix stats
  const selectedPrefixStats = selectedPrefix
    ? prefixStats.find(s => s.key === selectedPrefix)
    : null

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
        <div className="w-full basis-1/2 lg:w-1/2 lg:basis-auto bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-hair flex items-center gap-2 shrink-0">
            <span>📊</span>
            <h2 className="font-semibold text-strong">Prefix Statistics</h2>
            <span className="text-xs text-muted ml-auto">{filteredPrefixes.length} prefixes</span>
          </div>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken sticky top-0">
                <tr className="text-left text-muted">
                  <th className="px-4 py-2 font-medium">Prefix</th>
                  <th className="px-4 py-2 font-medium text-right">Announced</th>
                  <th className="px-4 py-2 font-medium text-right">Withdrawn</th>
                  <th className="px-4 py-2 font-medium text-right">Flap</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hair">
                {filteredPrefixes.map((stat) => (
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
            {filteredPrefixes.length === 0 && (
              <div className="text-center text-dim py-8">
                No prefixes found
              </div>
            )}
          </div>
        </div>

        {/* Route History */}
        <div className="w-full basis-1/2 lg:w-1/2 lg:basis-auto bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-hair flex items-center gap-2 shrink-0">
            <span>📜</span>
            <h2 className="font-semibold text-strong">
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
      </div>
    </div>
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
