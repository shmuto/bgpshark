import { useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { executeRawSql, isInitialized, isDataLoaded } from '../lib/db'
import { describeSchema, type SchemaTableInfo } from '../lib/db/schema'

/** Read once: the schema is fixed for the life of the app. */
const SCHEMA = describeSchema()

interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  executionTime: number
}

const QUERY_TEMPLATES = [
  {
    name: 'Neighbor Summary',
    query: `SELECT
  src_ip,
  dst_ip,
  COUNT(*) as packet_count
FROM packets
GROUP BY src_ip, dst_ip
ORDER BY packet_count DESC`,
  },
  {
    name: 'AS_PATH Stats',
    query: `SELECT
  asn,
  COUNT(*) as occurrence
FROM as_path
GROUP BY asn
ORDER BY occurrence DESC
LIMIT 20`,
  },
  {
    // Grouped by prefix *and* length: 10.0.12.0/24 and 10.0.12.0/23 are two
    // routes. Returned as CIDR, so the cell links straight to the route.
    name: 'Prefix Flapping',
    query: `SELECT
  prefix,
  COUNT(*) as flap_count
FROM (
  SELECT COALESCE(prefix || '/' || prefix_length, prefix) AS prefix FROM nlri
  UNION ALL
  SELECT COALESCE(prefix || '/' || prefix_length, prefix) AS prefix FROM withdrawn
)
GROUP BY prefix
HAVING COUNT(*) > 5
ORDER BY flap_count DESC`,
  },
  {
    // The question a fabric raises most often: which host is being claimed by
    // more than one leaf. Two RDs for one MAC is a move if it settled, and a
    // loop if it did not.
    name: 'EVPN MAC Moves',
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
    name: 'EVPN Route Targets',
    query: `SELECT
  value AS route_target,
  COUNT(*) AS routes
FROM extended_communities
WHERE kind = 'Route Target'
GROUP BY value
ORDER BY routes DESC`,
  },
  {
    name: 'Error Analysis',
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
    name: 'Message Types',
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
      setError(err instanceof Error ? err.message : 'Query execution failed')
      setResult(null)
    } finally {
      setIsExecuting(false)
    }
  }, [query, sqlUsable])

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
    <div className="flex-1 flex flex-col min-h-0 bg-canvas p-4 gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-strong">SQL Console</h1>
        </div>
        {!dbReady && (
          <span className="text-sm text-warning">
            ⚠ DuckDB not initialized. Load a pcap file first.
          </span>
        )}
        {dbReady && !dataLoaded && (
          <span className="text-sm text-warning">
            ⚠ This capture could not be loaded into DuckDB, so SQL is unavailable. Filtering on
            the other screens still works in-memory.
          </span>
        )}
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0 overflow-auto lg:overflow-visible">
        {/* Main Editor Area */}
        <div className="flex-1 flex flex-col gap-4 min-h-0">
          {/* SQL Editor */}
          <div className="bg-surface rounded-lg shadow-sm border border-hair flex flex-col shrink-0">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between">
              <span className="text-sm font-medium text-strong">Query</span>
              <span className="text-xs text-muted">Ctrl+Enter to execute</span>
            </div>
            {/* Ten rows by default, so the opening template is readable without
                scrolling; the handle in the corner makes it taller. */}
            <textarea
              ref={editorRef}
              rows={10}
              aria-label="SQL query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="SELECT * FROM packets LIMIT 10"
              className="p-4 font-mono text-sm resize-y min-h-[8rem] max-h-[70vh] focus:outline-none bg-surface-sunken text-body"
              disabled={!sqlUsable}
            />
            <div className="px-4 py-2 border-t border-hair bg-surface-sunken flex items-center gap-3">
              <button
                onClick={handleExecute}
                disabled={!sqlUsable || isExecuting || !query.trim()}
                className="px-4 py-1.5 bg-accent text-accent-fg text-sm rounded hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <span>▶</span>
                {isExecuting ? 'Running...' : 'Run'}
              </button>
              <button
                onClick={() => setQuery('')}
                className="px-3 py-1.5 text-sm text-muted hover:bg-surface-raised rounded"
              >
                Clear
              </button>
              {result && (
                <span className="text-xs text-muted ml-auto">
                  Execution: {result.executionTime.toFixed(0)}ms
                </span>
              )}
            </div>
          </div>

          {/* Results */}
          <div className="flex-1 bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-[12rem]">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between shrink-0">
              <span className="text-sm font-medium text-strong">
                Results {result ? `(${result.rows.length} rows)` : ''}
              </span>
              {result && result.rows.length > 0 && (
                <button
                  onClick={exportCsv}
                  className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                >
                  Export CSV ↓
                </button>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              {error ? (
                <div className="p-4 text-critical text-sm">
                  <div className="font-medium mb-1">Error:</div>
                  <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
                </div>
              ) : result ? (
                result.rows.length > 0 ? (
                  <table className="w-full text-sm">
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
                    Query returned no results
                  </div>
                )
              ) : (
                <div className="text-center text-dim py-8">
                  Run a query to see results
                </div>
              )}
              {result && result.rows.length > 100 && (
                <div className="text-center text-muted text-xs py-2 border-t border-hair">
                  Showing first 100 of {result.rows.length} rows
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar - drops below the editor when there is no room beside it */}
        {/* Scrolls on its own: with the full schema expanded it is taller
            than the window, and squeezing the cards to fit made them overlap. */}
        <div className="w-full lg:w-72 flex flex-col gap-4 shrink-0 lg:min-h-0 lg:overflow-y-auto">
          {/* Templates */}
          <div className="bg-surface rounded-lg shadow-sm border border-hair shrink-0">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken">
              <span className="text-sm font-medium text-strong">Query Templates</span>
            </div>
            <div className="p-2" data-testid="query-templates">
              {QUERY_TEMPLATES.map((template) => (
                <button
                  key={template.name}
                  onClick={() => handleTemplateClick(template)}
                  className="w-full text-left px-3 py-2 text-sm text-body hover:bg-surface-sunken rounded"
                >
                  {template.name}
                </button>
              ))}
            </div>
          </div>

          {/* History */}
          {queryHistory.length > 0 && (
            <div className="bg-surface rounded-lg shadow-sm border border-hair flex flex-col shrink-0">
              <div className="px-4 py-2 border-b border-hair bg-surface-sunken shrink-0">
                <span className="text-sm font-medium text-strong">Query History</span>
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
          <div className="bg-surface rounded-lg shadow-sm border border-hair shrink-0">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-strong">Schema</span>
              <span className="text-xs text-dim">click a name to insert it</span>
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
  const [expanded, setExpanded] = useState(false)

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${table.name}`}
          className="w-4 text-dim hover:text-accent"
        >
          {expanded ? '▼' : '▶'}
        </button>
        <button
          type="button"
          onClick={() => onInsert(table.name)}
          title={`Insert ${table.name}`}
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
              title={`Insert ${column.name}`}
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
  const value = row[column]
  const text = formatValue(value)
  if (value === null || value === undefined) return <>{text}</>

  if (column === 'frame_index' && /^\d+$/.test(text)) {
    return (
      <Link
        to={`/messages?frame=${text}&all=1`}
        title={`Open frame ${text} in Messages`}
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
        title={`Open the route history of ${text}`}
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
