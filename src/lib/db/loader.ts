/**
 * Data Loader - Load BgpPacket[] into DuckDB
 */
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { getConnection, getDatabase, resetDatabase } from './database'
import type {
  BgpPacket,
  BgpMessage,
  BgpOpenMessage,
  BgpUpdateMessage,
  BgpNotificationMessage,
  BgpRouteRefreshMessage,
  BgpPathAttribute,
  AsPathAttribute,
  CommunitiesAttribute,
  LargeCommunitiesAttribute,
  MpReachNlriAttribute,
  MpUnreachNlriAttribute,
} from '../bgp/types'

// Helper function to convert Uint8Array to Base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// ID counters for auto-increment
let messageIdCounter = 0
let capabilityIdCounter = 0
let pathAttrIdCounter = 0
let asPathIdCounter = 0
let nlriIdCounter = 0
let withdrawnIdCounter = 0
let communityIdCounter = 0
let largeCommunityIdCounter = 0

/**
 * Load packets into DuckDB
 */
export async function loadPackets(packets: BgpPacket[]): Promise<void> {
  // Reset database and counters
  await resetDatabase()
  messageIdCounter = 0
  capabilityIdCounter = 0
  pathAttrIdCounter = 0
  asPathIdCounter = 0
  nlriIdCounter = 0
  withdrawnIdCounter = 0
  communityIdCounter = 0
  largeCommunityIdCounter = 0

  const db = await getDatabase()
  const conn = await getConnection()

  // Register data as Arrow tables for bulk insert
  await insertPackets(conn, db, packets)
}

/**
 * Insert packets using Arrow for better performance
 */
async function insertPackets(
  conn: AsyncDuckDBConnection,
  db: Awaited<ReturnType<typeof getDatabase>>,
  packets: BgpPacket[]
): Promise<void> {
  // Prepare data arrays
  const packetsData: Array<{
    frame_index: number
    timestamp: string
    src_ip: string
    dst_ip: string
    src_port: number
    dst_port: number
    raw_data_base64: string
    parse_warnings: string[]
  }> = []

  const messagesData: Array<{
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
  }> = []

  const capabilitiesData: Array<{
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
  }> = []

  const pathAttrsData: Array<{
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
  }> = []

  const asPathData: Array<{
    id: number
    message_id: number
    segment_type: string
    segment_index: number
    as_index: number
    asn: number
  }> = []

  const nlriData: Array<{
    id: number
    message_id: number
    prefix: string
    prefix_length: number
    afi: number
    safi: number
  }> = []

  const withdrawnData: Array<{
    id: number
    message_id: number
    prefix: string
    prefix_length: number
    afi: number
    safi: number
  }> = []

  const communitiesData: Array<{
    id: number
    message_id: number
    asn: number
    value: number
    formatted: string
  }> = []

  const largeCommunitiesData: Array<{
    id: number
    message_id: number
    global_admin: number
    local_data1: number
    local_data2: number
    formatted: string
  }> = []

  // Process each packet
  for (const packet of packets) {
    packetsData.push({
      frame_index: packet.frameIndex,
      timestamp: packet.timestamp.toISOString(),
      src_ip: packet.srcIp,
      dst_ip: packet.dstIp,
      src_port: packet.srcPort,
      dst_port: packet.dstPort,
      raw_data_base64: uint8ArrayToBase64(packet.rawData),
      parse_warnings: packet.parseWarnings,
    })

    // Process each message in packet
    for (let msgIdx = 0; msgIdx < packet.messages.length; msgIdx++) {
      const msg = packet.messages[msgIdx]
      const messageId = ++messageIdCounter

      const msgData = extractMessageData(msg, packet.frameIndex, msgIdx, messageId)
      messagesData.push(msgData)

      // Extract message-specific data
      if (msg.type === 'OPEN') {
        extractOpenData(msg, messageId, capabilitiesData)
      } else if (msg.type === 'UPDATE') {
        extractUpdateData(
          msg,
          messageId,
          pathAttrsData,
          asPathData,
          nlriData,
          withdrawnData,
          communitiesData,
          largeCommunitiesData
        )
      }
    }
  }

  // Insert using JSON import for simplicity
  await insertJsonData(conn, db, 'packets', packetsData)
  await insertJsonData(conn, db, 'messages', messagesData)
  await insertJsonData(conn, db, 'capabilities', capabilitiesData)
  await insertJsonData(conn, db, 'path_attributes', pathAttrsData)
  await insertJsonData(conn, db, 'as_path', asPathData)
  await insertJsonData(conn, db, 'nlri', nlriData)
  await insertJsonData(conn, db, 'withdrawn', withdrawnData)
  await insertJsonData(conn, db, 'communities', communitiesData)
  await insertJsonData(conn, db, 'large_communities', largeCommunitiesData)
}

/**
 * Insert data using DuckDB's JSON import
 */
