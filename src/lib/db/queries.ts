/**
 * DuckDB Query Functions
 *
 * Boundary: DuckDB serves two callers only - filter acceleration (getPackets,
 * used by useFilter.ts) and the SQL console (executeRawSql, used by
 * SqlConsolePage.tsx). Per-page aggregations (neighbor stats, prefix stats, ...)
 * are computed in memory with useMemo in the pages that need them, so those
 * analysis screens keep working when DuckDB is unavailable.
 */
import { getConnection } from './database'
import { expressionToSql } from './filter-to-sql'
import { parseQuery } from '../filter/parser'
import type {
  BgpPacket,
  BgpMessage,
  BgpOpenMessage,
  BgpUpdateMessage,
  BgpNotificationMessage,
  BgpKeepaliveMessage,
  BgpRouteRefreshMessage,
  BgpCapability,
  BgpPathAttribute,
  BgpPrefix,
  AsPathSegment,
} from '../bgp/types'

// =============================================================================
// Types for query results
// =============================================================================

interface PacketRow {
  frame_index: number
  timestamp: string
  src_ip: string
  dst_ip: string
  src_port: number
  dst_port: number
  raw_data_base64: string
  parse_warnings: string[]
}

// Helper function to convert Base64 to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  if (!base64) return new Uint8Array()
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

interface MessageRow {
  id: number
  frame_index: number
  message_index: number
  type: string
  version: number | null
  my_as: number | null
  hold_time: number | null
  router_id: string | null
  error_code: number | null
  error_subcode: number | null
  error_code_name: string | null
  error_subcode_name: string | null
  afi: number | null
  safi: number | null
  afi_name: string | null
  safi_name: string | null
}

interface CapabilityRow {
  id: number
  message_id: number
  code: number
  name: string
  cap_type: string | null
  cap_afi: number | null
  cap_afi_name: string | null
  cap_safi: number | null
  cap_safi_name: string | null
  cap_as_number: number | null
}

interface PathAttrRow {
  id: number
  message_id: number
  type_code: number
  type_name: string
  flags_optional: boolean
  flags_transitive: boolean
  flags_partial: boolean
  flags_extended: boolean
  origin_value: string | null
  next_hop: string | null
  med_value: number | null
  local_pref: number | null
  aggregator_as: number | null
  aggregator_addr: string | null
}

interface AsPathRow {
  message_id: number
  segment_type: string
  segment_index: number
  as_index: number
  asn: number
}

interface NlriRow {
  message_id: number
  prefix: string
  prefix_length: number
}

interface WithdrawnRow {
  message_id: number
  prefix: string
  prefix_length: number
}

interface CommunityRow {
  message_id: number
  formatted: string
}

