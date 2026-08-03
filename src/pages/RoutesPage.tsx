import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import type { BgpUpdateMessage } from '../lib/bgp/types'

interface PrefixStats {
  prefix: string
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

export function RoutesPage() {
  const { packets } = useApp()
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState('')
  const [includeSubnets, setIncludeSubnets] = useState(true)
  const [selectedPrefix, setSelectedPrefix] = useState<string | null>(null)

  // Extract all prefix events from packets
  const prefixStats = useMemo(() => {
    const stats = new Map<string, PrefixStats>()

    packets.forEach((packet, packetIndex) => {
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const update = msg as BgpUpdateMessage

        // Get AS_PATH and NEXT_HOP from path attributes
        let asPath = ''
        let nextHop = ''
        for (const attr of update.pathAttributes || []) {
          if (attr.parsed?.type === 'AS_PATH') {
            asPath = attr.parsed.segments.flatMap(s => s.asNumbers).join(' ')
          }
          if (attr.parsed?.type === 'NEXT_HOP') {
            nextHop = attr.parsed.address
          }
        }

        // Process NLRI (announced prefixes)
        for (const nlri of update.nlri || []) {
          const prefix = nlri.prefix
          if (!stats.has(prefix)) {
            stats.set(prefix, {
              prefix,
              announced: 0,
              withdrawn: 0,
              lastSeen: packet.timestamp,
              flap: 0,
              history: [],
            })
          }
          const stat = stats.get(prefix)!
          stat.announced++
          stat.flap++
          stat.lastSeen = packet.timestamp
          stat.history.push({
            timestamp: packet.timestamp,
            action: 'announce',
            asPath,
            nextHop,
            packetIndex,
          })
        }

        // Process withdrawn routes
        for (const wr of update.withdrawnRoutes || []) {
          const prefix = wr.prefix
          if (!stats.has(prefix)) {
            stats.set(prefix, {
              prefix,
              announced: 0,
              withdrawn: 0,
              lastSeen: packet.timestamp,
              flap: 0,
              history: [],
            })
          }
          const stat = stats.get(prefix)!
          stat.withdrawn++
          stat.flap++
          stat.lastSeen = packet.timestamp
          stat.history.push({
            timestamp: packet.timestamp,
            action: 'withdraw',
            packetIndex,
          })
        }

        // Process MP_REACH_NLRI (IPv6 announcements)
        for (const attr of update.pathAttributes || []) {
          if (attr.parsed?.type === 'MP_REACH_NLRI') {
            for (const nlri of attr.parsed.nlri || []) {
              const prefix = nlri.prefix
              if (!stats.has(prefix)) {
                stats.set(prefix, {
                  prefix,
                  announced: 0,
                  withdrawn: 0,
                  lastSeen: packet.timestamp,
                  flap: 0,
                  history: [],
                })
              }
              const stat = stats.get(prefix)!
              stat.announced++
              stat.flap++
              stat.lastSeen = packet.timestamp
              stat.history.push({
                timestamp: packet.timestamp,
                action: 'announce',
                asPath,
                nextHop: attr.parsed.nextHop,
                packetIndex,
              })
            }
          }
          if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
            for (const nlri of attr.parsed.withdrawnRoutes || []) {
              const prefix = nlri.prefix
              if (!stats.has(prefix)) {
                stats.set(prefix, {
                  prefix,
                  announced: 0,
                  withdrawn: 0,
                  lastSeen: packet.timestamp,
                  flap: 0,
                  history: [],
                })
              }
              const stat = stats.get(prefix)!
              stat.withdrawn++
              stat.flap++
              stat.lastSeen = packet.timestamp
              stat.history.push({
                timestamp: packet.timestamp,
                action: 'withdraw',
                packetIndex,
              })
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

  // Filter prefixes
  const filteredPrefixes = useMemo(() => {
    if (!searchQuery.trim()) return prefixStats

    const query = searchQuery.toLowerCase().trim()
    return prefixStats.filter(stat => {
      if (stat.prefix.toLowerCase().includes(query)) return true
      // TODO: Add subnet matching logic
      return false
    })
  }, [prefixStats, searchQuery])

  // Get selected prefix stats
  const selectedPrefixStats = selectedPrefix
    ? prefixStats.find(s => s.prefix === selectedPrefix)
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
          <div className="mt-2 flex items-center gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="10.0.0.0/8 or AS65001"
              className="flex-1 px-3 py-2 border border-hair-strong rounded-lg focus:ring-2 focus:ring-accent focus:border-accent text-sm"
            />
            <button className="px-4 py-2 bg-accent text-accent-fg rounded-lg hover:bg-accent-hover text-sm">
              Search
            </button>
          </div>
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
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0 p-4 gap-4">
        {/* Prefix Statistics */}
        <div className="w-1/2 bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-0">
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
                    key={stat.prefix}
                    onClick={() => setSelectedPrefix(stat.prefix)}
                    className={`cursor-pointer hover:bg-surface-sunken ${
                      selectedPrefix === stat.prefix ? 'bg-accent-subtle' : ''
                    }`}
                  >
                    <td className="px-4 py-2 font-mono text-strong">{stat.prefix}</td>
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
        <div className="w-1/2 bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-0">
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
