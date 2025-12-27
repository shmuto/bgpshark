import { useState, useMemo, useCallback } from 'react'
import type { BgpPacket } from '../lib/bgp/types'
import { parseQuery, matchPacket } from '../lib/filter'

export function useFilter(packets: BgpPacket[]) {
  const [query, setQuery] = useState('')

  // Parse and filter packets based on query
  const { filteredPackets, parsedQuery, parseErrors } = useMemo(() => {
    if (!query.trim()) {
      return { filteredPackets: packets, parsedQuery: null, parseErrors: [] }
    }

    const parsed = parseQuery(query)
    const filtered = parsed.errors.length === 0
      ? packets.filter((packet) => matchPacket(packet, parsed))
      : packets // Don't filter if there are parse errors

    return { filteredPackets: filtered, parsedQuery: parsed, parseErrors: parsed.errors }
  }, [packets, query])

  const clearQuery = useCallback(() => {
    setQuery('')
  }, [])

  const hasActiveFilter = query.trim().length > 0
  const hasParseErrors = parseErrors.length > 0

  return {
    query,
    setQuery,
    filteredPackets,
    parsedQuery,
    parseErrors,
    clearQuery,
    hasActiveFilter,
    hasParseErrors,
  }
}
