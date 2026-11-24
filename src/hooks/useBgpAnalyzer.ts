import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { isPcapng, parsePcapngWork, parsePcapWork, type GenericPacket } from '../lib/pcap'
import { runInSlices } from '../lib/sliced'
import { parseBgpFromPacketsAsync, type BgpPacket } from '../lib/bgp'
import { initDatabase, loadPackets, unloadPackets, isInitialized } from '../lib/db'
import { savePcapFile, loadPcapFile, clearPcapFile } from '../lib/storage'
import { formatLoadProgressLabel, loadProgress, type LoadProgress } from '../lib/load-progress'
import { useI18n } from '../i18n'

type AnalyzerWarning = { kind: 'duckdbFailed' } | { kind: 'raw'; message: string }

/**
 * Where the capture is on its way into DuckDB, which happens only once the SQL
 * console asks for it (`requestDatabase`).
 *
 * - `idle`: not asked for yet, or no capture.
 * - `loading`: the insert is running, or waiting for the database to start.
 * - `loaded`: the SQL console can use it.
 * - `failed`: the insert failed.
 * - `unavailable`: the database itself did not start.
 *
 * DuckDB serves the SQL console and nothing else, so a capture is not inserted
 * until that screen is opened. Inserting every capture in the background used
 * to hold the main thread for seconds while the findings were being worked out
 * beside it, and a dense 94MB capture ran the worker out of memory — for a
 * screen many investigations never open.
 *
 * Kept as state, not read from `isDataLoaded()` at render, so that the SQL
 * console re-renders when it changes.
 */
export type DbStatus = 'idle' | 'loading' | 'loaded' | 'failed' | 'unavailable'
type AnalyzerError =
  | { kind: 'noIpPackets' }
  | { kind: 'unknownError' }
  | { kind: 'raw'; message: string }

interface InternalAnalyzerState {
  status: 'idle' | 'initializing' | 'loading' | 'ready' | 'error'
  fileName: string | null
  packets: BgpPacket[]
  allPackets: GenericPacket[]
  /** The source capture's link type, needed to write a slice of it back out. */
  linkType: number | null
  selectedPacketIndex: number | null
  warnings: AnalyzerWarning[]
  error: AnalyzerError | null
  dbReady: boolean
  /** How far the load in flight has got; null when nothing is loading. */
  progress: LoadProgress | null
  dbStatus: DbStatus
  /** How far the DuckDB insert has got; null unless `dbStatus` is `loading`. */
  dbProgress: LoadProgress | null
}

export interface AnalyzerState {
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
  /** How far the load in flight has got; null when nothing is loading. */
  progress: LoadProgress | null
  dbStatus: DbStatus
  /** How far the DuckDB insert has got; null unless `dbStatus` is `loading`. */
  dbProgress: LoadProgress | null
}

/**
 * Starts at `initializing`, not `idle`.
 *
 * On a page load we do not yet know whether IndexedDB holds a capture, and
 * `idle` means "there is no capture, send the user to the upload screen". Being
 * idle for the first render is what used to bounce deep links and reloads off
 * to the upload page before the restore had even been attempted.
 */
