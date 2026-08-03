import { useMemo } from 'react'
import type { BgpOpenMessage } from '../../lib/bgp/types'

export interface CapabilityDiffProps {
  localLabel: string
  remoteLabel: string
  localOpen: BgpOpenMessage | null
  remoteOpen: BgpOpenMessage | null
}

type Tone = 'ok' | 'warn' | 'error' | 'neutral'

const TONE_CLASSES: Record<Tone, string> = {
  ok: 'text-ok bg-ok-subtle',
  warn: 'text-warning bg-warning-subtle',
  error: 'text-critical bg-critical-subtle',
  neutral: 'text-muted bg-surface-sunken',
}

// RFC 6793: when a 4-byte AS is carried in the capability, the legacy 2-byte
// My AS field should either equal it (if it fits in 2 bytes) or be set to
// AS_TRANS. Anything else means the OPEN message itself is inconsistent.
const AS_TRANS = 23456

/**
 * Side-by-side comparison of the two OPEN messages exchanged on a BGP
 * session: the non-capability fields that matter for establishment, then a
 * three-state diff (both / local-only / remote-only) of every capability,
 * compared at the AFI/SAFI (or equivalent) level rather than by capability
 * code alone. Mismatches are rendered before matches so an operator scanning
 * for "why won't this session come up" sees the differences first.
 */
export function CapabilityDiff({ localLabel, remoteLabel, localOpen, remoteOpen }: CapabilityDiffProps) {
  const rows = useMemo(() => buildCapabilityRows(localOpen, remoteOpen), [localOpen, remoteOpen])
  const mismatchRows = rows.filter((row) => row.presence !== 'both')
  const matchedRows = rows.filter((row) => row.presence === 'both')

  if (!localOpen && !remoteOpen) {
    return (
      <div className="text-sm text-dim text-center py-6">
        No OPEN message captured for either side of this session
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {(!localOpen || !remoteOpen) && (
        <div className="flex items-center gap-2 rounded-lg bg-warning-subtle border border-hair px-3 py-2 text-xs text-warning">
          <span aria-hidden="true">⚠</span>
          <span>
            No OPEN captured from {!localOpen ? localLabel : remoteLabel} — this is a one-sided comparison.
          </span>
        </div>
      )}

      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
          Session Fields
        </h4>
        <SessionFieldsTable
          localLabel={localLabel}
          remoteLabel={remoteLabel}
          localOpen={localOpen}
          remoteOpen={remoteOpen}
        />
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Capability Mismatches {mismatchRows.length > 0 ? `(${mismatchRows.length})` : ''}
          </h4>
          <Legend />
        </div>
        {mismatchRows.length > 0 ? (
          <CapabilityTable rows={mismatchRows} localLabel={localLabel} remoteLabel={remoteLabel} />
        ) : (
          <div className="text-xs text-muted rounded-lg border border-hair bg-ok-subtle px-3 py-2">
            ✓ No capability mismatches detected
          </div>
        )}
      </section>

      {matchedRows.length > 0 && (
        <details>
          <summary className="text-xs font-semibold uppercase tracking-wide text-muted cursor-pointer select-none">
            Matching Capabilities ({matchedRows.length})
          </summary>
          <div className="mt-2">
            <CapabilityTable rows={matchedRows} localLabel={localLabel} remoteLabel={remoteLabel} />
          </div>
        </details>
      )}
    </div>
  )
}

function Legend() {
  return (
    <span className="text-xs text-dim">
      <span className="text-muted">✓</span> advertised &nbsp;
      <span className="text-dim">✗</span> not advertised &nbsp;
      <span className="text-warning">⚠</span> mismatch
    </span>
  )
}

// ---------------------------------------------------------------------------
// Session fields (non-capability OPEN fields)
// ---------------------------------------------------------------------------

interface FieldStatus {
  tone: Tone
  text: string
}

function SessionFieldsTable({
  localLabel,
  remoteLabel,
  localOpen,
  remoteOpen,
}: {
  localLabel: string
  remoteLabel: string
  localOpen: BgpOpenMessage | null
  remoteOpen: BgpOpenMessage | null
}) {
  const localAs = localOpen ? effectiveAs(localOpen) : null
  const remoteAs = remoteOpen ? effectiveAs(remoteOpen) : null

  const versionStatus: FieldStatus | null =
    !localOpen || !remoteOpen
      ? null
      : localOpen.version === remoteOpen.version
        ? { tone: 'ok', text: '✓ Match' }
        : { tone: 'error', text: '⚠ Mismatch' }

  const asInconsistency = localAs?.note ?? remoteAs?.note ?? null
  const asStatus: FieldStatus | null = asInconsistency
    ? { tone: 'error', text: '⚠ AS field inconsistent' }
    : !localOpen || !remoteOpen || !localAs || !remoteAs
      ? null
      : localAs.as === remoteAs.as
        ? { tone: 'neutral', text: 'Same AS on both sides' }
        : { tone: 'neutral', text: 'Differs — normal for eBGP' }

  const holdTimeStatus: FieldStatus | null =
    !localOpen || !remoteOpen
      ? null
      : localOpen.holdTime === remoteOpen.holdTime
        ? { tone: 'ok', text: '✓ Match' }
        : { tone: 'neutral', text: 'Differs — not an error, the lower value is negotiated' }

  const routerIdStatus: FieldStatus | null =
    !localOpen || !remoteOpen
      ? null
      : localOpen.bgpIdentifier === remoteOpen.bgpIdentifier
        ? { tone: 'error', text: '⚠ Collision — same Router ID on both sides' }
        : { tone: 'ok', text: '✓ Unique' }

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-hair text-left text-muted">
          <th className="py-1.5 pr-3 font-medium">Field</th>
          <th className="py-1.5 pr-3 font-medium">{localLabel}</th>
          <th className="py-1.5 pr-3 font-medium">{remoteLabel}</th>
          <th className="py-1.5 font-medium">Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-hair">
        <FieldRow
          label="BGP Version"
          localValue={localOpen ? String(localOpen.version) : null}
          remoteValue={remoteOpen ? String(remoteOpen.version) : null}
          status={versionStatus}
        />
        <FieldRow
          label="My AS"
          localValue={localOpen && localAs ? formatAs(localOpen, localAs) : null}
          remoteValue={remoteOpen && remoteAs ? formatAs(remoteOpen, remoteAs) : null}
          status={asStatus}
          caption={asInconsistency ?? undefined}
        />
        <FieldRow
          label="Hold Time"
          localValue={localOpen ? `${localOpen.holdTime}s` : null}
          remoteValue={remoteOpen ? `${remoteOpen.holdTime}s` : null}
          status={holdTimeStatus}
        />
        <FieldRow
          label="BGP Identifier"
          localValue={localOpen?.bgpIdentifier ?? null}
          remoteValue={remoteOpen?.bgpIdentifier ?? null}
          status={routerIdStatus}
        />
      </tbody>
    </table>
  )
}

