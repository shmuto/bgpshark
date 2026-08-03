import { useState, useMemo, useCallback, useEffect } from 'react'
import type { BgpPacket } from '../lib/bgp/types'
import { parseQuery, matchPacket } from '../lib/filter'
import { isInitialized, getPackets } from '../lib/db'

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
      getPackets(query)
        .then((results) => {
          if (!cancelled) {
            setAsyncFilteredPackets(results)
            setIsFiltering(false)
          }
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
  }, [query, useDuckDB, parsedQuery.errors.length])

  // Use DuckDB results if available, otherwise fallback to sync filtering
  const filteredPackets = asyncFilteredPackets ?? syncFilteredPackets

  const clearQuery = useCallback(() => {
    setQuery('')
    setAsyncFilteredPackets(null)
  }, [])

  const hasActiveFilter = query.trim().length > 0
  const hasParseErrors = parsedQuery.errors.length > 0
  const parseErrors = parsedQuery.errors

  return {
    query,
    setQuery,
    filteredPackets,
    parsedQuery,
    parseErrors,
    clearQuery,
    hasActiveFilter,
    hasParseErrors,
    isFiltering,
  }
}
