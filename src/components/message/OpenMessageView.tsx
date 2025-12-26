import { useState } from 'react'
import type { BgpOpenMessage, BgpCapability, ParsedCapability } from '../../lib/bgp/types'

interface OpenMessageViewProps {
  message: BgpOpenMessage
}

export function OpenMessageView({ message }: OpenMessageViewProps) {
  const displayAs = message.fourByteAs ?? message.myAs

  return (
    <div className="space-y-3">
      {/* Basic Fields */}
      <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-2">
        <FieldRow label="Version" value={message.version.toString()} />
        <FieldRow
          label="My AS"
          value={
            message.fourByteAs
              ? `${displayAs} (2-byte: ${message.myAs})`
              : displayAs.toString()
          }
        />
        <FieldRow label="Hold Time" value={`${message.holdTime} seconds`} />
        <FieldRow label="BGP Identifier" value={message.bgpIdentifier} />
      </div>

      {/* Capabilities */}
      {message.capabilities.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">
            Capabilities ({message.capabilities.length})
          </h4>
          <div className="space-y-2">
            {message.capabilities.map((cap, index) => (
              <CapabilityItem key={index} capability={cap} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}

function CapabilityItem({ capability }: { capability: BgpCapability }) {
  const [isExpanded, setIsExpanded] = useState(false)

  const hasDetails = capability.parsed && capability.parsed.type !== 'UNKNOWN'

  return (
    <div className="bg-gray-50 rounded-lg overflow-hidden">
      <button
        onClick={() => hasDetails && setIsExpanded(!isExpanded)}
        className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between
          ${hasDetails ? 'hover:bg-gray-100 cursor-pointer' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-400 font-mono text-xs">[{capability.code}]</span>
          <span className="font-medium">{capability.name}</span>
        </div>
        {hasDetails && (
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {isExpanded && capability.parsed && (
        <div className="px-3 pb-3 text-sm">
          <CapabilityDetails parsed={capability.parsed} />
        </div>
      )}
    </div>
  )
}

function CapabilityDetails({ parsed }: { parsed: ParsedCapability }) {
  switch (parsed.type) {
    case 'MULTIPROTOCOL':
      return (
        <div className="bg-white rounded p-2 space-y-1">
          <div className="flex justify-between">
            <span className="text-gray-500">AFI</span>
            <span className="font-mono">
              {parsed.afi} ({parsed.afiName})
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">SAFI</span>
            <span className="font-mono">
              {parsed.safi} ({parsed.safiName})
            </span>
          </div>
        </div>
      )

    case 'FOUR_OCTET_AS':
      return (
        <div className="bg-white rounded p-2">
          <div className="flex justify-between">
            <span className="text-gray-500">AS Number</span>
            <span className="font-mono">{parsed.asNumber}</span>
          </div>
        </div>
      )

    case 'GRACEFUL_RESTART':
      return (
        <div className="bg-white rounded p-2 space-y-2">
          <div className="flex justify-between">
            <span className="text-gray-500">Restart Time</span>
            <span className="font-mono">{parsed.restartTime} seconds</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Restart Flags</span>
            <span className="font-mono">0x{parsed.restartFlags.toString(16).padStart(2, '0')}</span>
          </div>
          {parsed.addressFamilies.length > 0 && (
            <div>
              <span className="text-gray-500 text-xs">Address Families:</span>
              <div className="mt-1 space-y-1">
                {parsed.addressFamilies.map((af, i) => (
                  <div key={i} className="text-xs font-mono bg-gray-100 rounded px-2 py-1">
                    {af.afiName}/{af.safiName} (flags: 0x{af.flags.toString(16).padStart(2, '0')})
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )

    case 'ADD_PATH':
      return (
        <div className="bg-white rounded p-2">
          <span className="text-gray-500 text-xs">Address Families:</span>
          <div className="mt-1 space-y-1">
            {parsed.addressFamilies.map((af, i) => (
              <div key={i} className="text-xs font-mono bg-gray-100 rounded px-2 py-1">
                {af.afiName}/{af.safiName}: {af.sendReceive}
              </div>
            ))}
          </div>
        </div>
      )

    case 'EXTENDED_NEXT_HOP':
      return (
        <div className="bg-white rounded p-2">
          <span className="text-gray-500 text-xs">Next Hop Encodings:</span>
          <div className="mt-1 space-y-1">
            {parsed.entries.map((entry, i) => (
              <div key={i} className="text-xs font-mono bg-gray-100 rounded px-2 py-1">
                {entry.nlriAfiName}/{entry.nlriSafiName} uses {entry.nexthopAfiName} next-hop
              </div>
            ))}
          </div>
        </div>
      )

    case 'ROUTE_REFRESH':
    case 'ENHANCED_ROUTE_REFRESH':
      return (
        <div className="bg-white rounded p-2 text-gray-500 text-sm">Supported</div>
      )

    default:
      return null
  }
}
