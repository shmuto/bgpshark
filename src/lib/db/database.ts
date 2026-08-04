/**
 * DuckDB WASM Database Management
 */
import type * as duckdb from '@duckdb/duckdb-wasm'
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import { SCHEMA_SQL, DROP_TABLES_SQL } from './schema'

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

/**
 * Initialize DuckDB WASM
 */
export async function initDatabase(): Promise<void> {
  if (initPromise) {
    return initPromise
  }

  initPromise = (async () => {
    // Imported here rather than at the top of the file so the ~250kB of DuckDB
    // glue is fetched alongside the database it drives, instead of sitting in
    // the bundle the upload screen has to download before it can paint.
    const duckdbModule = await import('@duckdb/duckdb-wasm')

    // Select bundle based on browser capabilities
    const bundle = await duckdbModule.selectBundle(BUNDLES)

    // Create worker directly from the same-origin URL (no blob wrapper needed)
    const worker = new Worker(bundle.mainWorker!)
    const logger = new duckdbModule.ConsoleLogger(duckdbModule.LogLevel.WARNING)

    // Instantiate database
    db = new duckdbModule.AsyncDuckDB(logger, worker)
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)

    // Create connection
    conn = await db.connect()

    // Create schema
    await createSchema()
  })()

  return initPromise
}

/**
 * Create database schema
 */
async function createSchema(): Promise<void> {
  if (!conn) {
    throw new Error('Database not initialized')
  }

  // Split and execute each statement
  const statements = SCHEMA_SQL.split(';').filter((s) => s.trim())
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
  const dropStatements = DROP_TABLES_SQL.split(';').filter((s) => s.trim())
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
