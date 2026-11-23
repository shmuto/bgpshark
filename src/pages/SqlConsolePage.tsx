import { useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { executeRawSql, isInitialized, isDataLoaded } from '../lib/db'
import { describeSchema, type SchemaTableInfo } from '../lib/db/schema'
import { useI18n, type Messages } from '../i18n'

/** Read once: the schema is fixed for the life of the app. */
const SCHEMA = describeSchema()

interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  executionTime: number
}

type TemplateKey = keyof Messages['sql']['templates']

const QUERY_TEMPLATES: { key: TemplateKey; query: string }[] = [
  {
    key: 'neighborSummary',
    query: `SELECT
  src_ip,
  dst_ip,
  COUNT(*) as packet_count
FROM packets
GROUP BY src_ip, dst_ip
ORDER BY packet_count DESC`,
  },
  {
    key: 'asPathStats',
    query: `SELECT
  asn,
  COUNT(*) as occurrence
FROM as_path
GROUP BY asn
ORDER BY occurrence DESC
LIMIT 20`,
  },
  {
    // Counts flaps the way the Routes screen does (see aggregatePrefixStats):
    // a withdraw from a peer that had the route up, or whose announce came
    // before the capture began. A re-announce is not a flap, and withdrawing
    // an already-withdrawn route is not a second one. Summing announces and
    // withdraws, as this template once did, scored a route four times what
    // the Flap column said for the same capture.
    //
    // Grouped by prefix *and* length: 10.0.12.0/24 and 10.0.12.0/23 are two
    // routes. Returned as CIDR, so the cell links straight to the route. EVPN
    // routes are left to the Routes screen: their rows do carry a prefix (the
    // formatted route) and a length of 0, so they are excluded by route type —
    // a NULL test let them through as "[2] …/0", a key no screen knows.
    key: 'prefixFlapping',
    query: `WITH events AS (
  SELECT n.prefix || '/' || n.prefix_length AS prefix, p.src_ip,
         m.frame_index, m.message_index, 0 AS step, n.id, 'announce' AS action
  FROM nlri n
  JOIN messages m ON m.id = n.message_id
  JOIN packets p ON p.frame_index = m.frame_index
  WHERE n.evpn_route_type IS NULL
  UNION ALL
  SELECT w.prefix || '/' || w.prefix_length, p.src_ip,
         m.frame_index, m.message_index, 1, w.id, 'withdraw'
  FROM withdrawn w
  JOIN messages m ON m.id = w.message_id
  JOIN packets p ON p.frame_index = m.frame_index
  WHERE w.evpn_route_type IS NULL
),
ordered AS (
  SELECT prefix, action,
         LAG(action) OVER (
           PARTITION BY prefix, src_ip
           ORDER BY frame_index, message_index, step, id
         ) AS previous
  FROM events
)
SELECT
  prefix,
  COUNT(*) FILTER (WHERE action = 'announce') AS announced,
  COUNT(*) FILTER (WHERE action = 'withdraw') AS withdrawn,
  COUNT(*) FILTER (
    WHERE action = 'withdraw' AND (previous IS NULL OR previous = 'announce')
  ) AS flaps
FROM ordered
GROUP BY prefix
HAVING flaps > 0
ORDER BY flaps DESC, prefix`,
  },
  {
    // The question a fabric raises most often: which host is being claimed by
    // more than one leaf. Two RDs for one MAC is a move if it settled, and a
    // loop if it did not.
    key: 'evpnMacMoves',
    query: `SELECT
  evpn_mac,
  COUNT(*) AS locations,
  STRING_AGG(evpn_rd, ', ') AS seen_behind
FROM (
  SELECT DISTINCT evpn_mac, evpn_rd FROM (
    SELECT evpn_mac, evpn_rd FROM nlri
    UNION ALL
    SELECT evpn_mac, evpn_rd FROM withdrawn
  )
  WHERE evpn_mac IS NOT NULL
)
GROUP BY evpn_mac
HAVING COUNT(*) > 1
ORDER BY locations DESC`,
  },
  {
    key: 'evpnRouteTargets',
    query: `SELECT
  value AS route_target,
  COUNT(*) AS routes
FROM extended_communities
WHERE kind = 'Route Target'
GROUP BY value
ORDER BY routes DESC`,
  },
  {
    key: 'errorAnalysis',
    query: `SELECT
  error_code_name,
  error_subcode_name,
  COUNT(*) as count
FROM messages
WHERE type = 'NOTIFICATION'
GROUP BY error_code_name, error_subcode_name
ORDER BY count DESC`,
  },
  {
    key: 'messageTypes',
    query: `SELECT
  type,
  COUNT(*) as count
FROM messages
GROUP BY type
ORDER BY count DESC`,
  },
]

