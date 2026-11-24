import { useState, useMemo, useCallback, useEffect } from 'react'
import type { BgpPacket } from '../lib/bgp/types'
import { parseQuery, matchPacket, filterPacketsWork } from '../lib/filter'
import { runInSlices } from '../lib/sliced'

interface UseFilterOptions {
  initialQuery?: string
}

/**
 * How long the query must stay unchanged before a large capture is filtered.
 * The query updates on every keystroke, so without this each character would
 * start a pass of its own over every packet.
 */
const LARGE_FILTER_DEBOUNCE_MS = 200

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
 * From how many packets the filter stops running on every keystroke.
 *
 * Below this a pass takes a few milliseconds, so it runs synchronously and the
 * list is exact for the query as it is typed. Above it one pass is long enough
 * to freeze typing — about a second for a 50MB capture, so a filter typed a
 * character at a time froze the page for eight — so the pass waits for typing
 * to pause and then runs in slices (`runInSlices`), leaving the page
 * responsive. Meanwhile the list keeps showing the last result, with
 * "Filtering…" beside it.
 *
 * Filtering is always the in-memory evaluator. Large captures used to be
 * filtered by DuckDB instead, once the capture had been inserted into it; the
 * insert took longer than the list to arrive, held the main thread while it
 * ran, and on a dense capture ran the worker out of memory, while a sliced
 * pass in memory answers a 100MB capture in well under a second. The database
 * now only serves the SQL console.
 */
export const SYNC_FILTER_MAX_PACKETS = 20_000

export function useFilter(packets: BgpPacket[], options: UseFilterOptions = {}) {
  const { initialQuery = '' } = options
  const [query, setQuery] = useState(initialQuery)
  // The sliced pass's answer, tagged with the packets it was worked out from:
  // a result for another scope must never be shown as this one's.
  const [slicedResult, setSlicedResult] = useState<{ packets: BgpPacket[]; matched: BgpPacket[] } | null>(null)
  const [isFiltering, setIsFiltering] = useState(false)

  // Parse query as DSL for validation and error display
  const parsedQuery = useMemo(() => {
    if (!query.trim()) return { expression: null, errors: [] }
    return parseQuery(query)
  }, [query])

  const hasQuery = query.trim().length > 0 && parsedQuery.errors.length === 0
  const large = packets.length > SYNC_FILTER_MAX_PACKETS

  const syncFilteredPackets = useMemo(() => {
    if (!hasQuery || large) return null
    return packets.filter((packet) => matchPacket(packet, parsedQuery))
  }, [packets, hasQuery, large, parsedQuery])

  // A large capture: debounced, then in slices. The previous result stays up
  // until the new one is in, so the list does not flash back to unfiltered
  // between keystrokes.
  useEffect(() => {
    if (!large || !hasQuery) {
      setIsFiltering(false)
      return
    }

    const controller = new AbortController()
    setIsFiltering(true)
    const timer = setTimeout(() => {
      void runInSlices(filterPacketsWork(packets, parsedQuery), controller.signal).then((matched) => {
        // Null when aborted: a newer query or another scope has taken over.
        if (!matched) return
        setSlicedResult({ packets, matched })
        setIsFiltering(false)
      })
    }, LARGE_FILTER_DEBOUNCE_MS)

    return () => {
      controller.abort()
      clearTimeout(timer)
      setIsFiltering(false)
    }
  }, [large, hasQuery, parsedQuery, packets])

  // A large capture with no answer yet for these packets shows them
  // unfiltered rather than another scope's matches.
  const slicedFilteredPackets = slicedResult && slicedResult.packets === packets ? slicedResult.matched : null
  const filteredPackets = !hasQuery ? packets : (syncFilteredPackets ?? slicedFilteredPackets ?? packets)

  const clearQuery = useCallback(() => {
    setQuery('')
    setSlicedResult(null)
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
