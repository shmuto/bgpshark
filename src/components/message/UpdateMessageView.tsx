import { useState } from 'react'
import type {
  BgpUpdateMessage,
  BgpPathAttribute,
  BgpPrefix,
  AsPathSegment,
  MpReachNlriAttribute,
  MpUnreachNlriAttribute,
} from '../../lib/bgp/types'

interface UpdateMessageViewProps {
  message: BgpUpdateMessage
}

export function UpdateMessageView({ message }: UpdateMessageViewProps) {
  const [isExpanded, setIsExpanded] = useState(false)

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
        className="bg-gray-50 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-100 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* Summary Table */}
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-gray-200">
              <td className="px-3 py-2 text-gray-500 w-24">Announced</td>
              <td className="px-3 py-2">
                {allNlri.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {allNlri.slice(0, 8).map((prefix, i) => (
                      <span key={i} className="font-mono text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                        {prefix.prefix}/{prefix.length}
                      </span>
                    ))}
                    {allNlri.length > 8 && (
                      <span className="text-xs text-gray-500 px-1.5 py-0.5">... {allNlri.length - 8} more</span>
                    )}
                  </div>
                ) : (
                  <span className="text-gray-400">-</span>
                )}
              </td>
              <td className="px-3 py-2 text-right text-gray-500 w-16">{allNlri.length}</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="px-3 py-2 text-gray-500">Withdrawn</td>
              <td className="px-3 py-2">
                {allWithdrawn.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {allWithdrawn.slice(0, 5).map((prefix, i) => (
                      <span key={i} className="font-mono text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded line-through">
                        {prefix.prefix}/{prefix.length}
                      </span>
                    ))}
                    {allWithdrawn.length > 5 && (
                      <span className="text-xs text-gray-500 px-1.5 py-0.5">... {allWithdrawn.length - 5} more</span>
                    )}
                  </div>
                ) : (
                  <span className="text-gray-400">-</span>
                )}
              </td>
              <td className="px-3 py-2 text-right text-gray-500 w-16">{allWithdrawn.length}</td>
            </tr>
            {nextHop && (
              <tr className="border-b border-gray-200">
                <td className="px-3 py-2 text-gray-500">Next Hop</td>
                <td className="px-3 py-2 font-mono" colSpan={2}>{nextHop}</td>
              </tr>
            )}
            {asPath.length > 0 && (
              <tr>
                <td className="px-3 py-2 text-gray-500">AS Path</td>
                <td className="px-3 py-2" colSpan={2}>
                  <AsPathCompact segments={asPath} />
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Expand indicator */}
        <div className="px-3 py-1 text-xs text-gray-400 flex items-center gap-1 border-t border-gray-200">
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
        <div className="ml-4 space-y-3 border-l-2 border-gray-200 pl-4">
          {/* All NLRI */}
          {allNlri.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                NLRI ({allNlri.length} prefixes)
              </h4>
              <PrefixList prefixes={allNlri} className="bg-green-50 border-green-200" />
            </div>
          )}

          {/* All Withdrawn Routes */}
          {allWithdrawn.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Withdrawn Routes ({allWithdrawn.length} prefixes)
              </h4>
              <PrefixList prefixes={allWithdrawn} className="bg-red-50 border-red-200" />
            </div>
          )}

          {/* Path Attributes */}
          {message.pathAttributes.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
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
      {remaining > 0 && <span className="text-gray-400"> +{remaining}</span>}
    </span>
  )
}

function PrefixList({ prefixes, className }: { prefixes: BgpPrefix[]; className: string }) {
  return (
    <div className={`rounded-lg border p-3 ${className}`}>
      <div className="flex flex-wrap gap-1">
        {prefixes.map((prefix, i) => (
          <span key={i} className="font-mono text-xs bg-white px-1.5 py-0.5 rounded border">
            {prefix.prefix}/{prefix.length}
          </span>
        ))}
      </div>
    </div>
  )
}

function PathAttributeView({ attribute }: { attribute: BgpPathAttribute }) {
  const { parsed } = attribute

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-3 text-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-gray-700">{attribute.typeName}</span>
        <div className="flex gap-1">
          {attribute.flags.optional && (
            <span className="text-xs bg-gray-200 px-1 rounded">Optional</span>
          )}
          {attribute.flags.transitive && (
            <span className="text-xs bg-gray-200 px-1 rounded">Transitive</span>
          )}
          {attribute.flags.partial && (
            <span className="text-xs bg-yellow-200 px-1 rounded">Partial</span>
          )}
        </div>
      </div>

      <div className="text-gray-600">
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
              ? 'bg-green-100 text-green-700'
              : parsed.value === 'EGP'
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-gray-100 text-gray-700'
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
      return <span className="text-gray-500">Present</span>

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
            <span key={i} className="font-mono text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
              {comm}
            </span>
          ))}
        </div>
      )

    case 'LARGE_COMMUNITIES':
      return (
        <div className="flex flex-wrap gap-1 mt-1">
          {parsed.communities.map((comm, i) => (
            <span key={i} className="font-mono text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
              {comm.globalAdmin}:{comm.localData1}:{comm.localData2}
            </span>
          ))}
        </div>
      )

    case 'MP_REACH_NLRI':
      return (
        <div className="space-y-1">
          <div className="text-xs text-gray-500">
            {parsed.afiName} / {parsed.safiName}
          </div>
          <div className="font-mono">Next Hop: {parsed.nextHop}</div>
          {parsed.nlri.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {parsed.nlri.map((prefix, i) => (
                <span key={i} className="font-mono text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                  {prefix.prefix}/{prefix.length}
                </span>
              ))}
            </div>
          )}
        </div>
      )

    case 'MP_UNREACH_NLRI':
      return (
        <div className="space-y-1">
          <div className="text-xs text-gray-500">
            {parsed.afiName} / {parsed.safiName}
          </div>
          {parsed.withdrawnRoutes.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {parsed.withdrawnRoutes.map((prefix, i) => (
                <span key={i} className="font-mono text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
                  {prefix.prefix}/{prefix.length}
                </span>
              ))}
            </div>
          )}
        </div>
      )

    case 'UNKNOWN':
    default:
      return <span className="text-gray-400">Unparsed</span>
  }
}

function AsPathView({ segments }: { segments: AsPathSegment[] }) {
  if (segments.length === 0) {
    return <span className="text-gray-400">Empty</span>
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {segments.map((segment, i) => (
        <span key={i} className="flex items-center gap-1">
          {segment.type === 'AS_SET' && <span className="text-gray-400">{'{'}</span>}
          {segment.type === 'AS_CONFED_SEQUENCE' && <span className="text-gray-400">(</span>}
          {segment.type === 'AS_CONFED_SET' && <span className="text-gray-400">({'{'}</span>}

          {segment.asNumbers.map((asn, j) => (
            <span key={j} className="font-mono text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
              {asn}
            </span>
          ))}

          {segment.type === 'AS_SET' && <span className="text-gray-400">{'}'}</span>}
          {segment.type === 'AS_CONFED_SEQUENCE' && <span className="text-gray-400">)</span>}
          {segment.type === 'AS_CONFED_SET' && <span className="text-gray-400">{'})'}</span>}
        </span>
      ))}
    </div>
  )
}
