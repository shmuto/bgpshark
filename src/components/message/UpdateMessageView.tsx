import { useState } from 'react'
import { FilterableValue } from './FilterableValue'
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
import { useI18n } from '../../i18n'

interface UpdateMessageViewProps {
  message: BgpUpdateMessage
}

/**
 * How many prefix chips a list shows before folding the rest behind a button.
 * Enough for every UPDATE a lab or an incident usually produces to show whole,
 * few enough that a full-table burst does not push Path Attributes off the pane.
 */
const PREFIX_FOLD = 32

/**
 * One UPDATE, as one card: what it announced, what it withdrew, and the path
 * attributes, each said once.
 *
 * This used to be a summary table (the first few prefixes, Next Hop, AS_PATH)
 * stacked on an expandable copy of the same thing in full, with MP_REACH_NLRI
 * listing its prefixes and next hop a third time inside Path Attributes. A
 * packet carrying four UPDATEs became a long scroll of repeats, which is
 * exactly when the reader is trying to compare them. Prefixes from
 * MP_REACH/MP_UNREACH now join the Announced/Withdrawn rows, and those
 * attributes keep only what is theirs alone — the address family and next hop.
 */
export function UpdateMessageView({ message }: UpdateMessageViewProps) {
  const { t } = useI18n()
  const ut = t.packetDetail.update
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

  // EVPN routes get their own table; the prefix rows keep the entries that
  // really are prefixes, so neither view shows the other's rows.
  const evpnAnnounced = allNlri.flatMap((p) => (p.evpn ? [p.evpn] : []))
  const evpnWithdrawn = allWithdrawn.flatMap((p) => (p.evpn ? [p.evpn] : []))
  const plainNlri = allNlri.filter((p) => !p.evpn)
  const plainWithdrawn = allWithdrawn.filter((p) => !p.evpn)

  // An empty side is only worth a row when the other side is empty too:
  // "Announced: -" next to three withdrawals says nothing the count does not.
  const showAnnounced =
    plainNlri.length > 0 || (allNlri.length === 0 && allWithdrawn.length === 0 && !endOfRib)
  const showWithdrawn = plainWithdrawn.length > 0

  return (
    <div data-testid="update-message" className="bg-surface-sunken rounded border border-hair text-xs divide-y divide-hair">
      {/* An UPDATE that announces and withdraws nothing is the End-of-RIB
          marker (RFC 4724) — the landmark of a finished initial
          advertisement. Without the label it reads as a puzzling no-op. */}
      {endOfRib && (
        <div className="px-3 py-2 flex items-center gap-2">
          <span className="text-xs font-medium bg-accent-subtle text-accent px-1.5 py-0.5 rounded">
            End-of-RIB
          </span>
          <span className="text-xs text-muted">{ut.endOfRibNote(endOfRib)}</span>
        </div>
      )}

      {showAnnounced && (
        <Row label={ut.announced(plainNlri.length)}>
          {plainNlri.length > 0 ? (
            <PrefixChips prefixes={plainNlri} className="bg-ok-subtle text-ok" />
          ) : (
            <span className="text-dim">-</span>
          )}
        </Row>
      )}

      {showWithdrawn && (
        <Row label={ut.withdrawn(plainWithdrawn.length)}>
          <PrefixChips prefixes={plainWithdrawn} className="bg-critical-subtle text-critical line-through" />
        </Row>
      )}

      {/* EVPN carries route types, not prefixes; a chip cannot hold the
          RD, VNI and MAC that a fabric is actually diagnosed from. */}
      {evpnAnnounced.length > 0 && (
        <div className="px-3 py-2 space-y-1">
          <div className="text-xs font-semibold text-dim uppercase tracking-wide">
            {ut.evpnAnnounced(evpnAnnounced.length)}
          </div>
          <EvpnRouteTable routes={evpnAnnounced} tone="announced" />
        </div>
      )}
      {evpnWithdrawn.length > 0 && (
        <div className="px-3 py-2 space-y-1">
          <div className="text-xs font-semibold text-dim uppercase tracking-wide">
            {ut.evpnWithdrawn(evpnWithdrawn.length)}
          </div>
          <EvpnRouteTable routes={evpnWithdrawn} tone="withdrawn" />
        </div>
      )}

      {message.pathAttributes.length > 0 && (
        <Row label={ut.pathAttributes}>
          <div className="space-y-1">
            {message.pathAttributes.map((attr, i) => (
              <PathAttributeView key={i} attribute={attr} />
            ))}
          </div>
        </Row>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 flex flex-col gap-1 sm:flex-row sm:gap-3">
      <div className="text-xs text-muted sm:w-28 sm:shrink-0 sm:pt-0.5">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function PrefixChips({ prefixes, className }: { prefixes: BgpPrefix[]; className: string }) {
  const { t } = useI18n()
  const [showAll, setShowAll] = useState(false)
  const folded = !showAll && prefixes.length > PREFIX_FOLD
  const shown = folded ? prefixes.slice(0, PREFIX_FOLD) : prefixes

  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((prefix, i) => (
        <span key={i} className={`font-mono text-xs px-1.5 py-0.5 rounded ${className}`}>
          <FilterablePrefix prefix={prefix} />
          <PathId prefix={prefix} />
        </span>
      ))}
      {prefixes.length > PREFIX_FOLD && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="text-xs text-accent hover:text-accent-hover px-1"
        >
          {folded
            ? t.packetDetail.update.showAll(prefixes.length)
            : t.packetDetail.update.showFewer}
        </button>
      )}
    </div>
  )
}

/**
 * The ADD-PATH Path Identifier, on the routes that carry one (RFC 7911).
 *
 * Shown rather than folded into the prefix text because it is not part of the
 * route's name — `10.1.0.0/24` is the prefix whether or not the session
 * negotiated ADD-PATH — but it is the only thing distinguishing two chips that
 * otherwise read identically. Two announcements of the same prefix in one
 * UPDATE is not a duplicate; it is two paths, and without this it looks like
 * one.
 */
function PathId({ prefix }: { prefix: BgpPrefix }) {
  const { t } = useI18n()
  if (prefix.pathId === undefined) return null
  return (
    <span className="opacity-60" title={t.packetDetail.update.pathIdTitle(prefix.pathId)}>
      {' '}
      {t.packetDetail.update.pathIdLabel(prefix.pathId)}
    </span>
  )
}

/**
 * A prefix that can be filtered on. EVPN routes have no prefix to filter by —
 * their MAC is the handle, so that is what they offer instead.
 */
function FilterablePrefix({ prefix }: { prefix: BgpPrefix }) {
  const text = formatPrefix(prefix)
  if (prefix.evpn) {
    return prefix.evpn.macAddress ? (
      <FilterableValue field="mac" value={prefix.evpn.macAddress}>{text}</FilterableValue>
    ) : (
      <>{text}</>
    )
  }
  return <FilterableValue field="prefix" value={text} />
}

/**
 * One path attribute on one line: its name, its value, and the flags only when
 * they say something. Optional and Transitive follow from the attribute type
 * and are kept as small marks; Partial means a router on the way did not
 * understand it, which is worth noticing.
 */
function PathAttributeView({ attribute }: { attribute: BgpPathAttribute }) {
  const { t } = useI18n()
  const { parsed } = attribute

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="font-medium text-strong text-xs sm:w-36 sm:shrink-0">{attribute.typeName}</span>
      <div className="min-w-0 flex-1 text-muted">
        {parsed ? (
          <ParsedAttributeValue parsed={parsed} />
        ) : (
          <span className="font-mono text-xs">{t.common.bytes(attribute.length)}</span>
        )}
      </div>
      <span className="flex gap-1">
        {attribute.flags.optional && (
          <span className="text-[10px] text-dim" title={t.packetDetail.update.optTitle}>Opt</span>
        )}
        {attribute.flags.transitive && (
          <span className="text-[10px] text-dim" title={t.packetDetail.update.transTitle}>Trans</span>
        )}
        {attribute.flags.partial && (
          <span className="text-xs bg-warning-subtle text-warning px-1 rounded">Partial</span>
        )}
      </span>
    </div>
  )
}

