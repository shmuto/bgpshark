import { useState, useMemo, useCallback, useEffect } from 'react'
import type { BgpPacket } from '../lib/bgp/types'
import { parseQuery, matchPacket } from '../lib/filter'
import { isDataLoaded, getMatchingFrameIndexes } from '../lib/db'

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

/**
 * From how many packets the in-memory pass is skipped once DuckDB holds the
 * capture.
 *
 * The in-memory pass runs synchronously on every keystroke, and on a large
 * capture one pass is long enough to freeze typing — about a second for a
 * 50MB capture, so a filter typed a character at a time froze the page for
 * eight. Below this size a pass takes a few milliseconds and keeps the list
 * exact while typing; above it, the list keeps showing the last result, with
 * "Filtering…" beside it, until DuckDB answers.
 */
export const SYNC_FILTER_MAX_PACKETS = 20_000

export function useFilter(packets: BgpPacket[], options: UseFilterOptions = {}) {
  const { useDuckDB = true, initialQuery = '' } = options
  const [query, setQuery] = useState(initialQuery)
  // The DuckDB answer, tagged with the packets it was resolved against: a
  // result for another scope must never be shown as this one's.
  const [asyncResult, setAsyncResult] = useState<{ packets: BgpPacket[]; matched: BgpPacket[] } | null>(null)
  const [isFiltering, setIsFiltering] = useState(false)

  // Parse query as DSL for validation and error display
  const parsedQuery = useMemo(() => {
    if (!query.trim()) return { expression: null, errors: [] }
    return parseQuery(query)
  }, [query])

  const hasQuery = query.trim().length > 0 && parsedQuery.errors.length === 0
  // Gated on the data being loaded, not on the database existing: querying a
  // healthy connection whose load failed returns zero rows for everything,
  // and that empty answer would replace the correct in-memory result below.
  const sqlAvailable = useDuckDB && isDataLoaded()
  const deferToDuckDB = sqlAvailable && packets.length > SYNC_FILTER_MAX_PACKETS

  // Filtering runs on two paths on purpose. The in-memory pass below is
  // synchronous, so the list stays correct for the query being typed; the DuckDB
  // pass replaces it once the debounced SQL query resolves, which is what keeps
  // large captures usable. Whenever the query changes the async result is dropped
  // immediately, so results for a previous query are never displayed — except
  // on a capture large enough to defer to DuckDB, where the in-memory pass is
  // what made typing freeze, and the previous result stays up, marked as
  // filtering, until the new one arrives.
  const syncFilteredPackets = useMemo(() => {
    if (!hasQuery) return packets
    if (deferToDuckDB) return null
    return packets.filter((packet) => matchPacket(packet, parsedQuery))
  }, [packets, hasQuery, deferToDuckDB, parsedQuery])

  // Async DuckDB filtering, debounced
  useEffect(() => {
    // Any results still held belong to the previous query, so drop them now and
    // fall back to the synchronous pass until the new SQL query resolves.
    if (!deferToDuckDB) setAsyncResult(null)

    if (!sqlAvailable || !hasQuery) {
      setIsFiltering(false)
      return
    }

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
          setAsyncResult({ packets, matched: packets.filter((p) => matched.has(p.frameIndex)) })
          setIsFiltering(false)
        })
        .catch((err) => {
          console.error('DuckDB filter error:', err)
          if (cancelled) return
          // The in-memory evaluator is the fallback either way; on a deferred
          // capture there is no synchronous result to fall back to, so run it
          // once here instead.
          setAsyncResult(
            deferToDuckDB ? { packets, matched: packets.filter((p) => matchPacket(p, parsedQuery)) } : null
          )
          setIsFiltering(false)
        })
    }, DUCKDB_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
      setIsFiltering(false)
    }
    // packets is a dependency because the matched frame indexes are resolved
    // against it; loading a different capture must re-run the query rather than
    // resolve against the previous file's packets. `sqlAvailable` follows
    // `useDuckDB`, which callers flip when the background insert finishes.
  }, [query, hasQuery, sqlAvailable, deferToDuckDB, parsedQuery, packets])

  // Use DuckDB results if available, otherwise fallback to sync filtering. A
  // deferred capture with no answer yet for these packets shows them unfiltered
  // rather than another scope's matches.
  const asyncFilteredPackets = asyncResult && asyncResult.packets === packets ? asyncResult.matched : null
  const filteredPackets = !hasQuery
    ? packets
    : (asyncFilteredPackets ?? syncFilteredPackets ?? packets)

  const clearQuery = useCallback(() => {
    setQuery('')
    setAsyncResult(null)
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