interface LargeCommunityRow {
  message_id: number
  global_admin: number
  local_data1: number
  local_data2: number
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Get all packets (optionally filtered)
 */
export async function getPackets(filterQuery?: string): Promise<BgpPacket[]> {
  const conn = await getConnection()

  // Build WHERE clause
  let whereClause = '1=1'
  if (filterQuery && filterQuery.trim()) {
    const parsed = parseQuery(filterQuery)
    if (parsed.errors.length === 0 && parsed.expression) {
      whereClause = expressionToSql(parsed.expression)
    }
  }

  // Get filtered packet frame_indexes
  const packetsSql = `
    SELECT p.frame_index, p.timestamp, p.src_ip, p.dst_ip, p.src_port, p.dst_port, p.raw_data_base64, p.parse_warnings
    FROM packets p
    WHERE ${whereClause}
    ORDER BY p.frame_index
  `

  const packetsResult = await conn.query(packetsSql)
  const packetRows = packetsResult.toArray() as unknown as PacketRow[]

  if (packetRows.length === 0) {
    return []
  }

  // Get frame indexes for batch queries
  const frameIndexes = packetRows.map((p) => p.frame_index)
  const frameIndexList = frameIndexes.join(',')

  // Batch load all related data
  const [messagesResult, capabilitiesResult, pathAttrsResult, asPathResult, nlriResult, withdrawnResult, communitiesResult, largeCommunitiesResult] = await Promise.all([
    conn.query(`SELECT * FROM messages WHERE frame_index IN (${frameIndexList}) ORDER BY frame_index, message_index`),
    conn.query(`SELECT c.* FROM capabilities c JOIN messages m ON c.message_id = m.id WHERE m.frame_index IN (${frameIndexList})`),
    conn.query(`SELECT pa.* FROM path_attributes pa JOIN messages m ON pa.message_id = m.id WHERE m.frame_index IN (${frameIndexList})`),
    conn.query(`SELECT ap.* FROM as_path ap JOIN messages m ON ap.message_id = m.id WHERE m.frame_index IN (${frameIndexList}) ORDER BY ap.message_id, ap.segment_index, ap.as_index`),
    conn.query(`SELECT n.* FROM nlri n JOIN messages m ON n.message_id = m.id WHERE m.frame_index IN (${frameIndexList})`),
    conn.query(`SELECT w.* FROM withdrawn w JOIN messages m ON w.message_id = m.id WHERE m.frame_index IN (${frameIndexList})`),
    conn.query(`SELECT c.* FROM communities c JOIN messages m ON c.message_id = m.id WHERE m.frame_index IN (${frameIndexList})`),
    conn.query(`SELECT lc.* FROM large_communities lc JOIN messages m ON lc.message_id = m.id WHERE m.frame_index IN (${frameIndexList})`),
  ])

  const messageRows = messagesResult.toArray() as unknown as MessageRow[]
  const capabilityRows = capabilitiesResult.toArray() as unknown as CapabilityRow[]
  const pathAttrRows = pathAttrsResult.toArray() as unknown as PathAttrRow[]
  const asPathRows = asPathResult.toArray() as unknown as AsPathRow[]
  const nlriRows = nlriResult.toArray() as unknown as NlriRow[]
  const withdrawnRows = withdrawnResult.toArray() as unknown as WithdrawnRow[]
  const communityRows = communitiesResult.toArray() as unknown as CommunityRow[]
  const largeCommunityRows = largeCommunitiesResult.toArray() as unknown as LargeCommunityRow[]

  // Build lookup maps
  const messagesByFrame = groupBy(messageRows, (m) => m.frame_index)
  const capabilitiesByMessage = groupBy(capabilityRows, (c) => c.message_id)
  const pathAttrsByMessage = groupBy(pathAttrRows, (pa) => pa.message_id)
  const asPathByMessage = groupBy(asPathRows, (ap) => ap.message_id)
  const nlriByMessage = groupBy(nlriRows, (n) => n.message_id)
  const withdrawnByMessage = groupBy(withdrawnRows, (w) => w.message_id)
  const communitiesByMessage = groupBy(communityRows, (c) => c.message_id)
  const largeCommunitiesByMessage = groupBy(largeCommunityRows, (lc) => lc.message_id)

  // Build BgpPacket objects
  return packetRows.map((row) => {
    const messages = (messagesByFrame.get(row.frame_index) || []).map((msgRow) => {
      return buildMessage(
        msgRow,
        capabilitiesByMessage.get(msgRow.id) || [],
        pathAttrsByMessage.get(msgRow.id) || [],
        asPathByMessage.get(msgRow.id) || [],
        nlriByMessage.get(msgRow.id) || [],
        withdrawnByMessage.get(msgRow.id) || [],
        communitiesByMessage.get(msgRow.id) || [],
        largeCommunitiesByMessage.get(msgRow.id) || []
      )
    })

    return {
      frameIndex: row.frame_index,
      timestamp: new Date(row.timestamp),
      srcIp: row.src_ip,
      dstIp: row.dst_ip,
      srcPort: row.src_port,
      dstPort: row.dst_port,
      messages,
      rawData: base64ToUint8Array(row.raw_data_base64),
      parseWarnings: row.parse_warnings || [],
    }
  })
}

// =============================================================================
// Helper Functions
// =============================================================================

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    const group = map.get(key) || []
    group.push(item)
    map.set(key, group)
  }
  return map
}

