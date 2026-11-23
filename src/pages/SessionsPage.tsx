import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useWorkspace, type SessionSummary } from '../context/WorkspaceContext'
import { CapabilityDiff } from '../components/neighbor'
import { extractSessionEvents, groupEventsBySession, type SessionState } from '../lib/bgp/session-events'
import { peeringKey } from '../lib/bgp/peering'
import { countUpdatePrefixes, endOfRibMarker } from '../lib/bgp/update'
import type { BgpMessageTypeName, BgpNotificationMessage, BgpOpenMessage, BgpPacket, BgpUpdateMessage } from '../lib/bgp/types'
import { formatDelta, formatTimeOfDayUtc } from '../lib/format-time'
import { useI18n } from '../i18n'

const STATE_TONE: Record<SessionState, string> = {
  Established: 'text-ok',
  Down: 'text-critical',
  Idle: 'text-muted',
  Connect: 'text-warning',
  OpenSent: 'text-warning',
  OpenConfirm: 'text-warning',
}

const TYPE_TONE: Record<BgpMessageTypeName, string> = {
  OPEN: 'text-bgp-open',
  UPDATE: 'text-bgp-update',
  NOTIFICATION: 'text-bgp-notification',
  KEEPALIVE: 'text-bgp-keepalive',
  ROUTE_REFRESH: 'text-bgp-route-refresh',
}

type Counts = Record<BgpMessageTypeName, number>

interface SessionFacts {
  counts: Counts
  state: SessionState | null
}

function emptyCounts(): Counts {
  return { OPEN: 0, UPDATE: 0, NOTIFICATION: 0, KEEPALIVE: 0, ROUTE_REFRESH: 0 }
}

/** Message counts and end-of-capture state for every session, in one pass. */
function useSessionFacts(packets: BgpPacket[]): Map<string, SessionFacts> {
  return useMemo(() => {
    const facts = new Map<string, SessionFacts>()
    for (const packet of packets) {
      const key = peeringKey(packet.srcIp, packet.dstIp)
      let entry = facts.get(key)
      if (!entry) {
        entry = { counts: emptyCounts(), state: null }
        facts.set(key, entry)
      }
      for (const msg of packet.messages) entry.counts[msg.type]++
    }
    for (const track of groupEventsBySession(extractSessionEvents(packets)).values()) {
      const entry = facts.get(peeringKey(track.srcIp, track.dstIp))
      if (entry) entry.state = track.currentState
    }
    return facts
  }, [packets])
}

/**
 * The Sessions tab.
 *
 * A session — a pair of addresses — is what a NOTIFICATION, a hold timer or a
 * capability mismatch belongs to, so it is the unit here. The old Neighbors
 * screen grouped by Router ID first and made the reader pick a router and then
 * one of its sessions before the OPEN comparison appeared. Now the session is
 * chosen once, in the workspace column, and this tab opens straight onto it;
 * with no session chosen it lists them all so one can be picked here as well.
 */
export function SessionsPage() {
  const { packets } = useApp()
  const { sessions, scope, setScope } = useWorkspace()
  const facts = useSessionFacts(packets)

  const session = scope ? sessions.find((s) => s.key === scope) : undefined
  if (session) return <SessionDetail session={session} facts={facts.get(session.key)} />
  return <SessionTable sessions={sessions} facts={facts} onSelect={setScope} />
}

