/**
 * DuckDB Query Functions
 *
 * Boundary: DuckDB serves the SQL console only (executeRawSql, used by
 * SqlConsolePage.tsx). Filtering and every per-page aggregation (neighbor
 * stats, prefix stats, ...) are computed in memory from the parsed packets, so
 * every other screen works without the database — and a capture is inserted
 * into it only once the SQL console asks for it.
 *
 * The tables are a flattened projection built for querying and cannot
 * represent everything the parser produces: the capabilities table, for
 * instance, has columns for a single AFI/SAFI pair and an AS number, which
 * cannot hold ADD-PATH's per-family list or Graceful Restart's forwarding
 * state. They lead back to the parsed packets through `frame_index`; nothing
 * rebuilds packets from rows.
 */
import { getConnection } from './database'

/**
 * Outcome of a raw SQL query.
 *
 * A failure used to be an optional `error` field alongside empty columns and
 * rows, which reads exactly like a query that legitimately matched nothing — the
 * console rendered "0 rows" for a typo'd table name. The discriminated union
 * makes the caller pick a branch, so a failure cannot be mistaken for an empty
 * result set again.
 */
export type SqlQueryResult =
  | {
      ok: true
      columns: string[]
      rows: Record<string, unknown>[]
      rowCount: number
      executionTime: number
    }
  | { ok: false; error: string; executionTime: number }

/**
 * Execute a raw SQL query against DuckDB
 * Returns columnar results that can be displayed in a table
 */
export async function executeRawSql(sql: string): Promise<SqlQueryResult> {
  const startTime = performance.now()

  try {
    const conn = await getConnection()
    const result = await conn.query(sql)

    const executionTime = performance.now() - startTime

    // Get column names from schema
    const columns = result.schema.fields.map((f) => f.name)

    // Convert to array of objects
    const rows = result.toArray().map((row) => {
      const obj: Record<string, unknown> = {}
      for (const col of columns) {
        const value = (row as Record<string, unknown>)[col]
        // Convert BigInt to number for display
        if (typeof value === 'bigint') {
          obj[col] = Number(value)
        } else if (value instanceof Date) {
          obj[col] = value.toISOString()
        } else {
          obj[col] = value
        }
      }
      return obj
    })

    return {
      ok: true,
      columns,
      rows,
      rowCount: rows.length,
      executionTime,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      executionTime: performance.now() - startTime,
    }
  }
}

