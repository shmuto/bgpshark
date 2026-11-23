import { useState } from 'react'
import type { BgpOpenMessage, BgpCapability, ParsedCapability } from '../../lib/bgp/types'
import { useI18n } from '../../i18n'

interface OpenMessageViewProps {
  message: BgpOpenMessage
}

export function OpenMessageView({ message }: OpenMessageViewProps) {
  const { t } = useI18n()
  const displayAs = message.fourByteAs ?? message.myAs

  return (
    <div className="space-y-3">
      {/* Basic Fields */}
      <div className="bg-surface-sunken rounded p-3 text-xs space-y-2">
        <FieldRow label={t.packetDetail.open.version} value={message.version.toString()} />
        <FieldRow
          label={t.packetDetail.open.myAs}
          value={
            message.fourByteAs
              ? t.packetDetail.open.twoByteAs(displayAs, message.myAs)
              : displayAs.toString()
          }
        />
        <FieldRow label={t.packetDetail.open.holdTime} value={t.common.seconds(message.holdTime)} />
        <FieldRow label={t.packetDetail.open.bgpIdentifier} value={message.bgpIdentifier} />
      </div>

      {/* Capabilities */}
      {message.capabilities.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-strong mb-2">
            {t.packetDetail.open.capabilities(message.capabilities.length)}
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
      <span className="text-muted">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}

function CapabilityItem({ capability }: { capability: BgpCapability }) {
  const [isExpanded, setIsExpanded] = useState(false)

  const hasDetails = capability.parsed && capability.parsed.type !== 'UNKNOWN'

  return (
    <div className="bg-surface-sunken rounded overflow-hidden">
      <button
        onClick={() => hasDetails && setIsExpanded(!isExpanded)}
        className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between
          ${hasDetails ? 'hover:bg-surface-raised cursor-pointer' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-dim font-mono text-xs">[{capability.code}]</span>
          <span className="font-medium">{capability.name}</span>
        </div>
        {hasDetails && (
          <svg
            className={`w-4 h-4 text-dim transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {isExpanded && capability.parsed && (
        <div className="px-3 pb-3 text-xs">
          <CapabilityDetails parsed={capability.parsed} />
        </div>
      )}
    </div>
  )
}

function CapabilityDetails({ parsed }: { parsed: ParsedCapability }) {
  const { t } = useI18n()

  switch (parsed.type) {
    case 'MULTIPROTOCOL':
      return (
        <div className="bg-surface rounded p-2 space-y-1">
          <div className="flex justify-between">
            <span className="text-muted">AFI</span>
            <span className="font-mono">
              {parsed.afi} ({parsed.afiName})
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">SAFI</span>
            <span className="font-mono">
              {parsed.safi} ({parsed.safiName})
            </span>
          </div>
        </div>
      )

    case 'FOUR_OCTET_AS':
      return (
        <div className="bg-surface rounded p-2">
          <div className="flex justify-between">
            <span className="text-muted">{t.packetDetail.open.asNumber}</span>
            <span className="font-mono">{parsed.asNumber}</span>
          </div>
        </div>
      )

    case 'GRACEFUL_RESTART':
      return (
        <div className="bg-surface rounded p-2 space-y-2">
          <div className="flex justify-between">
            <span className="text-muted">{t.packetDetail.open.restartTime}</span>
            <span className="font-mono">{t.common.seconds(parsed.restartTime)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">{t.packetDetail.open.restartFlags}</span>
            <span className="font-mono">0x{parsed.restartFlags.toString(16).padStart(2, '0')}</span>
          </div>
          {parsed.addressFamilies.length > 0 && (
            <div>
              <span className="text-muted text-xs">{t.packetDetail.open.addressFamilies}</span>
              <div className="mt-1 space-y-1">
                {parsed.addressFamilies.map((af, i) => (
                  <div key={i} className="text-xs font-mono bg-surface-sunken rounded px-2 py-1">
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
        <div className="bg-surface rounded p-2">
          <span className="text-muted text-xs">{t.packetDetail.open.addressFamilies}</span>
          <div className="mt-1 space-y-1">
            {parsed.addressFamilies.map((af, i) => (
              <div key={i} className="text-xs font-mono bg-surface-sunken rounded px-2 py-1">
                {af.afiName}/{af.safiName}: {af.sendReceive}
              </div>
            ))}
          </div>
        </div>
      )

    case 'EXTENDED_NEXT_HOP':
      return (
        <div className="bg-surface rounded p-2">
          <span className="text-muted text-xs">{t.packetDetail.open.nextHopEncodings}</span>
          <div className="mt-1 space-y-1">
            {parsed.entries.map((entry, i) => (
              <div key={i} className="text-xs font-mono bg-surface-sunken rounded px-2 py-1">
                {t.packetDetail.open.usesNextHop(
                  entry.nlriAfiName,
                  entry.nlriSafiName,
                  entry.nexthopAfiName
                )}
              </div>
            ))}
          </div>
        </div>
      )

    case 'ROUTE_REFRESH':
    case 'ENHANCED_ROUTE_REFRESH':
      return (
        <div className="bg-surface rounded p-2 text-muted text-xs">{t.packetDetail.open.supported}</div>
      )

    default:
      return null
  }
}