function buildMessage(
  msgRow: MessageRow,
  capabilities: CapabilityRow[],
  pathAttrs: PathAttrRow[],
  asPath: AsPathRow[],
  nlri: NlriRow[],
  withdrawn: WithdrawnRow[],
  communities: CommunityRow[],
  largeCommunities: LargeCommunityRow[]
): BgpMessage {
  switch (msgRow.type) {
    case 'OPEN':
      return buildOpenMessage(msgRow, capabilities)
    case 'UPDATE':
      return buildUpdateMessage(msgRow, pathAttrs, asPath, nlri, withdrawn, communities, largeCommunities)
    case 'NOTIFICATION':
      return buildNotificationMessage(msgRow)
    case 'KEEPALIVE':
      return buildKeepaliveMessage()
    case 'ROUTE_REFRESH':
      return buildRouteRefreshMessage(msgRow)
    default:
      return buildKeepaliveMessage() // Fallback
  }
}

function buildOpenMessage(msgRow: MessageRow, capabilities: CapabilityRow[]): BgpOpenMessage {
  const caps: BgpCapability[] = capabilities.map((c) => ({
    code: c.code,
    name: c.name,
    length: 0,
    rawValue: new Uint8Array(),
    parsed: c.cap_type
      ? {
          type: c.cap_type as 'MULTIPROTOCOL' | 'FOUR_OCTET_AS',
          ...(c.cap_type === 'MULTIPROTOCOL'
            ? {
                afi: c.cap_afi!,
                afiName: c.cap_afi_name!,
                safi: c.cap_safi!,
                safiName: c.cap_safi_name!,
              }
            : {}),
          ...(c.cap_type === 'FOUR_OCTET_AS' ? { asNumber: c.cap_as_number! } : {}),
        }
      : undefined,
  })) as BgpCapability[]

  // Check for 4-byte AS capability
  const fourByteAsCap = capabilities.find((c) => c.cap_type === 'FOUR_OCTET_AS')

  return {
    type: 'OPEN',
    version: msgRow.version ?? 4,
    myAs: msgRow.my_as ?? 0,
    holdTime: msgRow.hold_time ?? 0,
    bgpIdentifier: msgRow.router_id ?? '',
    optParamLength: 0,
    capabilities: caps,
    fourByteAs: fourByteAsCap?.cap_as_number ?? undefined,
  }
}

