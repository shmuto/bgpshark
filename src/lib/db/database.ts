/**
 * DuckDB WASM Database Management
 */
import type * as duckdb from '@duckdb/duckdb-wasm'
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import { SCHEMA_SQL, DROP_TABLES_SQL, splitSqlStatements } from './schema'

/**
 * Bundles are served from our own origin rather than a CDN, so the app makes no
 * third-party requests and works under a strict CSP.
 *
 * The COI bundle is omitted deliberately: it requires cross-origin isolation
 * (COOP/COEP headers) which GitHub Pages cannot set.
 */
const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
}

let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null
let initPromise: Promise<void> | null = null
let dataLoaded = false

/**
 * A worker whose wasm fetch fails does not reject `instantiate` — it hangs.
 * Without a deadline the app would sit in `initializing` forever, with the
 * upload screen disabled, on any network where the wasm cannot be fetched.
 */
const INIT_TIMEOUT_MS = 15_000

/**
 * Initialize DuckDB WASM
 */
export async function initDatabase(): Promise<void> {
  if (initPromise) {
    return initPromise
  }

  const attempt = { cancelled: false }
  let worker: Worker | null = null

  const init = (async () => {
    // Imported here rather than at the top of the file so the ~250kB of DuckDB
    // glue is fetched alongside the database it drives, instead of sitting in
    // the bundle the upload screen has to download before it can paint.
    const duckdbModule = await import('@duckdb/duckdb-wasm')

    // Select bundle based on browser capabilities
    const bundle = await duckdbModule.selectBundle(BUNDLES)

    // Create worker directly from the same-origin URL (no blob wrapper needed)
    worker = new Worker(bundle.mainWorker!)
    const logger = new duckdbModule.ConsoleLogger(duckdbModule.LogLevel.WARNING)

    // Instantiate database
    const database = new duckdbModule.AsyncDuckDB(logger, worker)
    await database.instantiate(bundle.mainModule, bundle.pthreadWorker)
    if (attempt.cancelled) {
      throw new Error('DuckDB initialization abandoned after timeout')
    }

    // Create connection
    const connection = await database.connect()
    if (attempt.cancelled) {
      throw new Error('DuckDB initialization abandoned after timeout')
    }

    // The module-level handles are only set once the database is actually
    // usable. A timed-out attempt that limps to completion later must not
    // flip `isInitialized()` to true behind the app's back — the capture was
    // loaded without DuckDB, so its tables would be empty (see useFilter).
    db = database
    conn = connection

    // Create schema
    await createSchema()
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`DuckDB did not initialize within ${INIT_TIMEOUT_MS / 1000}s`)),
      INIT_TIMEOUT_MS
    )
  })

  initPromise = Promise.race([init, deadline])
    .finally(() => clearTimeout(timer))
    .catch((err) => {
      attempt.cancelled = true
      worker?.terminate()
      db = null
      conn = null
      initPromise = null // a later call may retry
      throw err
    })

  return initPromise
}

/**
 * Create database schema
 */
async function createSchema(): Promise<void> {
  if (!conn) {
    throw new Error('Database not initialized')
  }

  const statements = splitSqlStatements(SCHEMA_SQL)
  for (const stmt of statements) {
    await conn.query(stmt)
  }
}

/**
 * Get database connection (initializes if needed)
 */
export async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!conn) {
    await initDatabase()
  }
  return conn!
}

/**
 * Get database instance
 */
export async function getDatabase(): Promise<duckdb.AsyncDuckDB> {
  if (!db) {
    await initDatabase()
  }
  return db!
}

/**
 * Reset database (drop and recreate all tables)
 */
export async function resetDatabase(): Promise<void> {
  const connection = await getConnection()

  // Drop all tables
  const dropStatements = splitSqlStatements(DROP_TABLES_SQL)
  for (const stmt of dropStatements) {
    await connection.query(stmt)
  }

  // Recreate schema
  await createSchema()
}

/**
 * Execute a query and return results
 */
export async function query<T>(sql: string): Promise<T[]> {
  const connection = await getConnection()
  const result = await connection.query(sql)
  return result.toArray() as T[]
}

/**
 * Execute a query and return single result
 */
export async function queryOne<T>(sql: string): Promise<T | null> {
  const results = await query<T>(sql)
  return results.length > 0 ? results[0] : null
}

/**
 * Check if database is initialized
 */
export function isInitialized(): boolean {
  return conn !== null
}

/**
 * Record whether the current capture's packets made it into the database.
 * Set by the loader; consulted by everything that would otherwise query
 * tables that are silently empty.
 */
export function markDataLoaded(loaded: boolean): void {
  dataLoaded = loaded
}

/**
 * True only when the database is up AND the current capture's packets were
 * loaded into it. `isInitialized()` alone is the wrong gate for querying:
 * a connection can be healthy while the load failed, and querying empty
 * tables "succeeds" with zero rows — which the UI would happily present as
 * "no packets matched".
 */
export function isDataLoaded(): boolean {
  return conn !== null && dataLoaded
}
