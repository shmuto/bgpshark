import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { parsePcap, isPcapng, parsePcapng, type GenericPacket } from '../lib/pcap'
import { parseBgpFromPacketsAsync, type BgpPacket } from '../lib/bgp'
import { initDatabase, loadPackets, isInitialized, isDataLoaded } from '../lib/db'
import { savePcapFile, loadPcapFile, clearPcapFile } from '../lib/storage'
import { formatLoadProgressLabel, loadProgress, type LoadProgress } from '../lib/load-progress'
import { useI18n } from '../i18n'

type AnalyzerWarning = { kind: 'duckdbFailed' } | { kind: 'raw'; message: string }

/**
 * Where the capture is on its way into DuckDB, which happens *after* the
 * packet list is on screen.
 *
 * - `idle`: no capture.
 * - `loading`: the insert is running, or waiting for the database to start.
 * - `loaded`: SQL filtering and the SQL console can use it.
 * - `failed`: the insert failed; filtering stays in memory.
 * - `unavailable`: the database itself never started.
 *
 * Kept as state, not read from `isDataLoaded()` at render, so that the screens
 * that switch on it — the filter, the SQL console — re-render when it changes.
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
  // Latest parsed packets, for the backfill below — a capture dropped while
  // DuckDB was still initializing is parsed before the database can take it.
  const packetsRef = useRef<BgpPacket[]>([])
  // Which capture the app is showing. A DuckDB insert runs after the list is
  // up and can outlive its capture — the user drops another file, or resets —
  // so its updates are applied only while it still belongs to the capture on
  // screen.
  const generationRef = useRef(0)
  // Set once DuckDB has failed to start, so later captures say so instead of
  // waiting for a database that is not coming.
  const dbInitFailedRef = useRef(false)

  /**
   * Insert a capture's packets into DuckDB, in the background.
   *
   * Not awaited by the load: the packet list, the findings and in-memory
   * filtering need only the parsed packets, and the insert used to be most of
   * the wait in front of them. Until it finishes the filter stays in memory
   * and the SQL console says the capture is still loading.
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
      // Continue without DuckDB — but say so. Filtering falls back to the
      // in-memory evaluator; only the SQL console is actually lost.
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
      const current = () => generation === generationRef.current
      const report = async (progress: LoadProgress): Promise<void> => {
        setState((prev) => ({ ...prev, progress }))
        await nextPaint()
      }

      try {
        // Detect format and parse
        await report(loadProgress('parsing', undefined, undefined, localeRef.current))
        const pcapResult = isPcapng(buffer) ? parsePcapng(buffer) : parsePcap(buffer)
        if (!current()) return false

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
        const hasRows = bgpResult.packets.length > 0
        const dbStatus: DbStatus = !hasRows
          ? 'idle'
          : dbInitFailedRef.current
            ? 'unavailable'
            : 'loading'
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
          dbStatus,
          dbProgress:
            dbStatus === 'loading'
              ? loadProgress('database', undefined, undefined, localeRef.current)
              : null,
        })

        // Neither of these is awaited. Saving keeps the capture for the next
        // visit and has no bearing on this one; a failure only means a reload
        // finds nothing to restore. A database that is still starting picks
        // the packets up from `packetsRef` once it is ready.
        if (options?.saveToStorage) {
          savePcapFile(fileName, options.saveToStorage).catch((err) => {
            console.error('Failed to save file to storage:', err)
          })
        }
        if (hasRows && isInitialized()) {
          void loadIntoDatabase(bgpResult.packets, generation)
        }
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
    [loadIntoDatabase]
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
            void loadIntoDatabase(packetsRef.current, generationRef.current)
          }
        } catch (err) {
          console.error('Failed to initialize DuckDB:', err)
          dbInitFailedRef.current = true
          setState((prev) => ({
            ...prev,
            dbReady: false,
            dbStatus: prev.dbStatus === 'loading' ? 'unavailable' : prev.dbStatus,
            dbProgress: null,
          }))
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
  }, [processBuffer, loadIntoDatabase])

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
  }
}
