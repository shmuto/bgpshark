import { useMemo } from 'react'
import type { BgpOpenMessage } from '../../lib/bgp/types'
import { addPathDirections, type AddPathDirection } from '../../lib/bgp/session'
import { getAfiName, getSafiName } from '../../lib/bgp/constants'
import { useI18n, type Messages } from '../../i18n'

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
  const { t } = useI18n()
  const ct = t.capabilityDiff
  const rows = useMemo(() => buildCapabilityRows(localOpen, remoteOpen, t), [localOpen, remoteOpen, t])
  const mismatchRows = rows.filter((row) => row.presence !== 'both')
  const matchedRows = rows.filter((row) => row.presence === 'both')

  if (!localOpen && !remoteOpen) {
    return (
      <div className="text-xs text-dim text-center py-6">
        {ct.noOpenEither}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {(!localOpen || !remoteOpen) && (
        <div className="flex items-center gap-2 rounded bg-warning-subtle border border-hair px-3 py-2 text-xs text-warning">
          <span aria-hidden="true">⚠</span>
          <span>
            {ct.oneSidedWarning(!localOpen ? localLabel : remoteLabel)}
          </span>
        </div>
      )}

      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
          {ct.sessionFields}
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
            {ct.mismatches(mismatchRows.length)}
          </h4>
          <Legend />
        </div>
        {mismatchRows.length > 0 ? (
          <CapabilityTable rows={mismatchRows} localLabel={localLabel} remoteLabel={remoteLabel} />
        ) : (
          <div className="text-xs text-muted rounded border border-hair bg-ok-subtle px-3 py-2">
            {ct.noMismatches}
          </div>
        )}
      </section>

      {localOpen && remoteOpen && (
        <AddPathOutcome
          localLabel={localLabel}
          remoteLabel={remoteLabel}
          localOpen={localOpen}
          remoteOpen={remoteOpen}
        />
      )}

      {matchedRows.length > 0 && (
        <details>
          <summary className="text-xs font-semibold uppercase tracking-wide text-muted cursor-pointer select-none">
            {ct.matchingCapabilities(matchedRows.length)}
          </summary>
          <div className="mt-2">
            <CapabilityTable rows={matchedRows} localLabel={localLabel} remoteLabel={remoteLabel} />
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * What ADD-PATH actually came to, per direction and address family.
 *
 * The capability table above says what each side *advertised*, and for
 * ADD-PATH that is not enough to answer the question anyone has. The
 * capability is directional and negotiated crosswise: identifiers flow one way
 * only if the sender offered to send and the receiver offered to receive. Two
 * routers that both advertise `send` for the same family produce two ticks and
 * a "matching capability" row, and not one Path Identifier on the wire — which
 * is exactly the configuration mistake this section exists to catch.
 *
 * It appears only when both OPENs were captured, because half an exchange
 * cannot answer a crosswise question, and only when at least one side asked for
 * ADD-PATH at all.
 */
function AddPathOutcome({
  localLabel,
  remoteLabel,
  localOpen,
  remoteOpen,
}: {
  localLabel: string
  remoteLabel: string
  localOpen: BgpOpenMessage
  remoteOpen: BgpOpenMessage
}) {
  const { t } = useI18n()
  const ct = t.capabilityDiff
  const outward = useMemo(() => addPathDirections(localOpen, remoteOpen), [localOpen, remoteOpen])
  const inward = useMemo(() => addPathDirections(remoteOpen, localOpen), [localOpen, remoteOpen])

  if (outward.length === 0) return null

  return (
    <section>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
        {ct.addPathResult}
      </h4>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-1 pr-3 font-medium">{ct.colAddressFamily}</th>
            <th className="py-1 pr-3 font-medium">{ct.colDirection}</th>
            <th className="py-1 font-medium">{ct.colPathIdentifiers}</th>
          </tr>
        </thead>
        <tbody>
          {outward.map((family) => (
            <AddPathRow
              key={`out:${family.afi}/${family.safi}`}
              family={family}
              from={localLabel}
              to={remoteLabel}
            />
          ))}
          {inward.map((family) => (
            <AddPathRow
              key={`in:${family.afi}/${family.safi}`}
              family={family}
              from={remoteLabel}
              to={localLabel}
            />
          ))}
        </tbody>
      </table>
    </section>
  )
}

function AddPathRow({
  family,
  from,
  to,
}: {
  family: AddPathDirection
  from: string
  to: string
}) {
  const { t } = useI18n()
  const ct = t.capabilityDiff
  // Which half is missing is the whole diagnosis, so the reason names it rather
  // than saying "not negotiated" and leaving the reader to diff two rows of the
  // table above.
  const reason = family.negotiated
    ? null
    : !family.senderSends && !family.receiverReceives
      ? ct.addPathNeither(from, to)
      : !family.senderSends
        ? ct.addPathNoSend(from)
        : ct.addPathNoReceive(to)

  return (
    <tr>
      <td className="py-1.5 pr-3 align-top">
        {getAfiName(family.afi)} / {getSafiName(family.safi)}
      </td>
      <td className="py-1.5 pr-3 font-mono align-top whitespace-nowrap">
        {from} → {to}
      </td>
      <td className="py-1.5 align-top">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-xs ${
            TONE_CLASSES[family.negotiated ? 'ok' : 'neutral']
          }`}
        >
          {family.negotiated ? ct.addPathSent : ct.addPathNotSent}
        </span>
        {reason && <div className="text-xs text-dim mt-0.5">{reason}</div>}
      </td>
    </tr>
  )
}

function Legend() {
  const { t } = useI18n()
  const ct = t.capabilityDiff
  return (
    <span className="text-xs text-dim">
      <span className="text-muted">✓</span> {ct.legendAdvertised} &nbsp;
      <span className="text-dim">✗</span> {ct.legendNotAdvertised} &nbsp;
      <span className="text-warning">⚠</span> {ct.legendMismatch}
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
  const { t } = useI18n()
  const ct = t.capabilityDiff
  const localAs = localOpen ? effectiveAs(localOpen, t) : null
  const remoteAs = remoteOpen ? effectiveAs(remoteOpen, t) : null

  const versionStatus: FieldStatus | null =
    !localOpen || !remoteOpen
      ? null
      : localOpen.version === remoteOpen.version
        ? { tone: 'ok', text: ct.statusMatch }
        : { tone: 'error', text: ct.statusMismatch }

  const asInconsistency = localAs?.note ?? remoteAs?.note ?? null
  const asStatus: FieldStatus | null = asInconsistency
    ? { tone: 'error', text: ct.statusAsInconsistent }
    : !localOpen || !remoteOpen || !localAs || !remoteAs
      ? null
      : localAs.as === remoteAs.as
        ? { tone: 'neutral', text: ct.statusSameAs }
        : { tone: 'neutral', text: ct.statusDiffersEbgp }

  const holdTimeStatus: FieldStatus | null =
    !localOpen || !remoteOpen
      ? null
      : localOpen.holdTime === remoteOpen.holdTime
        ? { tone: 'ok', text: ct.statusMatch }
        : { tone: 'neutral', text: ct.statusHoldDiffers }

  const routerIdStatus: FieldStatus | null =
    !localOpen || !remoteOpen
      ? null
      : localOpen.bgpIdentifier === remoteOpen.bgpIdentifier
        ? { tone: 'error', text: ct.statusIdCollision }
        : { tone: 'ok', text: ct.statusIdUnique }

  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="border-b border-hair text-left text-muted">
          <th className="py-1.5 pr-3 font-medium">{ct.colField}</th>
          <th className="py-1.5 pr-3 font-medium">{localLabel}</th>
          <th className="py-1.5 pr-3 font-medium">{remoteLabel}</th>
          <th className="py-1.5 font-medium">{ct.colStatus}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-hair">
        <FieldRow
          label={ct.fieldBgpVersion}
          localValue={localOpen ? String(localOpen.version) : null}
          remoteValue={remoteOpen ? String(remoteOpen.version) : null}
          status={versionStatus}
        />
        <FieldRow
          label={ct.fieldMyAs}
          localValue={localOpen && localAs ? formatAs(localOpen, localAs, t) : null}
          remoteValue={remoteOpen && remoteAs ? formatAs(remoteOpen, remoteAs, t) : null}
          status={asStatus}
          caption={asInconsistency ?? undefined}
        />
        <FieldRow
          label={ct.fieldHoldTime}
          localValue={localOpen ? `${localOpen.holdTime}s` : null}
          remoteValue={remoteOpen ? `${remoteOpen.holdTime}s` : null}
          status={holdTimeStatus}
        />
        <FieldRow
          label={ct.fieldBgpIdentifier}
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
  const { t } = useI18n()
  return (
    <tr>
      <td className="py-1.5 pr-3 text-muted align-top">{label}</td>
      <td className="py-1.5 pr-3 font-mono align-top">
        {localValue ?? <span className="text-dim italic font-sans">{t.capabilityDiff.notCaptured}</span>}
      </td>
      <td className="py-1.5 pr-3 font-mono align-top">
        {remoteValue ?? <span className="text-dim italic font-sans">{t.capabilityDiff.notCaptured}</span>}
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

function effectiveAs(open: BgpOpenMessage, t: Messages): { as: number; note: string | null } {
  if (open.fourByteAs !== undefined) {
    const expected2Byte = open.fourByteAs > 0xffff ? AS_TRANS : open.fourByteAs
    const consistent = open.myAs === expected2Byte
    return {
      as: open.fourByteAs,
      note: consistent
        ? null
        : t.capabilityDiff.asMismatchNote(open.myAs, expected2Byte),
    }
  }
  return { as: open.myAs, note: null }
}

function formatAs(open: BgpOpenMessage, as: { as: number; note: string | null }, t: Messages): string {
  return open.fourByteAs !== undefined && open.fourByteAs !== open.myAs
    ? t.capabilityDiff.twoByteField(as.as, open.myAs)
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
function extractEntries(open: BgpOpenMessage, t: Messages): ExtractedEntry[] {
  const ct = t.capabilityDiff
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
      push(`UNKNOWN:${cap.code}:${hex(cap.rawValue)}`, cap.name, `Code ${cap.code}`, ct.capBytePayload(cap.length))
      continue
    }

    switch (parsed.type) {
      case 'MULTIPROTOCOL':
        push(`MP:${parsed.afi}:${parsed.safi}`, 'Multiprotocol Extensions', `${parsed.afiName} / ${parsed.safiName}`)
        break

      case 'FOUR_OCTET_AS':
        push('FOUR_OCTET_AS', '4-byte AS Number', ct.capSupport, `AS ${parsed.asNumber}`)
        break

      case 'ROUTE_REFRESH':
        push('ROUTE_REFRESH', 'Route Refresh', ct.capSupport)
        break

      case 'ENHANCED_ROUTE_REFRESH':
        push('ENHANCED_ROUTE_REFRESH', 'Enhanced Route Refresh', ct.capSupport)
        break

      case 'GRACEFUL_RESTART':
        push(
          'GRACEFUL_RESTART',
          'Graceful Restart',
          ct.capSupport,
          ct.capGrDetail(parsed.restartTime, parsed.restartFlags.toString(16).padStart(2, '0'))
        )
        for (const af of parsed.addressFamilies) {
          push(
            `GR:${af.afi}:${af.safi}`,
            'Graceful Restart',
            ct.capGrAfLabel(af.afiName, af.safiName),
            ct.capGrFlags(af.flags.toString(16).padStart(2, '0'))
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
            ct.capEnhLabel(entry.nlriAfiName, entry.nlriSafiName, entry.nexthopAfiName)
          )
        }
        break
    }
  }

  return entries
}

function buildCapabilityRows(
  localOpen: BgpOpenMessage | null,
  remoteOpen: BgpOpenMessage | null,
  t: Messages
): CapabilityRow[] {
  const localEntries = localOpen ? extractEntries(localOpen, t) : []
  const remoteEntries = remoteOpen ? extractEntries(remoteOpen, t) : []

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
  const { t } = useI18n()
  const ct = t.capabilityDiff

  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="border-b border-hair text-left text-muted">
          <th className="py-1.5 pr-3 font-medium">{ct.colCapability}</th>
          <th className="py-1.5 pr-3 font-medium">{localLabel}</th>
          <th className="py-1.5 pr-3 font-medium">{remoteLabel}</th>
          <th className="py-1.5 font-medium">{ct.colStatus}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-hair">
        {rows.map((row) => {
          const status: FieldStatus =
            row.presence === 'both'
              ? { tone: 'ok', text: ct.statusBoth }
              : row.presence === 'local-only'
                ? { tone: 'warn', text: ct.statusOnly(localLabel) }
                : { tone: 'warn', text: ct.statusOnly(remoteLabel) }

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
  const { t } = useI18n()
  return (
    <td className="py-1.5 pr-3 align-top font-mono text-xs">
      {side.present ? (
        <span className="text-body">✓ {side.detail ?? t.capabilityDiff.supported}</span>
      ) : (
        <span className="text-dim">✗ —</span>
      )}
    </td>
  )
}
