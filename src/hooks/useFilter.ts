import { useState, useMemo, useCallback, useEffect } from 'react'
import type { BgpPacket } from '../lib/bgp/types'
import { parseQuery, matchPacket } from '../lib/filter'
import { isInitialized, getMatchingFrameIndexes } from '../lib/db'

interface UseFilterOptions {
  useDuckDB?: boolean
  initialQuery?: string
}

/**
 * How long the query must stay unchanged before it is sent to DuckDB.
 * The query updates on every keystroke, so without this each character would
 * issue its own SQL query.
 */
const DUCKDB_DEBOUNCE_MS = 200

/**
 * How long a query has to stay broken before we say so.
 *
 * Every half-typed query is a syntax error — `type = ` is flagged the moment the
 * operator is typed — so reporting them immediately means the box is red for
 * most of the time the user spends typing. Errors still block filtering right
 * away; this only delays telling the user about them.
 */
const PARSE_ERROR_GRACE_MS = 600

export function useFilter(packets: BgpPacket[], options: UseFilterOptions = {}) {
  const { useDuckDB = true, initialQuery = '' } = options
  const [query, setQuery] = useState(initialQuery)
  const [asyncFilteredPackets, setAsyncFilteredPackets] = useState<BgpPacket[] | null>(null)
  const [isFiltering, setIsFiltering] = useState(false)

  // Parse query as DSL for validation and error display
  const parsedQuery = useMemo(() => {
    if (!query.trim()) return { expression: null, errors: [] }
    return parseQuery(query)
  }, [query])

  // Filtering runs on two paths on purpose. The in-memory pass below is
  // synchronous, so the list stays correct for the query being typed; the DuckDB
  // pass replaces it once the debounced SQL query resolves, which is what keeps
  // large captures usable. Whenever the query changes the async result is dropped
  // immediately, so results for a previous query are never displayed.
  const syncFilteredPackets = useMemo(() => {
    if (!query.trim()) return packets
    if (parsedQuery.errors.length > 0) return packets
    return packets.filter((packet) => matchPacket(packet, parsedQuery))
  }, [packets, query, parsedQuery])

  // Async DuckDB filtering, debounced
  useEffect(() => {
    // Any results still held belong to the previous query, so drop them now and
    // fall back to the synchronous pass until the new SQL query resolves.
    setAsyncFilteredPackets(null)

    if (!useDuckDB || !isInitialized()) return
    if (!query.trim()) return
    // Don't execute if there are parse errors
    if (parsedQuery.errors.length > 0) return

    let cancelled = false
    setIsFiltering(true)

    const timer = setTimeout(() => {
      getMatchingFrameIndexes(query)
        .then((frameIndexes) => {
          if (cancelled) return
          // DuckDB only says which frames matched. The packets themselves come
          // from the parsed objects we already hold, so nothing the SQL schema
          // cannot represent gets lost on the way to the UI.
          const matched = new Set(frameIndexes)
          setAsyncFilteredPackets(packets.filter((p) => matched.has(p.frameIndex)))
          setIsFiltering(false)
        })
        .catch((err) => {
          console.error('DuckDB filter error:', err)
          if (!cancelled) {
            setAsyncFilteredPackets(null)
            setIsFiltering(false)
          }
        })
    }, DUCKDB_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
      setIsFiltering(false)
    }
    // packets is a dependency because the matched frame indexes are resolved
    // against it; loading a different capture must re-run the query rather than
    // resolve against the previous file's packets.
  }, [query, useDuckDB, parsedQuery.errors.length, packets])

  // Use DuckDB results if available, otherwise fallback to sync filtering
  const filteredPackets = asyncFilteredPackets ?? syncFilteredPackets

  const clearQuery = useCallback(() => {
    setQuery('')
    setAsyncFilteredPackets(null)
  }, [])

  const hasActiveFilter = query.trim().length > 0
  const hasParseErrors = parsedQuery.errors.length > 0
  const parseErrors = parsedQuery.errors

  // Hold the error back until the user pauses, so typing is not narrated.
  const [showParseErrors, setShowParseErrors] = useState(false)
  useEffect(() => {
    if (!hasParseErrors) {
      setShowParseErrors(false)
      return
    }
    const timer = setTimeout(() => setShowParseErrors(true), PARSE_ERROR_GRACE_MS)
    return () => clearTimeout(timer)
  }, [hasParseErrors, query])

  return {
    query,
    setQuery,
    filteredPackets,
    parsedQuery,
    parseErrors,
    clearQuery,
    hasActiveFilter,
    hasParseErrors,
    showParseErrors,
    isFiltering,
  }
}