function SessionTable({
  sessions,
  facts,
  onSelect,
}: {
  sessions: SessionSummary[]
  facts: Map<string, SessionFacts>
  onSelect: (key: string) => void
}) {
  const { t } = useI18n()
  const st = t.sessions
  const num = 'px-3 py-1.5 text-right font-mono tabular-nums'

  return (
    <div className="flex-1 overflow-auto bg-surface">
      <div className="flex items-baseline justify-between gap-3 border-b border-hair px-4 py-2.5">
        <h1 className="text-sm font-semibold text-strong">{st.title}</h1>
        <span className="text-xs text-muted">{st.pickHint}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-sunken text-left text-muted">
            <tr>
              <th className="px-4 py-1.5 font-medium">{st.colSession}</th>
              <th className="px-3 py-1.5 font-medium">{st.colAs}</th>
              <th className="px-3 py-1.5 font-medium" title={st.stateAtEndTitle}>{st.colState}</th>
              <th className={`${num} font-medium`}>OPEN</th>
              <th className={`${num} font-medium`}>UPDATE</th>
              <th className={`${num} font-medium`}>NOTIF</th>
              <th className={`${num} font-medium`}>KEEPALIVE</th>
              <th className="px-4 py-1.5 font-medium">{st.colFindings}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hair">
            {sessions.map((s) => {
              const f = facts.get(s.key)
              const c = f?.counts ?? emptyCounts()
              return (
                <tr key={s.key} onClick={() => onSelect(s.key)} className="cursor-pointer hover:bg-surface-sunken">
                  <td className="whitespace-nowrap px-4 py-1.5 font-mono text-strong">
                    {s.ipA} ↔ {s.ipB}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted">
                    {asPair(s)} <span className="font-sans text-dim">· {kind(s, st)}</span>
                  </td>
                  <td className={`px-3 py-1.5 ${f?.state ? STATE_TONE[f.state] : 'text-dim'}`}>{f?.state ?? '—'}</td>
                  <td className={num}>{c.OPEN}</td>
                  <td className={num}>{c.UPDATE}</td>
                  <td className={`${num} ${c.NOTIFICATION ? 'text-critical' : ''}`}>{c.NOTIFICATION}</td>
                  <td className={`${num} text-dim`}>{c.KEEPALIVE}</td>
                  <td className="whitespace-nowrap px-4 py-1.5">
                    {s.severity && s.severity !== 'info' ? (
                      <span className={s.severity === 'critical' ? 'text-critical' : 'text-warning'}>
                        {t.workspace.severity[s.severity]}
                      </span>
                    ) : (
                      <span className="text-ok">{st.healthy}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {sessions.length === 0 && <p className="px-4 py-8 text-center text-sm text-dim">{st.none}</p>}
      </div>
    </div>
  )
}

function asPair(s: SessionSummary): string {
  const as = (n: number | null) => (n === null ? '?' : `AS${n}`)
  return `${as(s.asA)} ↔ ${as(s.asB)}`
}

function kind(s: SessionSummary, st: { ibgp: string; ebgp: string; unknownKind: string }): string {
  if (s.asA === null || s.asB === null) return st.unknownKind
  return s.asA === s.asB ? st.ibgp : st.ebgp
}

interface EventRow {
  packetIndex: number
  timestamp: Date
  srcIp: string
  dstIp: string
  type: BgpMessageTypeName
  detail: string
}

function SessionDetail({ session, facts }: { session: SessionSummary; facts: SessionFacts | undefined }) {
  const { packets } = useApp()
  const { t } = useI18n()
  const st = t.sessions
  const navigate = useNavigate()
  /**
   * The events that establish or end a session by default. The rest is what
   * was flowing while it was up — which is the question when a hold timer
   * expires, because the keepalives stopping is the evidence.
   */
  const [showAll, setShowAll] = useState(false)

  const { ipA, ipB } = session

  // Indexed against the whole capture so a row can link to its packet. The
  // OPEN comparison reads the latest OPEN in each direction over the whole
  // capture too: what was negotiated does not change with the time window.
  const { events, openA, openB, prefixes } = useMemo(() => {
    const events: EventRow[] = []
    let openA = null as BgpOpenMessage | null
    let openB = null as BgpOpenMessage | null
    const prefixes = { fromA: { announced: 0, withdrawn: 0 }, fromB: { announced: 0, withdrawn: 0 } }

    packets.forEach((packet, packetIndex) => {
      if (peeringKey(packet.srcIp, packet.dstIp) !== session.key) return
      const fromA = packet.srcIp === ipA
      for (const msg of packet.messages) {
        let detail = ''
        if (msg.type === 'OPEN') {
          const open = msg as BgpOpenMessage
          if (fromA) openA = open
          else openB = open
          detail = `AS${open.fourByteAs ?? open.myAs} · Hold ${open.holdTime}s · ID ${open.bgpIdentifier}`
        } else if (msg.type === 'UPDATE') {
          const update = msg as BgpUpdateMessage
          const { announced, withdrawn } = countUpdatePrefixes(update)
          const side = fromA ? prefixes.fromA : prefixes.fromB
          side.announced += announced
          side.withdrawn += withdrawn
          const eor = endOfRibMarker(update)
          const parts = []
          if (announced > 0) parts.push(t.messages.updateAnnouncedCount(announced))
          if (withdrawn > 0) parts.push(t.messages.updateWithdrawnCount(withdrawn))
          detail = eor ? `End-of-RIB (${eor})` : parts.join(', ') || t.messages.updateEmpty
        } else if (msg.type === 'NOTIFICATION') {
          const notif = msg as BgpNotificationMessage
          detail = `${notif.errorCodeName}: ${notif.errorSubcodeName}`
        } else if (msg.type === 'ROUTE_REFRESH') {
          detail = `${msg.afiName}/${msg.safiName}`
        }
        events.push({ packetIndex, timestamp: packet.timestamp, srcIp: packet.srcIp, dstIp: packet.dstIp, type: msg.type, detail })
      }
    })
    return { events, openA, openB, prefixes }
  }, [packets, session.key, ipA, t])

  const visible = showAll ? events : events.filter((e) => e.type === 'OPEN' || e.type === 'NOTIFICATION')
  const counts = facts?.counts ?? emptyCounts()
  const holdTime = openA && openB ? Math.min(openA.holdTime, openB.holdTime) : null

  const openPacket = (packetIndex: number) =>
    navigate(`/messages?selected=${packetIndex}`, { state: { jump: Date.now() } })

  return (
    <div className="flex-1 overflow-auto bg-surface">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-hair px-4 py-3">
        <h1 className="font-mono text-base font-semibold text-strong">
          {ipA} ↔ {ipB}
        </h1>
        <span className="text-xs text-muted">
          <span className="font-mono">{asPair(session)}</span> · {kind(session, st)}
        </span>
      </header>

      <dl className="flex flex-wrap gap-x-8 gap-y-2 border-b border-hair px-4 py-2.5 text-xs">
        <Stat label={st.colState} title={st.stateAtEndTitle}>
          <span className={facts?.state ? STATE_TONE[facts.state] : 'text-dim'}>{facts?.state ?? '—'}</span>
        </Stat>
        <Stat label={st.statHold}>{holdTime !== null ? `${holdTime}s` : '—'}</Stat>
        <Stat label="NOTIFICATION">
          <span className={counts.NOTIFICATION ? 'text-critical' : ''}>{counts.NOTIFICATION}</span>
        </Stat>
        <Stat label={st.statMessages}>{Object.values(counts).reduce((a, b) => a + b, 0)}</Stat>
        <Stat label={st.statPrefixes(ipA)} title={st.prefixActivityTitle}>
          <PrefixCounts {...prefixes.fromA} />
        </Stat>
        <Stat label={st.statPrefixes(ipB)} title={st.prefixActivityTitle}>
          <PrefixCounts {...prefixes.fromB} />
        </Stat>
        <div className="ml-auto flex items-center gap-4 self-center">
          <button type="button" onClick={() => navigate('/routes')} className="text-accent hover:text-accent-hover">
            {st.openRoutes}
          </button>
          <button
            type="button"
            onClick={() => navigate('/messages', { state: { fresh: true } })}
            className="text-accent hover:text-accent-hover"
          >
            {st.openMessages}
          </button>
        </div>
      </dl>

      <section className="border-b border-hair px-4 py-3">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{st.capabilityDiff}</h2>
        <CapabilityDiff localLabel={ipA} remoteLabel={ipB} localOpen={openA} remoteOpen={openB} />
      </section>

      <section className="px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {st.events(visible.length)}
          </h2>
          <div className="flex items-center gap-1 text-xs" role="group" aria-label={st.eventsScopeAria}>
            {([false, true] as const).map((all) => (
              <button
                key={String(all)}
                type="button"
                aria-pressed={showAll === all}
                onClick={() => setShowAll(all)}
                className={`rounded px-2 py-0.5 ${showAll === all ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-sunken'}`}
              >
                {all ? st.scopeAll(events.length) : st.scopeEvents}
              </button>
            ))}
          </div>
        </div>
        <ol className="divide-y divide-hair border-y border-hair">
          {visible.map((e, i) => (
            <li key={`${e.packetIndex}-${i}`}>
              <button
                type="button"
                onClick={() => openPacket(e.packetIndex)}
                className="grid w-full grid-cols-[6.5rem_5rem_9.5rem_1fr] items-baseline gap-3 px-1 py-1 text-left text-xs hover:bg-surface-sunken max-md:grid-cols-[5.5rem_1fr]"
              >
                <span className="font-mono tabular-nums text-muted">{formatTimeOfDayUtc(e.timestamp)}</span>
                <span className="font-mono tabular-nums text-dim max-md:hidden" title={st.timeSincePrevTitle}>
                  {i > 0 ? formatDelta(e.timestamp.getTime() - visible[i - 1].timestamp.getTime()) : ''}
                </span>
                <span className="truncate font-mono text-muted max-md:hidden">
                  {e.srcIp === ipA ? '→' : '←'} {e.srcIp}
                </span>
                <span className="min-w-0 truncate">
                  <span className={`font-mono font-medium ${TYPE_TONE[e.type]}`}>{e.type}</span>
                  {e.detail && <span className="ml-2 text-muted">{e.detail}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function Stat({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div title={title}>
      <dt className="text-[10.5px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="font-mono tabular-nums text-strong">{children}</dd>
    </div>
  )
}

function PrefixCounts({ announced, withdrawn }: { announced: number; withdrawn: number }) {
  return (
    <>
      <span className="text-ok">+{announced}</span>
      <span className="mx-1 text-dim">/</span>
      <span className={withdrawn ? 'text-critical' : 'text-dim'}>−{withdrawn}</span>
    </>
  )
}
