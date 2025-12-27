import type {
  BgpUpdateMessage,
  BgpPathAttribute,
  BgpPrefix,
  AsPathSegment,
} from '../../lib/bgp/types'

interface UpdateMessageViewProps {
  message: BgpUpdateMessage
}

export function UpdateMessageView({ message }: UpdateMessageViewProps) {
  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-blue-700">Withdrawn Routes</span>
          <span className="font-mono">{message.withdrawnRoutes.length} prefixes</span>
        </div>
        <div className="flex justify-between">
          <span className="text-blue-700">Path Attributes</span>
          <span className="font-mono">{message.pathAttributes.length} attributes</span>
        </div>
        <div className="flex justify-between">
          <span className="text-blue-700">NLRI</span>
          <span className="font-mono">{message.nlri.length} prefixes</span>
        </div>
      </div>

      {/* Withdrawn Routes */}
      {message.withdrawnRoutes.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Withdrawn Routes
          </h4>
          <PrefixList prefixes={message.withdrawnRoutes} className="bg-red-50 border-red-200" />
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

      {/* NLRI */}
      {message.nlri.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            NLRI (Announced Routes)
          </h4>
          <PrefixList prefixes={message.nlri} className="bg-green-50 border-green-200" />
        </div>
      )}
    </div>
  )
}

function PrefixList({ prefixes, className }: { prefixes: BgpPrefix[]; className: string }) {
  return (
    <div className={`rounded-lg border p-3 ${className}`}>
      <div className="flex flex-wrap gap-1">
        {prefixes.map((prefix, i) => (
          <span key={i} className="font-mono text-xs bg-white px-1.5 py-0.5 rounded border">
            {prefix.prefix}
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
                  {prefix.prefix}
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
                  {prefix.prefix}
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
