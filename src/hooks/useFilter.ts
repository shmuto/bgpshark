import { useState, useMemo, useCallback, useEffect } from 'react'
import type { BgpPacket } from '../lib/bgp/types'
import { parseQuery, matchPacket } from '../lib/filter'
import { isInitialized, getPackets } from '../lib/db'

interface UseFilterOptions {
  useDuckDB?: boolean
  initialQuery?: string
}

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

  // Synchronous in-memory filtering (fallback when DuckDB not available)
  const syncFilteredPackets = useMemo(() => {
    if (!query.trim()) return packets
    if (parsedQuery.errors.length > 0) return packets
    return packets.filter((packet) => matchPacket(packet, parsedQuery))
  }, [packets, query, parsedQuery])

  // Async DuckDB filtering
  useEffect(() => {
    if (!useDuckDB || !isInitialized()) {
      setAsyncFilteredPackets(null)
      return
    }

    if (!query.trim()) {
      setAsyncFilteredPackets(null)
      return
    }

    // Don't execute if there are parse errors
    if (parsedQuery.errors.length > 0) {
      setAsyncFilteredPackets(null)
      return
    }

    let cancelled = false
    setIsFiltering(true)

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

    return () => {
      cancelled = true
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
