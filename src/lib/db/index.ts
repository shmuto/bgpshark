/**
 * DuckDB Module Exports
 */
export { initDatabase, getConnection, resetDatabase, isInitialized } from './database'
export { loadPackets } from './loader'
export { expressionToSql } from './filter-to-sql'
export {
  getPackets,
  getPacketCount,
  getFilteredFrameIndexes,
  getPacketByFrameIndex,
  getNeighborStats,
  getAsPathStats,
  getPrefixStats,
  executeRawSql,
  getPacketsWithRawSql,
  type NeighborStats,
  type AsStats,
  type PrefixStats,
  type SqlQueryResult,
} from './queries'
