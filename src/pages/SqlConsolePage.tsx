import { useState, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { executeRawSql, isInitialized } from '../lib/db'

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
    name: 'Prefix Flapping',
    query: `SELECT
  prefix,
  COUNT(*) as flap_count
FROM (
  SELECT prefix FROM nlri
  UNION ALL
  SELECT prefix FROM withdrawn
)
GROUP BY prefix
HAVING COUNT(*) > 5
ORDER BY flap_count DESC`,
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

  const dbReady = isInitialized()

  const handleExecute = useCallback(async () => {
    if (!query.trim() || !dbReady) return

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
  }, [query, dbReady])

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
          <span>💾</span>
          <h1 className="text-lg font-semibold text-strong">SQL Console</h1>
        </div>
        {!dbReady && (
          <span className="text-sm text-warning">
            ⚠️ DuckDB not initialized. Load a pcap file first.
          </span>
        )}
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0 overflow-auto lg:overflow-visible">
        {/* Main Editor Area */}
        <div className="flex-1 flex flex-col gap-4 min-h-0">
          {/* SQL Editor */}
          <div className="bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-[200px]">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between">
              <span className="text-sm font-medium text-strong">Query</span>
              <span className="text-xs text-muted">Ctrl+Enter to execute</span>
            </div>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="SELECT * FROM packets LIMIT 10"
              className="flex-1 p-4 font-mono text-sm resize-none focus:outline-none bg-surface-sunken text-body"
              disabled={!dbReady}
            />
            <div className="px-4 py-2 border-t border-hair bg-surface-sunken flex items-center gap-3">
              <button
                onClick={handleExecute}
                disabled={!dbReady || isExecuting || !query.trim()}
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
          <div className="flex-1 bg-surface rounded-lg shadow-sm border border-hair flex flex-col min-h-0">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken flex items-center justify-between shrink-0">
              <span className="text-sm font-medium text-strong">
                📊 Results {result ? `(${result.rows.length} rows)` : ''}
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
                              {formatValue(row[col])}
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
        <div className="w-full lg:w-72 flex flex-col gap-4 shrink-0">
          {/* Templates */}
          <div className="bg-surface rounded-lg shadow-sm border border-hair">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken">
              <span className="text-sm font-medium text-strong">📝 Query Templates</span>
            </div>
            <div className="p-2">
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
            <div className="bg-surface rounded-lg shadow-sm border border-hair flex-1 min-h-0 flex flex-col">
              <div className="px-4 py-2 border-b border-hair bg-surface-sunken shrink-0">
                <span className="text-sm font-medium text-strong">📋 Query History</span>
              </div>
              <div className="flex-1 overflow-auto p-2">
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
          <div className="bg-surface rounded-lg shadow-sm border border-hair">
            <div className="px-4 py-2 border-b border-hair bg-surface-sunken">
              <span className="text-sm font-medium text-strong">📁 Schema</span>
            </div>
            <div className="p-2 text-xs text-muted space-y-1">
              <SchemaTable name="packets" columns={['frame_index', 'timestamp', 'src_ip', 'dst_ip', '...']} />
              <SchemaTable name="messages" columns={['id', 'frame_index', 'type', '...']} />
              <SchemaTable name="as_path" columns={['message_id', 'segment_index', 'asn']} />
              <SchemaTable name="nlri" columns={['message_id', 'prefix']} />
              <SchemaTable name="withdrawn" columns={['message_id', 'prefix']} />
              <SchemaTable name="communities" columns={['message_id', 'community']} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SchemaTable({ name, columns }: { name: string; columns: string[] }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 font-medium text-body hover:text-accent"
      >
        <span>{expanded ? '▼' : '▶'}</span>
        {name}
      </button>
      {expanded && (
        <div className="ml-4 text-muted">
          {columns.map((col) => (
            <div key={col}>{col}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