function buildUpdateMessage(
  _msgRow: MessageRow,
  pathAttrs: PathAttrRow[],
  asPath: AsPathRow[],
  nlriRows: NlriRow[],
  withdrawnRows: WithdrawnRow[],
  communityRows: CommunityRow[],
  largeCommunityRows: LargeCommunityRow[]
): BgpUpdateMessage {
  // Build AS_PATH segments
  const asPathSegments: AsPathSegment[] = []
  const segmentMap = new Map<number, { type: string; asns: number[] }>()

  for (const ap of asPath) {
    if (!segmentMap.has(ap.segment_index)) {
      segmentMap.set(ap.segment_index, { type: ap.segment_type, asns: [] })
    }
    segmentMap.get(ap.segment_index)!.asns.push(ap.asn)
  }

  for (const [, seg] of Array.from(segmentMap.entries()).sort(([a], [b]) => a - b)) {
    asPathSegments.push({
      type: seg.type as 'AS_SET' | 'AS_SEQUENCE' | 'AS_CONFED_SEQUENCE' | 'AS_CONFED_SET',
      asNumbers: seg.asns,
    })
  }

  // Build path attributes
  const attributes: BgpPathAttribute[] = pathAttrs.map((pa) => {
    const attr: BgpPathAttribute = {
      flags: {
        optional: pa.flags_optional,
        transitive: pa.flags_transitive,
        partial: pa.flags_partial,
        extendedLength: pa.flags_extended,
      },
      typeCode: pa.type_code,
      typeName: pa.type_name,
      length: 0,
      rawValue: new Uint8Array(),
    }

    // Add parsed value based on type
    if (pa.type_name === 'ORIGIN' && pa.origin_value) {
      attr.parsed = { type: 'ORIGIN', value: pa.origin_value as 'IGP' | 'EGP' | 'INCOMPLETE' }
    } else if (pa.type_name === 'AS_PATH' && asPathSegments.length > 0) {
      attr.parsed = { type: 'AS_PATH', segments: asPathSegments }
    } else if (pa.type_name === 'NEXT_HOP' && pa.next_hop) {
      attr.parsed = { type: 'NEXT_HOP', address: pa.next_hop }
    } else if (pa.type_name === 'MULTI_EXIT_DISC' && pa.med_value !== null) {
      attr.parsed = { type: 'MULTI_EXIT_DISC', value: pa.med_value }
    } else if (pa.type_name === 'LOCAL_PREF' && pa.local_pref !== null) {
      attr.parsed = { type: 'LOCAL_PREF', value: pa.local_pref }
    } else if (pa.type_name === 'AGGREGATOR' && pa.aggregator_as !== null) {
      attr.parsed = { type: 'AGGREGATOR', asNumber: pa.aggregator_as, address: pa.aggregator_addr || '' }
    } else if (pa.type_name === 'COMMUNITIES' && communityRows.length > 0) {
      attr.parsed = { type: 'COMMUNITIES', communities: communityRows.map((c) => c.formatted) }
    } else if (pa.type_name === 'LARGE_COMMUNITIES' && largeCommunityRows.length > 0) {
      attr.parsed = {
        type: 'LARGE_COMMUNITIES',
        communities: largeCommunityRows.map((lc) => ({
          globalAdmin: lc.global_admin,
          localData1: lc.local_data1,
          localData2: lc.local_data2,
        })),
      }
    }

    return attr
  })

  // Build prefixes
  const nlri: BgpPrefix[] = nlriRows.map((n) => ({ prefix: n.prefix, length: n.prefix_length }))
  const withdrawnRoutes: BgpPrefix[] = withdrawnRows.map((w) => ({ prefix: w.prefix, length: w.prefix_length }))

  return {
    type: 'UPDATE',
    withdrawnRoutesLength: withdrawnRoutes.length,
    withdrawnRoutes,
    totalPathAttrLength: attributes.length,
    pathAttributes: attributes,
    nlri,
  }
}

function buildNotificationMessage(msgRow: MessageRow): BgpNotificationMessage {
  return {
    type: 'NOTIFICATION',
    errorCode: msgRow.error_code ?? 0,
    errorSubcode: msgRow.error_subcode ?? 0,
    errorCodeName: msgRow.error_code_name ?? '',
    errorSubcodeName: msgRow.error_subcode_name ?? '',
    data: new Uint8Array(),
    hint: '',
  }
}

function buildKeepaliveMessage(): BgpKeepaliveMessage {
  return { type: 'KEEPALIVE' }
}

function buildRouteRefreshMessage(msgRow: MessageRow): BgpRouteRefreshMessage {
  return {
    type: 'ROUTE_REFRESH',
    afi: msgRow.afi ?? 0,
    safi: msgRow.safi ?? 0,
    afiName: msgRow.afi_name ?? '',
    safiName: msgRow.safi_name ?? '',
  }
}

// =============================================================================
// Raw SQL Query Execution (Advanced Mode)
// =============================================================================

export interface SqlQueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  executionTime: number
  error?: string
}

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
      columns,
      rows,
      rowCount: rows.length,
      executionTime,
    }
  } catch (error) {
    const executionTime = performance.now() - startTime
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      executionTime,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

