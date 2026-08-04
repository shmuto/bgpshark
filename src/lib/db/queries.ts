/**
 * DuckDB Query Functions
 *
 * Boundary: DuckDB serves two callers only - filter acceleration
 * (getMatchingFrameIndexes, used by useFilter.ts) and the SQL console
 * (executeRawSql, used by SqlConsolePage.tsx). Per-page aggregations (neighbor
 * stats, prefix stats, ...) are computed in memory with useMemo in the pages
 * that need them, so those analysis screens keep working when DuckDB is
 * unavailable.
 *
 * DuckDB decides *which* packets match a filter; it never reconstitutes the
 * packets themselves. The tables are a flattened projection built for querying
 * and cannot represent everything the parser produces: the capabilities table,
 * for instance, has columns for a single AFI/SAFI pair and an AS number, which
 * cannot hold ADD-PATH's per-family list or Graceful Restart's forwarding
 * state. Rebuilding BgpPacket objects from those rows silently dropped that
 * data and crashed the OPEN detail view as soon as a filter was applied. Frame
 * indexes are the only thing crossing this boundary; the caller maps them back
 * onto the parsed objects it already holds, which are authoritative.
 */
import { getConnection } from './database'
import { expressionToSql } from './filter-to-sql'
import { parseQuery } from '../filter/parser'

/**
 * Frame indexes of the packets matching a filter expression, in capture order.
 *
 * An empty or unparseable filter matches everything, mirroring the in-memory
 * evaluator, which leaves the packet list untouched rather than emptying it
 * while the user is still typing.
 */
export async function getMatchingFrameIndexes(filterQuery?: string): Promise<number[]> {
  const conn = await getConnection()

  let whereClause = '1=1'
  if (filterQuery && filterQuery.trim()) {
    const parsed = parseQuery(filterQuery)
    if (parsed.errors.length === 0 && parsed.expression) {
      whereClause = expressionToSql(parsed.expression)
    }
  }

  const result = await conn.query(`
    SELECT p.frame_index
    FROM packets p
    WHERE ${whereClause}
    ORDER BY p.frame_index
  `)

  return result.toArray().map((row) => Number((row as { frame_index: number }).frame_index))
}

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

