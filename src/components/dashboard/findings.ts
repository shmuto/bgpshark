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
      group = { key, rule: alert.rule, severity: alert.severity, alerts: [], peerings: [] }
      groups.set(key, group)
    }
    group.alerts.push(alert)
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

/**
 * The alerts that belong to one session.
 *
 * Findings with no session of their own (route-level and capture-wide rules)
 * are kept: a flapping prefix is still part of the story when the reader has
 * narrowed to one peering, and hiding it would make the scoped view look
 * healthier than the capture is.
 */
export function alertsForPeering(alerts: DashboardAlert[], peering: string | null): DashboardAlert[] {
  if (!peering) return alerts
  return alerts.filter((alert) => !alert.peering || alert.peering === peering)
}
