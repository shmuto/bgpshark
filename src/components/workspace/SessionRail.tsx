import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspace, type SessionSummary } from '../../context/WorkspaceContext'
import { groupFindings, alertsForPeering, type FindingGroup } from '../dashboard/findings'
import { alertLink } from '../dashboard/alert-link'
import type { AlertSeverity, DashboardAlert } from '../dashboard/types'
import { formatTimeOfDayUtc } from '../../lib/format-time'
import { useI18n } from '../../i18n'

const DOT: Record<AlertSeverity | 'none', string> = {
  critical: 'bg-critical',
  warning: 'bg-warning',
  info: 'bg-dim',
  none: 'bg-ok',
}

const STRIPE: Record<AlertSeverity, string> = {
  critical: 'bg-critical',
  warning: 'bg-warning',
  info: 'bg-hair-strong',
}

/**
 * The left-hand column of the workspace: the sessions in the capture, and what
 * went wrong in them.
 *
 * Choosing a session narrows every tab to it, so the column doubles as the
 * scope control; the findings below follow the same scope, which keeps "what is
 * wrong here" next to "where am I looking".
 */
export function SessionRail({ onNavigate }: { onNavigate?: () => void }) {
  const { sessions, alerts, scope, setScope } = useWorkspace()
  const { t } = useI18n()
  const total = sessions.reduce((sum, s) => sum + s.messages, 0)

  const scopedAlerts = useMemo(() => alertsForPeering(alerts, scope), [alerts, scope])
  const groups = useMemo(() => groupFindings(scopedAlerts), [scopedAlerts])

  const choose = (key: string | null) => {
    setScope(key)
    onNavigate?.()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <section aria-label={t.workspace.sessionsHeading} className="shrink-0 border-b border-hair pb-1.5">
        <RailHeading title={t.workspace.sessionsHeading} count={String(sessions.length)} />
        <ul className="max-h-[40vh] overflow-y-auto">
          <li>
            <button
              type="button"
              onClick={() => choose(null)}
              aria-current={scope === null}
              className={rowClass(scope === null)}
            >
              <span className="h-2 w-2 shrink-0 rounded-full bg-hair-strong" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-left">{t.workspace.allSessions}</span>
              <span className="text-[11px] tabular-nums text-dim">{total}</span>
            </button>
          </li>
          {sessions.map((session) => (
            <li key={session.key}>
              <SessionRow session={session} active={scope === session.key} onSelect={() => choose(session.key)} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={t.workspace.findingsHeading} className="flex min-h-0 flex-1 flex-col">
        <RailHeading
          title={t.workspace.findingsHeading}
          count={groups.length > 0 ? t.workspace.findingsCount(groups.length, scopedAlerts.length) : ''}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.length === 0 ? (
            <p className="px-3 py-4 text-xs text-ok">{t.workspace.noFindings}</p>
          ) : (
            <ul>
              {groups.map((group) => (
                <li key={group.key} className="border-t border-hair first:border-t-0">
                  <FindingRow group={group} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

function rowClass(active: boolean): string {
  return `flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-xs transition-colors ${
    active ? 'border-accent bg-accent-subtle text-strong' : 'border-transparent text-body hover:bg-surface-sunken'
  }`
}

function RailHeading({ title, count }: { title: string; count: string }) {
  return (
    <h2 className="flex items-baseline justify-between gap-2 px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
      {title}
      <span className="font-normal normal-case tracking-normal text-dim">{count}</span>
    </h2>
  )
}

function SessionRow({ session, active, onSelect }: { session: SessionSummary; active: boolean; onSelect: () => void }) {
  const { t } = useI18n()
  const as = (n: number | null) => (n === null ? '?' : `AS${n}`)
  return (
    <button type="button" onClick={onSelect} aria-current={active} className={`${rowClass(active)} items-start`}>
      <span
        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[session.severity ?? 'none']}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate font-mono text-[11.5px]">
          {session.ipA} ↔ {session.ipB}
        </span>
        <span className="block truncate text-[11px] text-muted">
          {as(session.asA)} ↔ {as(session.asB)} · {t.workspace.messageCount(session.messages)}
        </span>
      </span>
      {session.severity && session.severity !== 'info' && (
        <span className={`text-[11px] font-medium ${session.severity === 'critical' ? 'text-critical' : 'text-warning'}`}>
          {t.workspace.severity[session.severity]}
        </span>
      )}
    </button>
  )
}

function FindingRow({ group, onNavigate }: { group: FindingGroup; onNavigate?: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  // The worst group starts open, so the first screen names the problem and
  // the packet it is in without a click.
  const [open, setOpen] = useState(group.severity === 'critical')
  const single = group.alerts.length === 1
  const title = single ? group.alerts[0].title : t.workspace.groupTitle(group.rule, group.alerts[0].title)

  // A finding opens its evidence without changing the scope. The link's own
  // filter already narrows the list to the session, and keeping the findings
  // list as it is lets the reader step through one finding's instances —
  // narrowing to the first would hide the rest.
  const go = (alert: DashboardAlert) => {
    // `jump` asks Messages to start over from the link even when it is the
    // screen already open; see MessagesPage.
    navigate(alertLink(alert), { state: { jump: Date.now() } })
    onNavigate?.()
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => (single ? go(group.alerts[0]) : setOpen(!open))}
        aria-expanded={single ? undefined : open}
        className="grid w-full grid-cols-[3px_1fr_auto] items-start gap-x-2.5 py-2 pl-2.5 pr-3 text-left hover:bg-surface-sunken"
      >
        <span className={`self-stretch rounded-full ${STRIPE[group.severity]}`} aria-hidden="true" />
        <span className="min-w-0">
          <span className={`block text-xs leading-snug ${group.severity === 'info' ? 'text-muted' : 'font-semibold text-strong'}`}>
            <span className="sr-only">{t.workspace.severity[group.severity]}: </span>
            {title}
          </span>
          {/* The detail is the half of a finding that says what to check
              next, so it is shown rather than left to a tooltip; clamped so a
              long explanation does not push the rest of the list away. */}
          <span
            className={`mt-0.5 block text-[11px] text-muted ${single ? 'line-clamp-3' : 'truncate'}`}
            title={single ? group.alerts[0].detail : undefined}
          >
            {single ? group.alerts[0].detail : t.workspace.groupSessions(group.peerings.length)}
          </span>
        </span>
        <span className="pt-px text-[11px] tabular-nums text-dim">×{group.alerts.length}</span>
      </button>
      {!single && open && (
        <ul className="pb-1.5 pl-[22px]">
          {group.alerts.map((alert) => (
            <li key={alert.id}>
              <button
                type="button"
                onClick={() => go(alert)}
                className="group block w-full py-1 pr-3 text-left text-[11px] text-muted"
                title={alert.detail}
              >
                <span className="flex items-baseline justify-between gap-2 group-hover:text-accent">
                  <span className="min-w-0 truncate font-mono">{instanceLabel(alert, group)}</span>
                  {alert.timestamp && (
                    <span className="shrink-0 tabular-nums text-dim">{formatTimeOfDayUtc(alert.timestamp)}</span>
                  )}
                </span>
                {instanceDetail(alert, group) && (
                  <span className="mt-px block text-dim line-clamp-2">{instanceDetail(alert, group)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * What tells one instance of a group from the next. The group already says
 * what happened, so an instance only needs to say where: the session, or the
 * prefix for the route rules.
 */
function instanceLabel(alert: DashboardAlert, group: FindingGroup): string {
  if (group.rule === 'notification') return alert.detail.split(' — ')[0]
  if (alert.peering) return alert.peering.replace('|', ' ↔ ')
  // Route rules filter on the route they are about, which is the subject.
  // The summary rows ("5 more prefixes flapped") have no single route.
  const subject = alert.filter.match(/^(?:prefix|mac) = (.+)$/)?.[1]
  return subject && !alert.id.endsWith('-more') ? subject : alert.title
}

/** The detail, less whatever the label already said. */
function instanceDetail(alert: DashboardAlert, group: FindingGroup): string {
  const label = instanceLabel(alert, group)
  if (alert.detail === label) return ''
  return alert.detail.startsWith(`${label} — `) ? alert.detail.slice(label.length + 3) : alert.detail
}
