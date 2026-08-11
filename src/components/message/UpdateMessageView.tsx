import { useState } from 'react'
import type {
  BgpUpdateMessage,
  BgpPathAttribute,
  BgpPrefix,
  AsPathSegment,
  MpReachNlriAttribute,
  MpUnreachNlriAttribute,
} from '../../lib/bgp/types'
import { endOfRibMarker } from '../../lib/bgp/update'
import { formatPrefix } from '../../lib/net/prefix'
import type { EvpnRoute } from '../../lib/bgp/evpn'

interface UpdateMessageViewProps {
  message: BgpUpdateMessage
}

export function UpdateMessageView({ message }: UpdateMessageViewProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const endOfRib = endOfRibMarker(message)

  // Collect all NLRI (IPv4 + MP_REACH_NLRI)
  const allNlri: BgpPrefix[] = [...message.nlri]
  const mpReachAttr = message.pathAttributes.find((a) => a.parsed?.type === 'MP_REACH_NLRI')
  if (mpReachAttr?.parsed?.type === 'MP_REACH_NLRI') {
    allNlri.push(...(mpReachAttr.parsed as MpReachNlriAttribute).nlri)
  }

  // Collect all withdrawn (IPv4 + MP_UNREACH_NLRI)
  const allWithdrawn: BgpPrefix[] = [...message.withdrawnRoutes]
  const mpUnreachAttr = message.pathAttributes.find((a) => a.parsed?.type === 'MP_UNREACH_NLRI')
  if (mpUnreachAttr?.parsed?.type === 'MP_UNREACH_NLRI') {
    allWithdrawn.push(...(mpUnreachAttr.parsed as MpUnreachNlriAttribute).withdrawnRoutes)
  }

  // EVPN routes get their own table below; the prefix lists keep the entries
  // that really are prefixes, so neither view shows the other's rows.
  const evpnAnnounced = allNlri.flatMap((p) => (p.evpn ? [p.evpn] : []))
  const evpnWithdrawn = allWithdrawn.flatMap((p) => (p.evpn ? [p.evpn] : []))
  const plainNlri = allNlri.filter((p) => !p.evpn)
  const plainWithdrawn = allWithdrawn.filter((p) => !p.evpn)

  // Extract key attributes for compact view
  const asPathAttr = message.pathAttributes.find((a) => a.parsed?.type === 'AS_PATH')
  const nextHopAttr = message.pathAttributes.find((a) => a.parsed?.type === 'NEXT_HOP')
  const mpReachNextHop = mpReachAttr?.parsed?.type === 'MP_REACH_NLRI' ? (mpReachAttr.parsed as MpReachNlriAttribute).nextHop : null

  const asPath = asPathAttr?.parsed?.type === 'AS_PATH' ? asPathAttr.parsed.segments : []
  const nextHop = nextHopAttr?.parsed?.type === 'NEXT_HOP' ? nextHopAttr.parsed.address : mpReachNextHop

  return (
    <div className="space-y-2">
      {/* Compact View - Always visible */}
      <div
        className="bg-surface-sunken rounded-lg border border-hair cursor-pointer hover:bg-surface-raised transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* An UPDATE that announces and withdraws nothing is the End-of-RIB
            marker (RFC 4724) — the landmark of a finished initial
            advertisement. Without the label it reads as a puzzling no-op. */}
        {endOfRib && (
          <div className="px-3 py-2 border-b border-hair flex items-center gap-2">
            <span className="text-xs font-medium bg-accent-subtle text-accent px-1.5 py-0.5 rounded">
              End-of-RIB
            </span>
            <span className="text-xs text-muted">
              {endOfRib} — initial routing table advertisement is complete (RFC 4724)
            </span>
          </div>
        )}

        {/* Summary Table */}
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-hair">
              <td className="px-3 py-2 text-muted w-24">Announced</td>
              <td className="px-3 py-2">
                {allNlri.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {allNlri.slice(0, 8).map((prefix, i) => (
                      <span key={i} className="font-mono text-xs bg-ok-subtle text-ok px-1.5 py-0.5 rounded">
                        {formatPrefix(prefix)}
                      </span>
                    ))}
                    {allNlri.length > 8 && (
                      <span className="text-xs text-muted px-1.5 py-0.5">... {allNlri.length - 8} more</span>
                    )}
                  </div>
                ) : (
                  <span className="text-dim">-</span>
                )}
              </td>
              <td className="px-3 py-2 text-right text-muted w-16">{allNlri.length}</td>
            </tr>
            <tr className="border-b border-hair">
              <td className="px-3 py-2 text-muted">Withdrawn</td>
              <td className="px-3 py-2">
                {allWithdrawn.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {allWithdrawn.slice(0, 5).map((prefix, i) => (
                      <span key={i} className="font-mono text-xs bg-critical-subtle text-critical px-1.5 py-0.5 rounded line-through">
                        {formatPrefix(prefix)}
                      </span>
                    ))}
                    {allWithdrawn.length > 5 && (
                      <span className="text-xs text-muted px-1.5 py-0.5">... {allWithdrawn.length - 5} more</span>
                    )}
                  </div>
                ) : (
                  <span className="text-dim">-</span>
                )}
              </td>
              <td className="px-3 py-2 text-right text-muted w-16">{allWithdrawn.length}</td>
            </tr>
            {nextHop && (
              <tr className="border-b border-hair">
                <td className="px-3 py-2 text-muted">Next Hop</td>
                <td className="px-3 py-2 font-mono" colSpan={2}>{nextHop}</td>
              </tr>
            )}
            {asPath.length > 0 && (
              <tr>
                <td className="px-3 py-2 text-muted">AS Path</td>
                <td className="px-3 py-2" colSpan={2}>
                  <AsPathCompact segments={asPath} />
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Expand indicator */}
        <div className="px-3 py-1 text-xs text-dim flex items-center gap-1 border-t border-hair">
          <svg
            className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          {isExpanded ? 'Click to collapse' : 'Click for details'}
        </div>
      </div>

      {/* Expanded View - Full details */}
      {isExpanded && (
        <div className="ml-4 space-y-3 border-l-2 border-hair pl-4">
          {/* All NLRI */}
          {plainNlri.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-dim uppercase tracking-wide mb-2">
                NLRI ({plainNlri.length} prefixes)
              </h4>
              <PrefixList prefixes={plainNlri} className="bg-ok-subtle border-ok/30" />
            </div>
          )}

          {/* EVPN carries route types, not prefixes; a chip cannot hold the
              RD, VNI and MAC that a fabric is actually diagnosed from. */}
          {evpnAnnounced.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-dim uppercase tracking-wide mb-2">
                EVPN Routes ({evpnAnnounced.length} announced)
              </h4>
              <EvpnRouteTable routes={evpnAnnounced} tone="announced" />
            </div>
          )}

          {evpnWithdrawn.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-dim uppercase tracking-wide mb-2">
                EVPN Routes ({evpnWithdrawn.length} withdrawn)
              </h4>
              <EvpnRouteTable routes={evpnWithdrawn} tone="withdrawn" />
            </div>
          )}

          {/* All Withdrawn Routes */}
          {plainWithdrawn.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-dim uppercase tracking-wide mb-2">
                Withdrawn Routes ({plainWithdrawn.length} prefixes)
              </h4>
              <PrefixList prefixes={plainWithdrawn} className="bg-critical-subtle border-critical/30" />
            </div>
          )}

          {/* Path Attributes */}
          {message.pathAttributes.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-dim uppercase tracking-wide mb-2">
                Path Attributes
              </h4>
              <div className="space-y-2">
                {message.pathAttributes.map((attr, i) => (
                  <PathAttributeView key={i} attribute={attr} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AsPathCompact({ segments }: { segments: AsPathSegment[] }) {
  if (segments.length === 0) return null

  // Show first 3 AS numbers
  const allAsns = segments.flatMap((s) => s.asNumbers)
  const displayAsns = allAsns.slice(0, 3)
  const remaining = allAsns.length - displayAsns.length

  return (
    <span className="font-mono">
      {displayAsns.join(' ')}
      {remaining > 0 && <span className="text-dim"> +{remaining}</span>}
    </span>
  )
}

function PrefixList({ prefixes, className }: { prefixes: BgpPrefix[]; className: string }) {
  return (
    <div className={`rounded-lg border p-3 ${className}`}>
      <div className="flex flex-wrap gap-1">
        {prefixes.map((prefix, i) => (
          <span key={i} className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-hair">
            {formatPrefix(prefix)}
          </span>
        ))}
      </div>
    </div>
  )
}

function PathAttributeView({ attribute }: { attribute: BgpPathAttribute }) {
  const { parsed } = attribute

  return (
    <div className="bg-surface-sunken rounded-lg border border-hair p-3 text-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-strong">{attribute.typeName}</span>
        <div className="flex gap-1">
          {attribute.flags.optional && (
            <span className="text-xs bg-surface-raised text-body px-1 rounded">Optional</span>
          )}
          {attribute.flags.transitive && (
            <span className="text-xs bg-surface-raised text-body px-1 rounded">Transitive</span>
          )}
          {attribute.flags.partial && (
            <span className="text-xs bg-warning-subtle text-warning px-1 rounded">Partial</span>
          )}
        </div>
      </div>

      <div className="text-muted">
        {parsed ? (
          <ParsedAttributeValue parsed={parsed} />
        ) : (
          <span className="font-mono text-xs">{attribute.length} bytes</span>
        )}
      </div>
    </div>
  )
}

function ParsedAttributeValue({ parsed }: { parsed: NonNullable<BgpPathAttribute['parsed']> }) {
  switch (parsed.type) {
    case 'ORIGIN':
      return (
        <span
          className={`inline-block px-2 py-0.5 rounded text-xs ${
            parsed.value === 'IGP'
              ? 'bg-ok-subtle text-ok'
              : parsed.value === 'EGP'
                ? 'bg-warning-subtle text-warning'
                : 'bg-surface-sunken text-muted'
          }`}
        >
          {parsed.value}
        </span>
      )

    case 'AS_PATH':
      return <AsPathView segments={parsed.segments} />

    case 'NEXT_HOP':
      return <span className="font-mono">{parsed.address}</span>

    case 'MULTI_EXIT_DISC':
      return <span className="font-mono">MED: {parsed.value}</span>

    case 'LOCAL_PREF':
      return <span className="font-mono">Local Preference: {parsed.value}</span>

    case 'ATOMIC_AGGREGATE':
      return <span className="text-muted">Present</span>

    case 'AGGREGATOR':
      return (
        <span className="font-mono">
          AS{parsed.asNumber} via {parsed.address}
        </span>
      )

    case 'COMMUNITIES':
      return (
        <div className="flex flex-wrap gap-1 mt-1">
          {parsed.communities.map((comm, i) => (
            <span key={i} className="font-mono text-xs bg-bgp-keepalive/15 text-bgp-keepalive px-1.5 py-0.5 rounded">
              {comm}
            </span>
          ))}
        </div>
      )

    case 'EXTENDED_COMMUNITIES':
      return (
        <div className="flex flex-wrap gap-1 mt-1">
          {parsed.communities.map((comm, i) => (
            <span
              key={i}
              // A Route Target is the field an EVPN import decision turns on,
              // so it is the one worth spotting without reading the others.
              className={`font-mono text-xs px-1.5 py-0.5 rounded ${
                comm.kind === 'Route Target'
                  ? 'bg-accent-subtle text-accent'
                  : comm.unknown
                    ? 'bg-surface-sunken text-muted'
                    : 'bg-bgp-keepalive/15 text-bgp-keepalive'
              }`}
              title={comm.transitive ? undefined : 'Non-transitive: does not leave this AS'}
            >
              {comm.kind} {comm.value}
              {!comm.transitive && <span className="text-dim"> (non-transitive)</span>}
            </span>
          ))}
        </div>
      )

    case 'LARGE_COMMUNITIES':
      return (
        <div className="flex flex-wrap gap-1 mt-1">
          {parsed.communities.map((comm, i) => (
            <span key={i} className="font-mono text-xs bg-bgp-keepalive/15 text-bgp-keepalive px-1.5 py-0.5 rounded">
              {comm.globalAdmin}:{comm.localData1}:{comm.localData2}
            </span>
          ))}
        </div>
      )

    case 'MP_REACH_NLRI':
      return (
        <div className="space-y-1">
          <div className="text-xs text-muted">
            {parsed.afiName} / {parsed.safiName}
          </div>
          <div className="font-mono">Next Hop: {parsed.nextHop}</div>
          {parsed.nlri.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {parsed.nlri.map((prefix, i) => (
                <span key={i} className="font-mono text-xs bg-ok-subtle text-ok px-1.5 py-0.5 rounded">
                  {formatPrefix(prefix)}
                </span>
              ))}
            </div>
          )}
        </div>
      )

    case 'MP_UNREACH_NLRI':
      return (
        <div className="space-y-1">
          <div className="text-xs text-muted">
            {parsed.afiName} / {parsed.safiName}
          </div>
          {parsed.withdrawnRoutes.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {parsed.withdrawnRoutes.map((prefix, i) => (
                <span key={i} className="font-mono text-xs bg-critical-subtle text-critical px-1.5 py-0.5 rounded">
                  {formatPrefix(prefix)}
                </span>
              ))}
            </div>
          )}
        </div>
      )

    case 'UNKNOWN':
    default:
      return <span className="text-dim">Unparsed</span>
  }
}

function AsPathView({ segments }: { segments: AsPathSegment[] }) {
  if (segments.length === 0) {
    return <span className="text-dim">Empty</span>
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {segments.map((segment, i) => (
        <span key={i} className="flex items-center gap-1">
          {segment.type === 'AS_SET' && <span className="text-dim">{'{'}</span>}
          {segment.type === 'AS_CONFED_SEQUENCE' && <span className="text-dim">(</span>}
          {segment.type === 'AS_CONFED_SET' && <span className="text-dim">({'{'}</span>}

          {segment.asNumbers.map((asn, j) => (
            <span key={j} className="font-mono text-xs bg-bgp-update/15 text-bgp-update px-1.5 py-0.5 rounded">
              {asn}
            </span>
          ))}

          {segment.type === 'AS_SET' && <span className="text-dim">{'}'}</span>}
          {segment.type === 'AS_CONFED_SEQUENCE' && <span className="text-dim">)</span>}
          {segment.type === 'AS_CONFED_SET' && <span className="text-dim">{'})'}</span>}
        </span>
      ))}
    </div>
  )
}

/**
 * EVPN routes, as a table.
 *
 * A fabric is diagnosed from fields a chip cannot hold: which RD the route
 * belongs to, which VNI it is in, which MAC moved, which VTEP originated it.
 * Columns no route in the set fills are dropped rather than shown empty — a
 * table of multicast routes has no MACs to talk about.
 */
function EvpnRouteTable({ routes, tone }: { routes: EvpnRoute[]; tone: 'announced' | 'withdrawn' }) {
  const has = (pick: (route: EvpnRoute) => unknown) => routes.some((route) => pick(route) !== undefined)
  const showMac = has((r) => r.macAddress)
  // Type 3 and 4 name the router that originated them, which is the VTEP —
  // the same column answers "where is this from" for both shapes of route.
  const showIp = has((r) => r.ipAddress) || has((r) => r.originatingRouterIp)
  const showVni = has((r) => r.label)
  const showEsi = has((r) => r.esi)
  const showTag = has((r) => r.ethernetTag)

  const toneClass = tone === 'announced' ? 'text-ok' : 'text-critical line-through'

  return (
    <div className="rounded-lg border border-hair overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-surface-sunken text-muted">
          <tr className="text-left">
            <th className="px-2 py-1 font-medium">Type</th>
            <th className="px-2 py-1 font-medium">RD</th>
            {showMac && <th className="px-2 py-1 font-medium">MAC</th>}
            {showIp && <th className="px-2 py-1 font-medium">IP / Originating Router</th>}
            {showVni && <th className="px-2 py-1 font-medium">VNI</th>}
            {showEsi && <th className="px-2 py-1 font-medium">ESI</th>}
            {showTag && <th className="px-2 py-1 font-medium">Eth Tag</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-hair">
          {routes.map((route, i) => (
            <tr key={i}>
              <td className={`px-2 py-1 ${toneClass}`}>
                [{route.routeType}] {route.routeTypeName}
                {route.truncated && (
                  <span className="ml-1 text-warning" title="The route body could not be fully read">
                    ⚠ partial
                  </span>
                )}
              </td>
              <td className="px-2 py-1 font-mono text-muted">{route.rd}</td>
              {showMac && <td className="px-2 py-1 font-mono text-body">{route.macAddress ?? '-'}</td>}
              {showIp && (
                <td className="px-2 py-1 font-mono text-body">
                  {route.ipAddress ?? route.originatingRouterIp ?? '-'}
                  {route.ipPrefixLength !== undefined && route.ipAddress ? `/${route.ipPrefixLength}` : ''}
                </td>
              )}
              {showVni && (
                <td className="px-2 py-1 font-mono text-muted">
                  {route.label ?? '-'}
                  {route.label2 !== undefined && (
                    <span className="text-dim" title="Second label, an L3 VNI alongside the L2 one">
                      {' / '}{route.label2}
                    </span>
                  )}
                </td>
              )}
              {showEsi && <td className="px-2 py-1 font-mono text-muted">{route.esi ?? '-'}</td>}
              {showTag && <td className="px-2 py-1 font-mono text-muted">{route.ethernetTag ?? '-'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
