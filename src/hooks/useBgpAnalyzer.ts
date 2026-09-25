import { useState, useCallback, useEffect, useRef } from 'react'
import { parsePcap, isPcapng, parsePcapng, type GenericPacket } from '../lib/pcap'
import { parseBgpFromPackets, type BgpPacket } from '../lib/bgp'
import { initDatabase, loadCapture } from '../lib/db'
import { savePcapFile, loadPcapFile, clearPcapFile } from '../lib/storage'
import { loadProgress, type LoadProgress } from '../lib/load-progress'

/**
 * Where DuckDB is with the capture on screen.
 *
 * Kept in React state rather than read from the database module, because the
 * module's own flag (`isDataLoaded`) answers for whatever load ran last — and
 * with loads running in the background, that can be the previous capture's,
 * finishing just after the next one appeared. Only this state is tied to the
 * capture the screens are showing.
 *
 * - `starting`: DuckDB itself is still initializing.
 * - `unavailable`: it failed to initialize; SQL is off for the session.
 * - `idle`: running, with no capture loaded into it.
 * - `loading`: the capture on screen is going in. `total` is zero until the
 *   rows have been built.
 * - `ready`: the capture on screen is queryable.
 * - `failed`: this capture could not be loaded; the warning says why.
 */
export type DatabaseState =
  | { status: 'starting' }
  | { status: 'unavailable' }
  | { status: 'idle' }
  | { status: 'loading'; done: number; total: number }
  | { status: 'ready' }
  | { status: 'failed' }

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
  database: DatabaseState
  /** How far the capture load in flight has got; null when nothing is loading. */
  progress: LoadProgress | null
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
  database: { status: 'starting' },
  progress: null,
}

const DATABASE_LOAD_FAILED =
  'Packets could not be loaded into DuckDB. ' +
  'Filtering works in-memory; the SQL console is unavailable for this capture.'