function FieldRow({
  label,
  localValue,
  remoteValue,
  status,
  caption,
}: {
  label: string
  localValue: string | null
  remoteValue: string | null
  status: FieldStatus | null
  caption?: string
}) {
  return (
    <tr>
      <td className="py-1.5 pr-3 text-muted align-top">{label}</td>
      <td className="py-1.5 pr-3 font-mono align-top">
        {localValue ?? <span className="text-dim italic font-sans">not captured</span>}
      </td>
      <td className="py-1.5 pr-3 font-mono align-top">
        {remoteValue ?? <span className="text-dim italic font-sans">not captured</span>}
      </td>
      <td className="py-1.5 align-top">
        {status && (
          <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${TONE_CLASSES[status.tone]}`}>
            {status.text}
          </span>
        )}
        {caption && <div className="text-xs text-dim mt-0.5">{caption}</div>}
      </td>
    </tr>
  )
}

function effectiveAs(open: BgpOpenMessage): { as: number; note: string | null } {
  if (open.fourByteAs !== undefined) {
    const expected2Byte = open.fourByteAs > 0xffff ? AS_TRANS : open.fourByteAs
    const consistent = open.myAs === expected2Byte
    return {
      as: open.fourByteAs,
      note: consistent
        ? null
        : `2-byte My AS field is ${open.myAs}, expected ${expected2Byte} given the 4-byte AS capability`,
    }
  }
  return { as: open.myAs, note: null }
}

function formatAs(open: BgpOpenMessage, as: { as: number; note: string | null }): string {
  return open.fourByteAs !== undefined && open.fourByteAs !== open.myAs
    ? `${as.as} (2-byte field: ${open.myAs})`
    : String(as.as)
}

// ---------------------------------------------------------------------------
// Capability diff
// ---------------------------------------------------------------------------

type Presence = 'both' | 'local-only' | 'remote-only'

interface CapabilitySide {
  present: boolean
  detail: string | null
}

interface CapabilityRow {
  id: string
  group: string
  label: string
  local: CapabilitySide
  remote: CapabilitySide
  presence: Presence
}

interface ExtractedEntry {
  id: string
  group: string
  label: string
  detail: string | null
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Flattens one OPEN message's capabilities into comparable entries. Each
 * entry's `id` is the diff key: Multiprotocol Extensions and ADD-PATH are
 * keyed per AFI/SAFI (not just by capability code), Extended Next Hop is
 * keyed per NLRI-AFI/SAFI + next-hop-AFI triple, and unrecognized
 * capabilities are keyed by code *and* raw payload so two different unknown
 * capabilities sharing a code don't collapse into one. Repeats of the same
 * capability (or the same AFI/SAFI entry inside it) within one OPEN dedupe
 * via `seen`.
 */
function extractEntries(open: BgpOpenMessage): ExtractedEntry[] {
  const entries: ExtractedEntry[] = []
  const seen = new Set<string>()

  const push = (id: string, group: string, label: string, detail: string | null = null) => {
    if (seen.has(id)) return
    seen.add(id)
    entries.push({ id, group, label, detail })
  }

  for (const cap of open.capabilities) {
    const parsed = cap.parsed

    if (!parsed || parsed.type === 'UNKNOWN') {
      push(`UNKNOWN:${cap.code}:${hex(cap.rawValue)}`, cap.name, `Code ${cap.code}`, `${cap.length} byte payload`)
      continue
    }

    switch (parsed.type) {
      case 'MULTIPROTOCOL':
        push(`MP:${parsed.afi}:${parsed.safi}`, 'Multiprotocol Extensions', `${parsed.afiName} / ${parsed.safiName}`)
        break

      case 'FOUR_OCTET_AS':
        push('FOUR_OCTET_AS', '4-byte AS Number', 'Support', `AS ${parsed.asNumber}`)
        break

      case 'ROUTE_REFRESH':
        push('ROUTE_REFRESH', 'Route Refresh', 'Support')
        break

      case 'ENHANCED_ROUTE_REFRESH':
        push('ENHANCED_ROUTE_REFRESH', 'Enhanced Route Refresh', 'Support')
        break

      case 'GRACEFUL_RESTART':
        push(
          'GRACEFUL_RESTART',
          'Graceful Restart',
          'Support',
          `restart time ${parsed.restartTime}s, flags 0x${parsed.restartFlags.toString(16).padStart(2, '0')}`
        )
        for (const af of parsed.addressFamilies) {
          push(
            `GR:${af.afi}:${af.safi}`,
            'Graceful Restart',
            `${af.afiName} / ${af.safiName} forwarding state`,
            `flags 0x${af.flags.toString(16).padStart(2, '0')}`
          )
        }
        break

      case 'ADD_PATH':
        for (const af of parsed.addressFamilies) {
          push(`ADD_PATH:${af.afi}:${af.safi}`, 'ADD-PATH', `${af.afiName} / ${af.safiName}`, af.sendReceive)
        }
        break

      case 'EXTENDED_NEXT_HOP':
        for (const entry of parsed.entries) {
          push(
            `ENH:${entry.nlriAfi}:${entry.nlriSafi}:${entry.nexthopAfi}`,
            'Extended Next Hop Encoding',
            `${entry.nlriAfiName}/${entry.nlriSafiName} via ${entry.nexthopAfiName} next-hop`
          )
        }
        break
    }
  }

  return entries
}

function buildCapabilityRows(
  localOpen: BgpOpenMessage | null,
  remoteOpen: BgpOpenMessage | null
): CapabilityRow[] {
  const localEntries = localOpen ? extractEntries(localOpen) : []
  const remoteEntries = remoteOpen ? extractEntries(remoteOpen) : []

  const byId = new Map<string, Omit<CapabilityRow, 'id' | 'presence'>>()

  for (const entry of localEntries) {
    byId.set(entry.id, {
      group: entry.group,
      label: entry.label,
      local: { present: true, detail: entry.detail },
      remote: { present: false, detail: null },
    })
  }

  for (const entry of remoteEntries) {
    const existing = byId.get(entry.id)
    if (existing) {
      existing.remote = { present: true, detail: entry.detail }
    } else {
      byId.set(entry.id, {
        group: entry.group,
        label: entry.label,
        local: { present: false, detail: null },
        remote: { present: true, detail: entry.detail },
      })
    }
  }

  const rows: CapabilityRow[] = []
  for (const [id, value] of byId) {
    const presence: Presence =
      value.local.present && value.remote.present
        ? 'both'
        : value.local.present
          ? 'local-only'
          : 'remote-only'
    rows.push({ id, ...value, presence })
  }

  rows.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
  return rows
}

function CapabilityTable({
  rows,
  localLabel,
  remoteLabel,
}: {
  rows: CapabilityRow[]
  localLabel: string
  remoteLabel: string
}) {
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-hair text-left text-muted">
          <th className="py-1.5 pr-3 font-medium">Capability</th>
          <th className="py-1.5 pr-3 font-medium">{localLabel}</th>
          <th className="py-1.5 pr-3 font-medium">{remoteLabel}</th>
          <th className="py-1.5 font-medium">Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-hair">
        {rows.map((row) => {
          const status: FieldStatus =
            row.presence === 'both'
              ? { tone: 'ok', text: '✓ Both' }
              : row.presence === 'local-only'
                ? { tone: 'warn', text: `⚠ Only ${localLabel}` }
                : { tone: 'warn', text: `⚠ Only ${remoteLabel}` }

          return (
            <tr key={row.id}>
              <td className="py-1.5 pr-3 align-top">
                <div className="text-strong">{row.label}</div>
                <div className="text-xs text-dim">{row.group}</div>
              </td>
              <CapabilitySideCell side={row.local} />
              <CapabilitySideCell side={row.remote} />
              <td className="py-1.5 align-top">
                <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${TONE_CLASSES[status.tone]}`}>
                  {status.text}
                </span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function CapabilitySideCell({ side }: { side: CapabilitySide }) {
  return (
    <td className="py-1.5 pr-3 align-top font-mono text-xs">
      {side.present ? (
        <span className="text-body">✓ {side.detail ?? 'Supported'}</span>
      ) : (
        <span className="text-dim">✗ —</span>
      )}
    </td>
  )
}
