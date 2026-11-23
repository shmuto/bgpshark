import type { AlertRule, AlertSeverity, DashboardAlert } from './types'

/**
 * Alerts folded into one row per kind of problem.
 *
 * The rule engine reports one row per problem *instance*, which is right for
 * evidence and wrong for a summary: a single hard reset on a router with three
 * sessions comes out as three NOTIFICATION rows, three collision rows in each
 * direction and three session-flap rows — sixteen lines for one event on the
 * bundled sample. Grouping by kind turns that into four, each still opening
 * onto its instances.
 */
export interface FindingGroup {
  key: string
  rule: AlertRule
  /** The worst severity among the instances, which is how the group ranks. */
  severity: AlertSeverity
  alerts: DashboardAlert[]
  /**
   * Occurrences the group stands for: each alert's `count`, or one. This is
   * what a finding's ×N badge shows and what the heading totals, so the two
   * cannot disagree — the heading once counted rows ("16") above badges that
   * summed to 18.
   */
  occurrences: number
  /** Sessions the group touches, as `sortedPairKey` writes them. */
  peerings: string[]
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }

export function groupFindings(alerts: DashboardAlert[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>()
  for (const alert of alerts) {
    const key = alert.groupKey ?? alert.rule
    let group = groups.get(key)
    if (!group) {
      group = { key, rule: alert.rule, severity: alert.severity, alerts: [], occurrences: 0, peerings: [] }
      groups.set(key, group)
    }
    group.alerts.push(alert)
    group.occurrences += alert.count ?? 1
    if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[group.severity]) group.severity = alert.severity
    if (alert.peering && !group.peerings.includes(alert.peering)) group.peerings.push(alert.peering)
  }

  // Alerts arrive sorted worst first, so a stable sort on severity keeps the
  // engine's own ordering within a tier; the instance count breaks ties so the
  // widest problem leads.
  return Array.from(groups.values()).sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.alerts.length - a.alerts.length
  )
}
