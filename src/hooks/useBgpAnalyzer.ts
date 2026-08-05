import { useState, useCallback, useEffect, useRef } from 'react'
import { parsePcap, isPcapng, parsePcapng, type GenericPacket } from '../lib/pcap'
import { parseBgpFromPackets, type BgpPacket } from '../lib/bgp'
import { initDatabase, loadPackets, isInitialized, isDataLoaded } from '../lib/db'
import { savePcapFile, loadPcapFile, clearPcapFile } from '../lib/storage'

interface AnalyzerState {
  status: 'idle' | 'initializing' | 'loading' | 'ready' | 'error'
  fileName: string | null
  packets: BgpPacket[]
  allPackets: GenericPacket[]
  /** The source capture's link type, needed to write a slice of it back out. */
  linkType: number | null
  selectedPacketIndex: number | null
  warnings: string[]
  error: string | null
  dbReady: boolean
}

/**
 * Starts at `initializing`, not `idle`.
 *
 * On a page load we do not yet know whether IndexedDB holds a capture, and
 * `idle` means "there is no capture, send the user to the upload screen". Being
 * idle for the first render is what used to bounce deep links and reloads off
 * to the upload page before the restore had even been attempted.
 */
const initialState: AnalyzerState = {
  status: 'initializing',
  fileName: null,
  packets: [],
  allPackets: [],
  linkType: null,
  selectedPacketIndex: null,
  warnings: [],
  error: null,
  dbReady: false,
}

export function useBgpAnalyzer() {
  const [state, setState] = useState<AnalyzerState>(initialState)
  const restoredRef = useRef(false)
  // Latest parsed packets, for the backfill below — a capture dropped while
  // DuckDB was still initializing is parsed before the database can take it.
  const packetsRef = useRef<BgpPacket[]>([])

  // Process buffer and update state (shared by loadFile and restore)
  const processBuffer = useCallback(
    async (
      buffer: ArrayBuffer,
      fileName: string,
      options?: { saveToStorage?: boolean }
    ): Promise<boolean> => {
      try {
        // Detect format and parse
        const pcapResult = isPcapng(buffer) ? parsePcapng(buffer) : parsePcap(buffer)

        if (pcapResult.errors.length > 0) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: pcapResult.errors.join('\n'),
          }))
          return false
        }

        // Parse BGP messages from BGP-specific packets
        const bgpResult = parseBgpFromPackets(pcapResult.packets)

        // If no packets at all, show error
        if (pcapResult.allPackets.length === 0) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: 'No IP packets found in the pcap file.',
          }))
          return false
        }

        // Load packets into DuckDB if available
        const dbWarnings: string[] = []
        if (isInitialized() && bgpResult.packets.length > 0) {
          try {
            await loadPackets(bgpResult.packets)
          } catch (err) {
            console.error('Failed to load packets into DuckDB:', err)
            // Continue without DuckDB — but say so. Filtering falls back to
            // the in-memory evaluator; only the SQL console is actually lost.
            dbWarnings.push(
              'Packets could not be loaded into DuckDB. ' +
                'Filtering works in-memory; the SQL console is unavailable for this capture.'
            )
          }
        }

        // Save to IndexedDB if requested
        if (options?.saveToStorage) {
          try {
            await savePcapFile(fileName, buffer)
          } catch (err) {
            console.error('Failed to save file to storage:', err)
            // Continue without persistence
          }
        }

        packetsRef.current = bgpResult.packets
        setState({
          status: 'ready',
          fileName,
          packets: bgpResult.packets,
          allPackets: pcapResult.allPackets,
          linkType: pcapResult.globalHeader.linkType,
          selectedPacketIndex: null,
          warnings: [...pcapResult.warnings, ...bgpResult.warnings, ...dbWarnings],
          error: null,
          dbReady: isInitialized(),
        })
        return true
      } catch (e) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: e instanceof Error ? e.message : 'Unknown error occurred',
        }))
        return false
      }
    },
    []
  )

  // Initialize DuckDB on mount and restore persisted data
  useEffect(() => {
    const init = async () => {
      // Initialize DuckDB
      if (!isInitialized()) {
        setState((prev) => ({ ...prev, status: 'initializing' }))

        try {
          await initDatabase()
          setState((prev) => ({ ...prev, dbReady: true }))
          // A capture uploaded while the database was still coming up was
          // parsed straight past the load step. Load it now.
          if (packetsRef.current.length > 0 && !isDataLoaded()) {
            try {
              await loadPackets(packetsRef.current)
            } catch (err) {
              console.error('Failed to load packets into DuckDB:', err)
            }
          }
        } catch (err) {
          console.error('Failed to initialize DuckDB:', err)
          setState((prev) => ({ ...prev, dbReady: false }))
        }
      } else {
        setState((prev) => ({ ...prev, dbReady: true }))
      }

      // Try to restore persisted data (only once)
      if (!restoredRef.current) {
        restoredRef.current = true
        try {
          const stored = await loadPcapFile()
          if (stored) {
            setState((prev) => ({ ...prev, status: 'loading', fileName: stored.fileName }))
            await processBuffer(stored.data, stored.fileName, { saveToStorage: false })
            return
          }
        } catch (err) {
          console.error('Failed to restore persisted data:', err)
        }
      }

      // No persisted data, set to idle
      setState((prev) => {
        if (prev.status === 'initializing') {
          return { ...prev, status: 'idle' }
        }
        return prev
      })
    }

    init()
  }, [processBuffer])

  const loadFile = useCallback(
    async (file: File) => {
      setState((prev) => ({
        ...prev,
        status: 'loading',
        fileName: file.name,
        error: null,
      }))

      const buffer = await file.arrayBuffer()
      await processBuffer(buffer, file.name, { saveToStorage: true })
    },
    [processBuffer]
  )

  const selectPacket = useCallback((index: number | null) => {
    setState((prev) => ({
      ...prev,
      selectedPacketIndex: index,
    }))
  }, [])

  const reset = useCallback(() => {
    packetsRef.current = []

    // Clear stored data
    clearPcapFile().catch((err) => {
      console.error('Failed to clear stored file:', err)
    })

    setState((prev) => ({
      ...initialState,
      // Nothing is being restored here, so this is a real "no capture loaded".
      status: 'idle',
      dbReady: prev.dbReady,
    }))
  }, [])

  return {
    state,
    loadFile,
    selectPacket,
    reset,
  }
}
