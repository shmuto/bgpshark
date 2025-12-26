import { useState, useMemo, useCallback } from 'react'
import type { BgpPacket } from '../lib/bgp/types'
import { parseQuery, matchPacket } from '../lib/filter'

export function useFilter(packets: BgpPacket[]) {
  const [query, setQuery] = useState('')

  // Parse and filter packets based on query
  const { filteredPackets, parsedQuery } = useMemo(() => {
    if (!query.trim()) {
      return { filteredPackets: packets, parsedQuery: null }
    }

    const parsed = parseQuery(query)
    const filtered = packets.filter((packet) => matchPacket(packet, parsed))

    return { filteredPackets: filtered, parsedQuery: parsed }
  }, [packets, query])

  const clearQuery = useCallback(() => {
    setQuery('')
  }, [])

  const hasActiveFilter = query.trim().length > 0

  return {
    query,
    setQuery,
    filteredPackets,
    parsedQuery,
    clearQuery,
    hasActiveFilter,
  }
}
