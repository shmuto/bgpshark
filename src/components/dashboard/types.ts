/**
 * `info` is for findings that are worth knowing but describe BGP working as
 * designed — a connection collision resolved by Cease/7 is the case that
 * introduced it. They are listed last and never colour a session as faulty.
 */
export type AlertSeverity = 'critical' | 'warning' | 'info'

/** Which rule produced an alert, so the findings list can group like with like. */
export type AlertRule =
  | 'one-direction'
  | 'no-reply'
  | 'silent-teardown'
  | 'graceful-restart'
  | 'notification'
  | 'session-flap'
  | 'withdraw-burst'
  | 'route-flap'
  | 'route-aspath'
  | 'route-macmove'
  | 'transport'

export interface DashboardAlert {
  id: string
  rule: AlertRule
  /**
   * Alerts sharing this key are one finding. Defaults to `rule`; set where a
   * rule produces distinct kinds of fault, such as one NOTIFICATION code
   * against another.
   */
  groupKey?: string
  /**
   * The session (as `sortedPairKey` writes it) the alert is about, for every
   * rule that has one. Unlike `pairKey` this says nothing about whether the
   * session came up; it only lets the workspace scope findings to a session.
   */
  peering?: string
  severity: AlertSeverity
  title: string
  detail: string
  /** The occurrence this row links to. For a grouped row that is the earliest one. */
  timestamp: Date | null
  filter: string
  packetIndex?: number
  /**
   * Occurrences rolled into this row. Absent or 1 is a single event and is
   * rendered exactly as an ungrouped alert — no count, no time range.
   */
  count?: number
  /** First and last occurrence, set only when the row stands for more than one. */
  timeSpan?: { start: Date; end: Date }
  /**
   * The peer pair this row is about, as `sortedPairKey` writes it. Set only by
   * the rules that judge a whole session rather than a message, so the
   * neighbour table can mark the same pair without deriving the finding twice.
   */
  pairKey?: string
  /**
   * A frame to select by its `frameIndex`, for rows whose evidence is not a BGP
   * message. `packetIndex` cannot address one: it indexes the BGP packet array,
   * and an RST carries no BGP at all.
   */
  frameIndex?: number
  /**
   * Ask the explorer to open on **All Packets**. The list shows BGP only by
   * default, so a row pointing at a TCP frame would otherwise land the reader
   * on a list that cannot contain the thing it just named.
   */
  showAllPackets?: boolean
}