function ParsedAttributeValue({ parsed }: { parsed: NonNullable<BgpPathAttribute['parsed']> }) {
  const { t } = useI18n()
  const ut = t.packetDetail.update

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
      return (
        <span className="font-mono">
          <FilterableValue field="next_hop" value={parsed.address} />
        </span>
      )

    case 'MULTI_EXIT_DISC':
      return <span className="font-mono">{parsed.value}</span>

    case 'LOCAL_PREF':
      return <span className="font-mono">{parsed.value}</span>

    case 'ATOMIC_AGGREGATE':
      return <span className="text-muted">{ut.present}</span>

    case 'AGGREGATOR':
      return (
        <span className="font-mono">
          {ut.aggregatorVia(parsed.asNumber, parsed.address)}
        </span>
      )

    case 'COMMUNITIES':
      return (
        <div className="flex flex-wrap gap-1 mt-1">
          {parsed.communities.map((comm, i) => (
            <span key={i} className="font-mono text-xs bg-surface-sunken text-body px-1.5 py-0.5 rounded">
              <FilterableValue field="community" value={comm} />
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
                    : 'bg-surface-sunken text-body'
              }`}
              title={comm.transitive ? undefined : ut.nonTransitiveTitle}
            >
              {comm.kind} {comm.value}
              {!comm.transitive && <span className="text-dim">{ut.nonTransitiveTag}</span>}
            </span>
          ))}
        </div>
      )

    case 'LARGE_COMMUNITIES':
      return (
        <div className="flex flex-wrap gap-1 mt-1">
          {parsed.communities.map((comm, i) => (
            <span key={i} className="font-mono text-xs bg-surface-sunken text-body px-1.5 py-0.5 rounded">
              <FilterableValue field="community" value={`${comm.globalAdmin}:${comm.localData1}:${comm.localData2}`} />
            </span>
          ))}
        </div>
      )

    // The prefixes these carry are listed with the UPDATE's own, under
    // Announced and Withdrawn; what is left here is what only they say.
    case 'MP_REACH_NLRI':
      return (
        <span className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-xs">
            {parsed.afiName} / {parsed.safiName}
          </span>
          <span className="font-mono">
            <span className="text-xs text-dim">{ut.nextHopLabel}</span>
            <FilterableValue field="next_hop" value={parsed.nextHop} />
          </span>
        </span>
      )

    case 'MP_UNREACH_NLRI':
      return (
        <span className="text-xs">
          {parsed.afiName} / {parsed.safiName}
        </span>
      )

    case 'UNKNOWN':
    default:
      return <span className="text-dim">{ut.unparsed}</span>
  }
}

function AsPathView({ segments }: { segments: AsPathSegment[] }) {
  const { t } = useI18n()
  if (segments.length === 0) {
    return <span className="text-dim">{t.packetDetail.update.empty}</span>
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
              <FilterableValue field="asn" value={String(asn)} />
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
  const { t } = useI18n()
  const ut = t.packetDetail.update
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
    <div className="rounded border border-hair overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-surface-sunken text-muted">
          <tr className="text-left">
            <th className="px-2 py-1 font-medium">{ut.evpnColType}</th>
            <th className="px-2 py-1 font-medium">RD</th>
            {showMac && <th className="px-2 py-1 font-medium">MAC</th>}
            {showIp && <th className="px-2 py-1 font-medium">{ut.evpnColIp}</th>}
            {showVni && <th className="px-2 py-1 font-medium">VNI</th>}
            {showEsi && <th className="px-2 py-1 font-medium">ESI</th>}
            {showTag && <th className="px-2 py-1 font-medium">{ut.evpnColEthTag}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-hair">
          {routes.map((route, i) => (
            <tr key={i}>
              <td className={`px-2 py-1 ${toneClass}`}>
                [{route.routeType}] {route.routeTypeName}
                {route.truncated && (
                  <span className="ml-1 text-warning" title={ut.evpnPartialTitle}>
                    {ut.evpnPartial}
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
                    <span className="text-dim" title={ut.evpnSecondLabelTitle}>
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