export function SqlConsolePage() {
  useApp() // Ensure context is available
  const { t } = useI18n()
  const st = t.sql
  const [query, setQuery] = useState(QUERY_TEMPLATES[0].query)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [queryHistory, setQueryHistory] = useState<string[]>([])
  const editorRef = useRef<HTMLTextAreaElement>(null)

  /**
   * Puts a table or column name where the cursor is, so the schema panel can
   * be used to write a query rather than only to read one off.
   */
  const insertAtCursor = useCallback((text: string) => {
    const editor = editorRef.current
    if (!editor) {
      setQuery((q) => q + text)
      return
    }
    const start = editor.selectionStart ?? editor.value.length
    const end = editor.selectionEnd ?? start
    const next = editor.value.slice(0, start) + text + editor.value.slice(end)
    setQuery(next)
    requestAnimationFrame(() => {
      editor.focus()
      editor.setSelectionRange(start + text.length, start + text.length)
    })
  }, [])

  // Two distinct failure states: the database never came up, or it is up but
  // the capture's packets never made it in. Querying in the second state
  // "works" and returns zero rows for everything, so it is blocked the same
  // way — just with a different explanation.
  const dbReady = isInitialized()
  const dataLoaded = isDataLoaded()
  const sqlUsable = dbReady && dataLoaded

  const handleExecute = useCallback(async () => {
    if (!query.trim() || !sqlUsable) return

    setIsExecuting(true)
    setError(null)
    const startTime = performance.now()

    try {
      const sqlResult = await executeRawSql(query)
      const executionTime = performance.now() - startTime

      // A failed query is not an empty result set: show the message DuckDB gave
      // us, and keep the query out of the history of things that worked.
      if (!sqlResult.ok) {
        setError(sqlResult.error)
        setResult(null)
        return
      }

      setResult({
        columns: sqlResult.columns,
        rows: sqlResult.rows,
        executionTime,
      })

      // Add to history
      setQueryHistory(prev => {
        const newHistory = [query, ...prev.filter(q => q !== query)].slice(0, 10)
        return newHistory
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : st.queryFailed)
      setResult(null)
    } finally {
      setIsExecuting(false)
    }
  }, [query, sqlUsable, st.queryFailed])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      handleExecute()
    }
  }

  const handleTemplateClick = (template: typeof QUERY_TEMPLATES[0]) => {
    setQuery(template.query)
  }

  const handleHistoryClick = (q: string) => {
    setQuery(q)
  }

  const exportCsv = () => {
    if (!result) return

    const headers = result.columns.join(',')
    const rows = result.rows.map(row =>
      result.columns.map(col => {
        const val = row[col]
        if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
          return `"${val.replace(/"/g, '""')}"`
        }
        return String(val ?? '')
      }).join(',')
    )
    const csv = [headers, ...rows].join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'query-result.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-canvas p-2 gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-strong">{st.title}</h1>
        </div>
        {!dbReady && (
          <span className="text-xs text-warning">
            {st.duckdbNotInitialized}
          </span>
        )}
        {dbReady && !dataLoaded && (
          <span className="text-xs text-warning">
            {st.duckdbUnavailable}
          </span>
        )}
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-2 min-h-0 overflow-auto lg:overflow-visible">
        {/* Main Editor Area */}
        <div className="flex-1 flex flex-col gap-2 min-h-0">
          {/* SQL Editor */}
          <div className="bg-surface border border-hair flex flex-col shrink-0">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between">
              <span className="text-xs font-medium text-strong">{st.queryHeading}</span>
              <span className="text-xs text-muted">{st.shortcutHint}</span>
            </div>
            {/* Ten rows by default, so the opening template is readable without
                scrolling; the handle in the corner makes it taller. */}
            <textarea
              ref={editorRef}
              rows={10}
              aria-label={st.editorAria}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="SELECT * FROM packets LIMIT 10"
              className="p-4 font-mono text-xs resize-y min-h-[8rem] max-h-[70vh] focus:outline-none bg-surface-sunken text-body"
              disabled={!sqlUsable}
            />
            <div className="px-4 py-2 border-t border-hair bg-surface-sunken flex items-center gap-3">
              <button
                onClick={handleExecute}
                disabled={!sqlUsable || isExecuting || !query.trim()}
                className="px-4 py-1.5 bg-accent text-accent-fg text-xs rounded hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <span>▶</span>
                {isExecuting ? st.running : st.run}
              </button>
              <button
                onClick={() => setQuery('')}
                className="px-3 py-1.5 text-xs text-muted hover:bg-surface-raised rounded"
              >
                {st.clear}
              </button>
              {result && (
                <span className="text-xs text-muted ml-auto">
                  {st.executionTime(result.executionTime.toFixed(0))}
                </span>
              )}
            </div>
          </div>

          {/* Results */}
          <div className="flex-1 bg-surface border border-hair flex flex-col min-h-[12rem]">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between shrink-0">
              <span className="text-xs font-medium text-strong">
                {st.resultsHeading(result?.rows.length)}
              </span>
              {result && result.rows.length > 0 && (
                <button
                  onClick={exportCsv}
                  className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                >
                  {st.exportCsv}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              {error ? (
                <div className="p-4 text-critical text-xs">
                  <div className="font-medium mb-1">{st.errorPrefix}</div>
                  <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
                </div>
              ) : result ? (
                result.rows.length > 0 ? (
                  <table className="w-full text-xs">
                    <thead className="bg-surface-sunken sticky top-0">
                      <tr>
                        {result.columns.map((col) => (
                          <th key={col} className="px-4 py-2 text-left font-medium text-muted border-b border-hair">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hair">
                      {result.rows.slice(0, 100).map((row, idx) => (
                        <tr key={idx} className="hover:bg-surface-sunken">
                          {result.columns.map((col) => (
                            <td key={col} className="px-4 py-2 font-mono text-body">
                              <ResultCell column={col} row={row} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="text-center text-dim py-8">
                    {st.noResults}
                  </div>
                )
              ) : (
                <div className="text-center text-dim py-8">
                  {st.runPrompt}
                </div>
              )}
              {result && result.rows.length > 100 && (
                <div className="text-center text-muted text-xs py-2 border-t border-hair">
                  {st.showingFirst100(result.rows.length)}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar - drops below the editor when there is no room beside it */}
        {/* Scrolls on its own: with the full schema expanded it is taller
            than the window, and squeezing the cards to fit made them overlap. */}
        <div className="w-full lg:w-72 flex flex-col gap-2 shrink-0 lg:min-h-0 lg:overflow-y-auto">
          {/* Templates */}
          <div className="bg-surface border border-hair shrink-0">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken">
              <span className="text-xs font-medium text-strong">{st.templatesHeading}</span>
            </div>
            <div className="p-2" data-testid="query-templates">
              {QUERY_TEMPLATES.map((template) => (
                <button
                  key={template.key}
                  onClick={() => handleTemplateClick(template)}
                  className="w-full text-left px-3 py-2 text-xs text-body hover:bg-surface-sunken rounded"
                >
                  {st.templates[template.key]}
                </button>
              ))}
            </div>
          </div>

          {/* History */}
          {queryHistory.length > 0 && (
            <div className="bg-surface border border-hair flex flex-col shrink-0">
              <div className="px-4 py-2 border-b border-hair bg-surface-sunken shrink-0">
                <span className="text-xs font-medium text-strong">{st.historyHeading}</span>
              </div>
              <div className="max-h-48 overflow-auto p-2">
                {queryHistory.map((q, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleHistoryClick(q)}
                    className="w-full text-left px-3 py-2 text-xs font-mono text-muted hover:bg-surface-sunken rounded truncate"
                    title={q}
                  >
                    {q.slice(0, 50)}...
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Schema */}
          <div className="bg-surface border border-hair shrink-0">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-strong">{st.schemaHeading}</span>
              <span className="text-xs text-dim">{st.schemaHint}</span>
            </div>
            <div className="p-2 text-xs text-muted space-y-1" data-testid="schema">
              {SCHEMA.map((table) => (
                <SchemaTable key={table.name} table={table} onInsert={insertAtCursor} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SchemaTable({ table, onInsert }: { table: SchemaTableInfo; onInsert: (text: string) => void }) {
  const { t } = useI18n()
  const st = t.sql
  const [expanded, setExpanded] = useState(false)

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={expanded ? st.collapseTableAria(table.name) : st.expandTableAria(table.name)}
          className="w-4 text-dim hover:text-accent"
        >
          {expanded ? '▼' : '▶'}
        </button>
        <button
          type="button"
          onClick={() => onInsert(table.name)}
          title={st.insertTitle(table.name)}
          className="font-medium font-mono text-body hover:text-accent"
        >
          {table.name}
        </button>
        <span className="text-dim">({table.columns.length})</span>
      </div>
      {expanded && (
        <div className="ml-5">
          {table.columns.map((column) => (
            <button
              key={column.name}
              type="button"
              onClick={() => onInsert(column.name)}
              title={st.insertTitle(column.name)}
              className="w-full flex items-baseline justify-between gap-2 px-1 rounded hover:bg-surface-sunken"
            >
              <span className="font-mono text-body">{column.name}</span>
              <span className="text-dim">{column.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A result cell, linked onward when its column names something another screen
 * can open: a `frame_index` opens that frame in Messages (All Packets, so a
 * frame without BGP is reachable too), a `prefix` opens its route history.
 * The round trip from "this row looks wrong" to the packet itself is the
 * point of a query here.
 */
function ResultCell({ column, row }: { column: string; row: Record<string, unknown> }) {
  const { t } = useI18n()
  const value = row[column]
  const text = formatValue(value)
  if (value === null || value === undefined) return <>{text}</>

  if (column === 'frame_index' && /^\d+$/.test(text)) {
    return (
      <Link
        to={`/messages?frame=${text}&all=1`}
        title={t.sql.openFrameTitle(text)}
        className="text-accent hover:text-accent-hover hover:underline"
      >
        {text}
      </Link>
    )
  }
  if (column === 'prefix' && /^[0-9a-f:.]+(\/\d+)?$/i.test(text)) {
    // The tables store the address and its length in separate columns. With
    // both in the row the route is named exactly. With the address alone the
    // routes screen is searched for the routes that *cover* it: a bare
    // 10.0.12.0 under the default Subnets match reads as 10.0.12.0/32 and
    // finds nothing, while Supernets finds 10.0.12.0/24.
    const length = row.prefix_length
    const route = text.includes('/') ? text : length != null ? `${text}/${String(length)}` : null
    const to = route
      ? `/routes?prefix=${encodeURIComponent(route)}`
      : `/routes?q=${encodeURIComponent(text)}&match=supernets`
    return (
      <Link
        to={to}
        title={t.sql.openRouteTitle(text)}
        className="text-accent hover:text-accent-hover hover:underline"
      >
        {text}
      </Link>
    )
  }
  return <>{text}</>
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
