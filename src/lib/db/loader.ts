/**
 * Load a capture into DuckDB, off the page's thread.
 *
 * The capture's rows are built in a worker (`load-worker.ts`) and arrive here
 * as Arrow IPC batches, which this module only hands on to DuckDB's own
 * worker. The page's thread does next to nothing for the whole load, which is
 * what lets the load run while the reader is already using the capture.
 */
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { getConnection, resetDatabase, markDataLoaded } from './database'
import type { LoadWorkerReply, LoadWorkerRequest } from './load-protocol'

/**
 * The tail of the load queue, so that two loads never overlap.
 *
 * A load is not an insert into an empty database: it drops every table and
 * recreates it, resets the id counters, and only then inserts. All of that is
 * global state shared through one connection, so a second load starting while
 * the first is mid-flight is not merely slower — it drops the tables the first
 * one is still writing into ("Catalog Error: Table with name withdrawn does not
 * exist") or replays ids the first one already used ("Duplicate key
 * frame_index: 1 violates primary key constraint").
 *
 * That is not hypothetical: `useBgpAnalyzer` has two callers by design — the
 * capture being parsed calls it, and so does the backfill for a capture that
 * was dropped while the database was still starting. React's development
 * double-invoked effects make it two of the latter. They used to race.
 */
let loadQueue: Promise<unknown> = Promise.resolve()

/**
 * Rows inserted so far, out of every row the capture flattens to.
 *
 * Rows rather than packets because rows are what the time goes on: a packet of
 * eighteen UPDATEs becomes hundreds of rows, a KEEPALIVE becomes two. It is
 * called once with `done` at zero when the total is known, then after every
 * batch, and a last time with `done === total`.
 */
export type LoadProgressCallback = (done: number, total: number) => void

/**
 * Load a capture into DuckDB, from its bytes.
 *
 * Calls are serialised rather than rejected or coalesced: each one is a
 * complete "make the database hold exactly this capture", so the last caller
 * still describes the state the app wants when the queue drains.
 *
 * `signal` stops a load that is no longer wanted. The load runs while the
 * capture is already on screen, and on a large capture it takes most of a
 * minute; a second capture dropped in the meantime would otherwise wait for
 * the first one to finish before its own could start. An aborted load stops
 * its worker, rejects with the signal's reason, and leaves the tables marked
 * as not loaded.
 *
 * The bytes are copied to the worker, not transferred: the page still needs
 * them, to save the capture for the next visit.
 */
export async function loadCapture(
  buffer: ArrayBuffer,
  onProgress?: LoadProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  // A failed load must not poison the queue for the next caller, hence the
  // swallow on the tail — the error still reaches this call's own awaiter.
  const run = loadQueue.catch(() => {}).then(() => runLoad(buffer, onProgress, signal))
  loadQueue = run.catch(() => {})
  return run
}

async function runLoad(
  buffer: ArrayBuffer,
  onProgress?: LoadProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  // Cancelled while still queued behind another load: never start.
  signal?.throwIfAborted()

  // Until the load below completes, the tables must be treated as absent —
  // a partial or failed load left as "loaded" is exactly the state that made
  // every filter silently return zero packets.
  markDataLoaded(false)
  await resetDatabase()
  const conn = await getConnection()

  const worker = new Worker(new URL('./load-worker.ts', import.meta.url), { type: 'module' })
  try {
    await drain(conn, worker, buffer, onProgress, signal)
  } finally {
    worker.terminate()
  }

  markDataLoaded(true)
}

/** Take batches from the worker until it says it is done, inserting each. */
function drain(
  conn: AsyncDuckDBConnection,
  worker: Worker,
  buffer: ArrayBuffer,
  onProgress?: LoadProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (message: LoadWorkerRequest) => worker.postMessage(message)
    let total = 0
    let done = 0
    let settled = false
    // The insert DuckDB is running right now, if any. An abort waits for it:
    // the next load reuses the same staging table names, and this insert's
    // closing DROP must not land in the middle of that load's first batch.
    let inFlight: Promise<void> | null = null
    const finish = (err?: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      const settle = () => (err === undefined ? resolve() : reject(err))
      if (inFlight) inFlight.then(settle, settle)
      else settle()
    }
    const onAbort = () => finish(signal?.reason)
    signal?.addEventListener('abort', onAbort)

    worker.onerror = (event) => finish(new Error(event.message || 'The load worker failed'))
    worker.onmessage = async (event: MessageEvent<LoadWorkerReply>) => {
      const reply = event.data
      try {
        switch (reply.type) {
          case 'total':
            total = reply.total
            onProgress?.(0, total)
            return
          case 'batch':
            inFlight = insertBatch(conn, reply.table, reply.columns, reply.ipc)
            try {
              await inFlight
            } finally {
              inFlight = null
            }
            if (settled) return
            done += reply.rows
            onProgress?.(done, total)
            request({ type: 'next' })
            return
          case 'done':
            finish()
            return
          case 'error':
            finish(new Error(reply.message))
            return
        }
      } catch (err) {
        finish(err)
      }
    }

    request({ type: 'start', buffer: buffer.slice(0) })
  })
}

/**
 * Insert rows as Arrow IPC, which DuckDB WASM reads natively.
 *
 * This is the third transport this function has had, and both earlier ones
 * failed in ways worth remembering.
 *
 * `read_json_auto` read best, but the JSON reader is an *extension*, and DuckDB
 * WASM fetches extensions from `extensions.duckdb.org` on first use. The
 * production CSP is `connect-src 'self' blob: data:`, so that fetch could not
 * succeed and the SQL console died with it — unnoticed, because the end-to-end
 * suite runs against the dev server, which ships no CSP.
 *
 * Literal `VALUES` fixed that and was far too slow: DuckDB spends roughly a
 * tenth of a millisecond *parsing* each row of a VALUES list, independent of
 * indexes or constraints. An 18MB capture of 120,000 UPDATEs is 1.6 million
 * rows across these tables, and took nearly two minutes to load — during
 * which the app showed nothing but a spinner, because the packet list waited
 * on the load. People reasonably concluded it had hung.
 *
 * Arrow skips the parser entirely and is built into the WASM build, not an
 * extension, so it keeps the promise that loading a capture touches no network
 * (`offline.e2e.ts` holds it to that). The batches are built in the load
 * worker (`load-worker.ts`); this side only hands them to DuckDB.
 *
 * The rows go through a staging table and a named-column `INSERT ... SELECT`
 * rather than straight into the target, for two reasons. Inserting into an
 * existing table binds Arrow columns by *position*, so a column added to the
 * schema but not to the row object — or in a different order — would land
 * silently in the wrong place; naming them means each value can only reach the
 * column it was meant for. And the SELECT is where DuckDB casts each column
 * to its declared type — see `columnVector` in `arrow-batch.ts`.
 */
async function insertBatch(
  conn: AsyncDuckDBConnection,
  tableName: string,
  columns: string[],
  ipc: Uint8Array
): Promise<void> {
  const columnList = columns.map((c) => `"${c}"`).join(', ')
  const staging = `__load_${tableName}`
  await conn.insertArrowFromIPCStream(ipc, { name: staging, create: true })
  try {
    await conn.query(`INSERT INTO ${tableName} (${columnList}) SELECT ${columnList} FROM ${staging}`)
  } finally {
    await conn.query(`DROP TABLE IF EXISTS ${staging}`)
  }
}
