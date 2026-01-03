import { useState, useCallback, useEffect } from 'react'
import { initDatabase, loadPackets, getPackets, isInitialized } from '../lib/db'
import type { BgpPacket } from '../lib/bgp'

interface DuckDBState {
  status: 'initializing' | 'ready' | 'loading' | 'error'
  error: string | null
  packetCount: number
}

export function useDuckDB() {
  const [state, setState] = useState<DuckDBState>({
    status: 'initializing',
    error: null,
    packetCount: 0,
  })

  // Initialize DuckDB on mount
  useEffect(() => {
    if (isInitialized()) {
      setState((s) => ({ ...s, status: 'ready' }))
      return
    }

    initDatabase()
      .then(() => {
        setState({ status: 'ready', error: null, packetCount: 0 })
      })
      .catch((err) => {
        setState({ status: 'error', error: err.message, packetCount: 0 })
      })
  }, [])

  // Load packets into DuckDB
  const load = useCallback(async (packets: BgpPacket[]): Promise<void> => {
    setState((s) => ({ ...s, status: 'loading' }))
    try {
      await loadPackets(packets)
      setState({ status: 'ready', error: null, packetCount: packets.length })
    } catch (err) {
      setState({ status: 'error', error: (err as Error).message, packetCount: 0 })
      throw err
    }
  }, [])

  // Query packets with filter
  const query = useCallback(async (filterExpr?: string): Promise<BgpPacket[]> => {
    try {
      return await getPackets(filterExpr)
    } catch (err) {
      console.error('Query error:', err)
      throw err
    }
  }, [])

  return {
    ...state,
    load,
    query,
    isReady: state.status === 'ready',
  }
}