/**
 * Wait until the browser has had a chance to paint.
 *
 * The parsers are synchronous: once one starts, nothing reaches the screen
 * until it returns. Announcing a stage and starting it in the same task means
 * the announcement is never seen, so each stage is announced, then this is
 * awaited, then the stage begins.
 *
 * A frame callback is the moment before a paint; the timeout after it lands
 * past the paint. The outer timeout is for a hidden tab, where frame callbacks
 * do not run at all and the load would otherwise stall until it was shown.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 100)
    requestAnimationFrame(() => {
      clearTimeout(fallback)
      setTimeout(resolve, 0)
    })
  })
}

export function useBgpAnalyzer() {
  const [state, setState] = useState<AnalyzerState>(initialState)
  const restoredRef = useRef(false)
  // The capture on screen, as bytes, for the backfill below — a capture
  // dropped while DuckDB was still initializing is parsed before the database
  // can take it. Null when there is nothing for DuckDB to load.
  const captureRef = useRef<ArrayBuffer | null>(null)
  // Whether DuckDB has come up, so a capture parsed afterwards knows it can go
  // straight in rather than waiting for the backfill.
  const databaseUpRef = useRef<boolean | null>(null)
  // The DuckDB load in flight, so a newer capture — or New File — can stop it.
  const databaseLoadRef = useRef<AbortController | null>(null)

  /**
   * Load the capture into DuckDB in the background, reporting into state.
   *
   * The screens do not wait for this. They filter in memory until it is done
   * and through SQL afterwards, and since the two backends select the same
   * packets (`filter-backends.e2e.ts`), nothing on screen changes when it
   * finishes except that the SQL console becomes available. On a 50MB capture
   * this is most of a minute the reader no longer spends looking at a gauge.
   *
   * Every report is checked against the load it belongs to: a load that was
   * superseded must not mark the newer capture as queryable, or failed.
   */
  const loadIntoDatabase = useCallback((buffer: ArrayBuffer) => {
    databaseLoadRef.current?.abort()
    const controller = new AbortController()
    databaseLoadRef.current = controller
    const current = () => databaseLoadRef.current === controller

    setState((prev) => ({ ...prev, database: { status: 'loading', done: 0, total: 0 } }))
    loadCapture(
      buffer,
      (done, total) => {
        if (current()) setState((prev) => ({ ...prev, database: { status: 'loading', done, total } }))
      },
      controller.signal
    ).then(
      () => {
        if (!current()) return
        databaseLoadRef.current = null
        setState((prev) => ({ ...prev, database: { status: 'ready' } }))
      },
      (err) => {
        if (!current() || controller.signal.aborted) return
        databaseLoadRef.current = null
        console.error('Failed to load packets into DuckDB:', err)
        // Continue without DuckDB — but say so. Filtering keeps working in
        // memory; only the SQL console is actually lost.
        setState((prev) => ({
          ...prev,
          database: { status: 'failed' },
          warnings: [...prev.warnings, DATABASE_LOAD_FAILED],
        }))
      }
    )
  }, [])

  // Process buffer and update state (shared by loadFile and restore)
  const processBuffer = useCallback(
    async (
      buffer: ArrayBuffer,
      fileName: string,
      options?: { saveToStorage?: boolean }
    ): Promise<boolean> => {
      const report = async (progress: LoadProgress): Promise<void> => {
        setState((prev) => ({ ...prev, progress }))
        await nextPaint()
      }

      // The previous capture's database load, if it is still going, is for
      // packets nobody will look at again.
      databaseLoadRef.current?.abort()
      databaseLoadRef.current = null

      try {
        // Detect format and parse
        await report(loadProgress('parsing'))
        const pcapResult = isPcapng(buffer) ? parsePcapng(buffer) : parsePcap(buffer)

        if (pcapResult.errors.length > 0) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: pcapResult.errors.join('\n'),
            progress: null,
          }))
          return false
        }

        // Parse BGP messages from BGP-specific packets
        await report(loadProgress('decoding'))
        const bgpResult = parseBgpFromPackets(pcapResult.packets)

        // If no packets at all, show error
        if (pcapResult.allPackets.length === 0) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: 'No IP packets found in the pcap file.',
            progress: null,
          }))
          return false
        }

        const hasBgp = bgpResult.packets.length > 0
        captureRef.current = hasBgp ? buffer : null
        // Still starting, or never came up: the backfill in the effect below
        // owns this capture's load in the first case, and there is nothing to
        // load into in the second.
        const database = (prev: DatabaseState): DatabaseState =>
          databaseUpRef.current === true
            ? hasBgp
              ? { status: 'loading', done: 0, total: 0 }
              : { status: 'idle' }
            : prev.status === 'unavailable'
              ? prev
              : { status: 'starting' }
        setState((prev) => ({
          status: 'ready',
          fileName,
          packets: bgpResult.packets,
          allPackets: pcapResult.allPackets,
          linkType: pcapResult.globalHeader.linkType,
          selectedPacketIndex: null,
          warnings: [...pcapResult.warnings, ...bgpResult.warnings],
          error: null,
          database: database(prev.database),
          progress: null,
        }))

        // Everything past this point happens with the capture already on
        // screen.
        if (databaseUpRef.current === true && hasBgp) loadIntoDatabase(buffer)

        if (options?.saveToStorage) {
          savePcapFile(fileName, buffer).catch((err) => {
            // Continue without persistence
            console.error('Failed to save file to storage:', err)
          })
        }
        return true
      } catch (e) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: e instanceof Error ? e.message : 'Unknown error occurred',
          progress: null,
        }))
        return false
      }
    },
    [loadIntoDatabase]
  )

  // Initialize DuckDB on mount and restore persisted data
  useEffect(() => {
    const init = async () => {
      // Initialize DuckDB
      if (databaseUpRef.current === null) {
        setState((prev) => ({ ...prev, status: 'initializing' }))

        try {
          await initDatabase()
          databaseUpRef.current = true
          // A capture uploaded while the database was still coming up was
          // parsed straight past the load step. Load it now.
          if (captureRef.current) {
            loadIntoDatabase(captureRef.current)
          } else {
            setState((prev) => ({ ...prev, database: { status: 'idle' } }))
          }
        } catch (err) {
          console.error('Failed to initialize DuckDB:', err)
          databaseUpRef.current = false
          setState((prev) => ({ ...prev, database: { status: 'unavailable' } }))
        }
      }

      // Try to restore persisted data (only once)
      if (!restoredRef.current) {
        restoredRef.current = true
        try {
          const stored = await loadPcapFile()
          if (stored) {
            setState((prev) => ({
              ...prev,
              status: 'loading',
              fileName: stored.fileName,
              progress: loadProgress('reading'),
            }))
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
  }, [processBuffer, loadIntoDatabase])

  const loadFile = useCallback(
    async (file: File) => {
      setState((prev) => ({
        ...prev,
        status: 'loading',
        fileName: file.name,
        error: null,
        progress: loadProgress('reading'),
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
    captureRef.current = null
    databaseLoadRef.current?.abort()
    databaseLoadRef.current = null

    // Clear stored data
    clearPcapFile().catch((err) => {
      console.error('Failed to clear stored file:', err)
    })

    setState(() => ({
      ...initialState,
      // Nothing is being restored here, so this is a real "no capture loaded".
      status: 'idle',
      database:
        databaseUpRef.current === true
          ? { status: 'idle' }
          : databaseUpRef.current === false
            ? { status: 'unavailable' }
            : { status: 'starting' },
    }))
  }, [])

  return {
    state,
    loadFile,
    selectPacket,
    reset,
  }
}