async function insertJsonData(
  conn: AsyncDuckDBConnection,
  db: Awaited<ReturnType<typeof getDatabase>>,
  tableName: string,
  data: unknown[]
): Promise<void> {
  if (data.length === 0) return

  // Register JSON as a view and insert
  const jsonStr = JSON.stringify(data)
  await db.registerFileText(`${tableName}.json`, jsonStr)
  await conn.query(`INSERT INTO ${tableName} SELECT * FROM read_json_auto('${tableName}.json')`)
}

/**
 * Extract message base data
 */
function extractMessageData(
  msg: BgpMessage,
  frameIndex: number,
  msgIndex: number,
  messageId: number
): {
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
} {
  const base = {
    id: messageId,
    frame_index: frameIndex,
    message_index: msgIndex,
    type: msg.type,
    version: null as number | null,
    my_as: null as number | null,
    hold_time: null as number | null,
    router_id: null as string | null,
    error_code: null as number | null,
    error_subcode: null as number | null,
    error_code_name: null as string | null,
    error_subcode_name: null as string | null,
    afi: null as number | null,
    safi: null as number | null,
    afi_name: null as string | null,
    safi_name: null as string | null,
  }

  if (msg.type === 'OPEN') {
    const open = msg as BgpOpenMessage
    base.version = open.version
    base.my_as = open.fourByteAs ?? open.myAs
    base.hold_time = open.holdTime
    base.router_id = open.bgpIdentifier
  } else if (msg.type === 'NOTIFICATION') {
    const notif = msg as BgpNotificationMessage
    base.error_code = notif.errorCode
    base.error_subcode = notif.errorSubcode
    base.error_code_name = notif.errorCodeName
    base.error_subcode_name = notif.errorSubcodeName
  } else if (msg.type === 'ROUTE_REFRESH') {
    const rr = msg as BgpRouteRefreshMessage
    base.afi = rr.afi
    base.safi = rr.safi
    base.afi_name = rr.afiName
    base.safi_name = rr.safiName
  }

  return base
}

/**
 * Extract OPEN message capabilities
 */
function extractOpenData(
  msg: BgpOpenMessage,
  messageId: number,
  capabilitiesData: Array<{
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
  }>
): void {
  for (const cap of msg.capabilities) {
    const capData = {
      id: ++capabilityIdCounter,
      message_id: messageId,
      code: cap.code,
      name: cap.name,
      cap_type: cap.parsed?.type ?? null,
      cap_afi: null as number | null,
      cap_afi_name: null as string | null,
      cap_safi: null as number | null,
      cap_safi_name: null as string | null,
      cap_as_number: null as number | null,
    }

    if (cap.parsed) {
      if (cap.parsed.type === 'MULTIPROTOCOL') {
        capData.cap_afi = cap.parsed.afi
        capData.cap_afi_name = cap.parsed.afiName
        capData.cap_safi = cap.parsed.safi
        capData.cap_safi_name = cap.parsed.safiName
      } else if (cap.parsed.type === 'FOUR_OCTET_AS') {
        capData.cap_as_number = cap.parsed.asNumber
      }
    }

    capabilitiesData.push(capData)
  }
}

/**
 * Extract UPDATE message data
 */
function extractUpdateData(
  msg: BgpUpdateMessage,
  messageId: number,
  pathAttrsData: Array<{
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
  }>,
  asPathData: Array<{
    id: number
    message_id: number
    segment_type: string
    segment_index: number
    as_index: number
    asn: number
  }>,
  nlriData: Array<{
    id: number
    message_id: number
    prefix: string
    prefix_length: number
    afi: number
    safi: number
  }>,
  withdrawnData: Array<{
    id: number
    message_id: number
    prefix: string
    prefix_length: number
    afi: number
    safi: number
  }>,
  communitiesData: Array<{
    id: number
    message_id: number
    asn: number
    value: number
    formatted: string
  }>,
  largeCommunitiesData: Array<{
    id: number
    message_id: number
    global_admin: number
    local_data1: number
    local_data2: number
    formatted: string
  }>
): void {
  // Path attributes
  for (const attr of msg.pathAttributes) {
    const attrData = extractPathAttribute(attr, messageId)
    pathAttrsData.push(attrData)

    // Extract AS_PATH
    if (attr.parsed?.type === 'AS_PATH') {
      extractAsPath(attr.parsed as AsPathAttribute, messageId, asPathData)
    }

    // Extract communities
    if (attr.parsed?.type === 'COMMUNITIES') {
      extractCommunities(attr.parsed as CommunitiesAttribute, messageId, communitiesData)
    }

    // Extract large communities
    if (attr.parsed?.type === 'LARGE_COMMUNITIES') {
      extractLargeCommunities(attr.parsed as LargeCommunitiesAttribute, messageId, largeCommunitiesData)
    }

    // Extract MP_REACH_NLRI
    if (attr.parsed?.type === 'MP_REACH_NLRI') {
      const mp = attr.parsed as MpReachNlriAttribute
      for (const prefix of mp.nlri) {
        nlriData.push({
          id: ++nlriIdCounter,
          message_id: messageId,
          prefix: prefix.prefix,
          prefix_length: prefix.length,
          afi: mp.afi,
          safi: mp.safi,
        })
      }
    }

    // Extract MP_UNREACH_NLRI
    if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
      const mp = attr.parsed as MpUnreachNlriAttribute
      for (const prefix of mp.withdrawnRoutes) {
        withdrawnData.push({
          id: ++withdrawnIdCounter,
          message_id: messageId,
          prefix: prefix.prefix,
          prefix_length: prefix.length,
          afi: mp.afi,
          safi: mp.safi,
        })
      }
    }
  }

  // IPv4 NLRI
  for (const prefix of msg.nlri) {
    nlriData.push({
      id: ++nlriIdCounter,
      message_id: messageId,
      prefix: prefix.prefix,
      prefix_length: prefix.length,
      afi: 1,
      safi: 1,
    })
  }

  // IPv4 Withdrawn
  for (const prefix of msg.withdrawnRoutes) {
    withdrawnData.push({
      id: ++withdrawnIdCounter,
      message_id: messageId,
      prefix: prefix.prefix,
      prefix_length: prefix.length,
      afi: 1,
      safi: 1,
    })
  }
}

