/**
 * DuckDB WASM Database Management
 */
import * as duckdb from '@duckdb/duckdb-wasm'
import { SCHEMA_SQL, DROP_TABLES_SQL } from './schema'

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
    // Select bundle based on browser capabilities
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles()
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES)

    // Create worker
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })
    )
    const worker = new Worker(workerUrl)
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)

    // Instantiate database
    db = new duckdb.AsyncDuckDB(logger, worker)
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