const initialState: InternalAnalyzerState = {
  status: 'initializing',
  fileName: null,
  packets: [],
  allPackets: [],
  linkType: null,
  selectedPacketIndex: null,
  warnings: [],
  error: null,
  dbReady: false,
  progress: null,
  dbStatus: 'idle',
  dbProgress: null,
}

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
  const { locale, t } = useI18n()
  const localeRef = useRef(locale)
  localeRef.current = locale

  const [internalState, setState] = useState<InternalAnalyzerState>(initialState)
  const restoredRef = useRef(false)
  // The capture on screen, for `requestDatabase`.
  const packetsRef = useRef<BgpPacket[]>([])
  // Which capture the app is showing. A DuckDB insert can outlive its capture
  // — the user drops another file, or resets — so its updates are applied
  // only while it still belongs to the capture on screen.
  const generationRef = useRef(0)
  // The capture generation the database was last asked to hold, so asking
  // again — the SQL console mounting twice, or revisited — starts no second
  // insert.
  const requestedRef = useRef<number | null>(null)

  /**
   * Insert a capture's packets into DuckDB. Until it finishes the SQL console
   * says the capture is still loading.
   */
  const loadIntoDatabase = useCallback(async (packets: BgpPacket[], generation: number) => {
    const current = () => generation === generationRef.current
    try {
      await loadPackets(packets, (done, total) => {
        if (!current()) return
        setState((prev) => ({
          ...prev,
          dbProgress: loadProgress('database', done, total, localeRef.current),
        }))
      })
      if (current()) setState((prev) => ({ ...prev, dbStatus: 'loaded', dbProgress: null }))
    } catch (err) {
      console.error('Failed to load packets into DuckDB:', err)
      if (!current()) return
      // Continue without DuckDB — but say so. Only the SQL console is lost.
      setState((prev) => ({
        ...prev,
        dbStatus: 'failed',
        dbProgress: null,
        warnings: [...prev.warnings, { kind: 'duckdbFailed' }],
      }))
    }
  }, [])

  // Process buffer and update state (shared by loadFile and restore)
  const processBuffer = useCallback(
    async (
      buffer: ArrayBuffer,
      fileName: string,
      options?: { saveToStorage?: Blob }
    ): Promise<boolean> => {
      // Taken now rather than once the list is ready: decoding yields to the
      // page, so another file can be dropped, or the capture reset, while
      // this one is still decoding. Whichever load started last owns the
      // screen; an earlier one that notices it has been overtaken stops. The
      // capture being replaced no longer wants backfilling into a database
      // that finishes starting while this one decodes, hence the cleared ref.
      const generation = ++generationRef.current
      packetsRef.current = []
      requestedRef.current = null
      const current = () => generation === generationRef.current
      const report = async (progress: LoadProgress): Promise<void> => {
        setState((prev) => ({ ...prev, progress }))
        await nextPaint()
      }

      try {
        // Detect format and parse
        await report(loadProgress('parsing', undefined, undefined, localeRef.current))
        // In slices: a sparse 200MB capture is 1.5 million records, and read
        // in one go they held the page for well over a second.
        const pcapResult = await runInSlices(
          isPcapng(buffer) ? parsePcapngWork(buffer) : parsePcapWork(buffer),
          () => !current()
        )
        if (!pcapResult || !current()) return false

        if (pcapResult.errors.length > 0) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: { kind: 'raw', message: pcapResult.errors.join('\n') },
            progress: null,
          }))
          return false
        }

        // Parse BGP messages from BGP-specific packets
        await report(loadProgress('decoding', undefined, undefined, localeRef.current))
        if (!current()) return false
        const bgpResult = await parseBgpFromPacketsAsync(pcapResult.packets, {
          onProgress: (done, total) => {
            if (!current()) return
            setState((prev) => ({
              ...prev,
              progress: loadProgress('decoding', done, total, localeRef.current),
            }))
          },
          shouldStop: () => !current(),
        })
        if (!bgpResult || !current()) return false

        // If no packets at all, show error
        if (pcapResult.allPackets.length === 0) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: { kind: 'noIpPackets' },
            progress: null,
          }))
          return false
        }

        packetsRef.current = bgpResult.packets
        setState({
          status: 'ready',
          fileName,
          packets: bgpResult.packets,
          allPackets: pcapResult.allPackets,
          linkType: pcapResult.globalHeader.linkType,
          selectedPacketIndex: null,
          warnings: [
            ...pcapResult.warnings.map((message): AnalyzerWarning => ({ kind: 'raw', message })),
            ...bgpResult.warnings.map((message): AnalyzerWarning => ({ kind: 'raw', message })),
          ],
          error: null,
          dbReady: isInitialized(),
          progress: null,
          dbStatus: 'idle',
          dbProgress: null,
        })

        // Not awaited. Saving keeps the capture for the next visit and has no
        // bearing on this one; a failure only means a reload finds nothing to
        // restore.
        if (options?.saveToStorage) {
          savePcapFile(fileName, options.saveToStorage).catch((err) => {
            console.error('Failed to save file to storage:', err)
          })
        }
        // The previous capture's tables, if the SQL console loaded them, are
        // memory in the worker that nothing will read again.
        if (isInitialized()) void unloadPackets()
        return true
      } catch (e) {
        if (!current()) return false
        setState((prev) => ({
          ...prev,
          status: 'error',
          error:
            e instanceof Error
              ? { kind: 'raw', message: e.message }
              : { kind: 'unknownError' },
          progress: null,
        }))
        return false
      }
    },
    []
  )

  /**
   * Make DuckDB hold the capture on screen: start the database if it is not
   * up, then insert the packets. Called by the SQL console when it opens;
   * asking again for the same capture does nothing.
   */
  const requestDatabase = useCallback(async () => {
    const generation = generationRef.current
    const packets = packetsRef.current
    if (packets.length === 0 || requestedRef.current === generation) return
    requestedRef.current = generation
    const current = () => generation === generationRef.current

    setState((prev) => ({
      ...prev,
      dbStatus: 'loading',
      dbProgress: loadProgress('database', undefined, undefined, localeRef.current),
    }))
    try {
      await initDatabase()
    } catch (err) {
      console.error('Failed to initialize DuckDB:', err)
      if (!current()) return
      // Asked again the next time the console opens: a start that timed out
      // on a slow network may well succeed then.
      requestedRef.current = null
      setState((prev) => ({ ...prev, dbReady: false, dbStatus: 'unavailable', dbProgress: null }))
      return
    }
    if (!current()) return
    setState((prev) => ({ ...prev, dbReady: true }))
    await loadIntoDatabase(packets, generation)
  }, [loadIntoDatabase])

  // Restore the capture kept from the last visit. The database is not
  // started here: only the SQL console needs it, and it asks.
  useEffect(() => {
    const init = async () => {
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
              progress: loadProgress('reading', undefined, undefined, localeRef.current),
            }))
            await processBuffer(stored.data, stored.fileName)
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
        progress: loadProgress('reading', undefined, undefined, localeRef.current),
      }))

      const buffer = await file.arrayBuffer()
      await processBuffer(buffer, file.name, { saveToStorage: file })
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
    generationRef.current++
    requestedRef.current = null
    if (isInitialized()) void unloadPackets()

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

  // Resolve localized warnings/errors/progress at render time so switching
  // languages updates already-displayed banners and error messages live.
  const state = useMemo<AnalyzerState>(() => {
    const warnings = internalState.warnings.map((w) =>
      w.kind === 'duckdbFailed' ? t.warnings.duckdbFailed : w.message
    )
    const error =
      internalState.error === null
        ? null
        : internalState.error.kind === 'noIpPackets'
          ? t.warnings.noIpPackets
          : internalState.error.kind === 'unknownError'
            ? t.warnings.unknownError
            : internalState.error.message
    const localize = (progress: LoadProgress | null): LoadProgress | null =>
      progress
        ? {
            ...progress,
            label: formatLoadProgressLabel(progress.stage, progress.done, progress.total, locale),
          }
        : null

    return {
      ...internalState,
      warnings,
      error,
      progress: localize(internalState.progress),
      dbProgress: localize(internalState.dbProgress),
    }
  }, [internalState, locale, t])

  return {
    state,
    loadFile,
    selectPacket,
    reset,
    requestDatabase,
  }
}