/**
 * Extract path attribute data
 */
function extractPathAttribute(
  attr: BgpPathAttribute,
  messageId: number
): {
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
} {
  const data = {
    id: ++pathAttrIdCounter,
    message_id: messageId,
    type_code: attr.typeCode,
    type_name: attr.typeName,
    flags_optional: attr.flags.optional,
    flags_transitive: attr.flags.transitive,
    flags_partial: attr.flags.partial,
    flags_extended: attr.flags.extendedLength,
    origin_value: null as string | null,
    next_hop: null as string | null,
    med_value: null as number | null,
    local_pref: null as number | null,
    aggregator_as: null as number | null,
    aggregator_addr: null as string | null,
  }

  if (attr.parsed) {
    switch (attr.parsed.type) {
      case 'ORIGIN':
        data.origin_value = attr.parsed.value
        break
      case 'NEXT_HOP':
        data.next_hop = attr.parsed.address
        break
      case 'MULTI_EXIT_DISC':
        data.med_value = attr.parsed.value
        break
      case 'LOCAL_PREF':
        data.local_pref = attr.parsed.value
        break
      case 'AGGREGATOR':
        data.aggregator_as = attr.parsed.asNumber
        data.aggregator_addr = attr.parsed.address
        break
    }
  }

  return data
}

/**
 * Extract AS_PATH segments
 */
function extractAsPath(
  asPath: AsPathAttribute,
  messageId: number,
  asPathData: Array<{
    id: number
    message_id: number
    segment_type: string
    segment_index: number
    as_index: number
    asn: number
  }>
): void {
  for (let segIdx = 0; segIdx < asPath.segments.length; segIdx++) {
    const segment = asPath.segments[segIdx]
    for (let asIdx = 0; asIdx < segment.asNumbers.length; asIdx++) {
      asPathData.push({
        id: ++asPathIdCounter,
        message_id: messageId,
        segment_type: segment.type,
        segment_index: segIdx,
        as_index: asIdx,
        asn: segment.asNumbers[asIdx],
      })
    }
  }
}

/**
 * Extract communities
 */
function extractCommunities(
  communities: CommunitiesAttribute,
  messageId: number,
  communitiesData: Array<{
    id: number
    message_id: number
    asn: number
    value: number
    formatted: string
  }>
): void {
  for (const community of communities.communities) {
    // Parse "ASN:VALUE" format
    const parts = community.split(':')
    if (parts.length === 2) {
      communitiesData.push({
        id: ++communityIdCounter,
        message_id: messageId,
        asn: parseInt(parts[0], 10),
        value: parseInt(parts[1], 10),
        formatted: community,
      })
    }
  }
}

/**
 * Extract large communities
 */
function extractLargeCommunities(
  largeCommunities: LargeCommunitiesAttribute,
  messageId: number,
  largeCommunitiesData: Array<{
    id: number
    message_id: number
    global_admin: number
    local_data1: number
    local_data2: number
    formatted: string
  }>
): void {
  for (const lc of largeCommunities.communities) {
    largeCommunitiesData.push({
      id: ++largeCommunityIdCounter,
      message_id: messageId,
      global_admin: lc.globalAdmin,
      local_data1: lc.localData1,
      local_data2: lc.localData2,
      formatted: `${lc.globalAdmin}:${lc.localData1}:${lc.localData2}`,
    })
  }
}
