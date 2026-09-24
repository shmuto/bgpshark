/**
 * Data Loader - Load BgpPacket[] into DuckDB
 */
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { getConnection, resetDatabase, markDataLoaded } from './database'
import { addressBitKey, bgpPrefixBitKey } from '../net/prefix'
import type {
  BgpPacket,
  BgpMessage,
  BgpOpenMessage,
  BgpUpdateMessage,
  BgpNotificationMessage,
  BgpRouteRefreshMessage,
  BgpPathAttribute,
  BgpPrefix,
  AsPathAttribute,
  CommunitiesAttribute,
  ExtendedCommunitiesAttribute,
  LargeCommunitiesAttribute,
  MpReachNlriAttribute,
  MpUnreachNlriAttribute,
} from '../bgp/types'
import { formatExtendedCommunity } from '../bgp/extended-communities'

// Helper function to convert Uint8Array to Base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * A row of `nlri` or `withdrawn`. Named because the two tables share it and
 * both the buffer and the function taking it repeat the shape otherwise —
 * which is how a column added to one and forgotten in the other happens.
 */
interface PrefixRow {
  id: number
  message_id: number
  prefix: string
  prefix_length: number
  prefix_bits: string | null
  afi: number
  safi: number
  evpn_route_type: number | null
  evpn_type_name: string | null
  evpn_rd: string | null
  evpn_mac: string | null
  evpn_ip: string | null
  evpn_vni: number | null
  evpn_vni2: number | null
  evpn_esi: string | null
  evpn_eth_tag: number | null
}

interface ExtendedCommunityRow {
  id: number
  message_id: number
  kind: string
  value: string
  formatted: string
  transitive: boolean
  type_code: number
  subtype: number
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
let extCommunityIdCounter = 0

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
 * Load packets into DuckDB.
 *
 * Calls are serialised rather than rejected or coalesced: each one is a
 * complete "make the database hold exactly this capture", so the last caller
 * still describes the state the app wants when the queue drains.
 */
export async function loadPackets(packets: BgpPacket[]): Promise<void> {
  // A failed load must not poison the queue for the next caller, hence the
  // swallow on the tail — the error still reaches this call's own awaiter.
  const run = loadQueue.catch(() => {}).then(() => runLoad(packets))
  loadQueue = run.catch(() => {})
  return run
}

async function runLoad(packets: BgpPacket[]): Promise<void> {
  // Until the load below completes, the tables must be treated as absent —
  // a partial or failed load left as "loaded" is exactly the state that made
  // every filter silently return zero packets.
  markDataLoaded(false)

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
  extCommunityIdCounter = 0

  const conn = await getConnection()

  await insertPackets(conn, packets)

  markDataLoaded(true)
}

/**
 * Flatten every packet into the rows of the ten tables, then insert each table.
 */
async function insertPackets(conn: AsyncDuckDBConnection, packets: BgpPacket[]): Promise<void> {
  // Prepare data arrays
  const packetsData: Array<{
    frame_index: number
    timestamp: string
    src_ip: string
    dst_ip: string
    src_ip_bits: string | null
    dst_ip_bits: string | null
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

  const nlriData: PrefixRow[] = []
  const withdrawnData: PrefixRow[] = []
  const extCommunitiesData: ExtendedCommunityRow[] = []

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
      src_ip_bits: addressBitKey(packet.srcIp),
      dst_ip_bits: addressBitKey(packet.dstIp),
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
          largeCommunitiesData,
          extCommunitiesData
        )
      }
    }
  }

  await insertRows(conn, 'packets', packetsData)
  await insertRows(conn, 'messages', messagesData)
  await insertRows(conn, 'capabilities', capabilitiesData)
  await insertRows(conn, 'path_attributes', pathAttrsData)
  await insertRows(conn, 'as_path', asPathData)
  await insertRows(conn, 'nlri', nlriData)
  await insertRows(conn, 'withdrawn', withdrawnData)
  await insertRows(conn, 'communities', communitiesData)
  await insertRows(conn, 'large_communities', largeCommunitiesData)
  await insertRows(conn, 'extended_communities', extCommunitiesData)
}

/**
 * How many rows go into one Arrow batch.
 *
 * Not a performance knob so much as a memory one: the rows are already in the
 * JS heap once, and a batch is copied twice more — into Arrow vectors, then
 * into the IPC buffer handed to the worker. Bounding the batch bounds those
 * copies, which matters for the `packets` table, where every row carries its
 * frame as base64.
 */
const ROWS_PER_BATCH = 50_000

type Arrow = typeof import('apache-arrow')

/**
 * One column of a batch as an Arrow vector, typed from the values it holds.
 *
 * The type is deliberately loose, and deliberately not the table's declared
 * type: the rows land in a staging table first and reach the real one through
 * `INSERT ... SELECT`, so DuckDB casts each column to what the schema says,
 * exactly as it cast the literals of the `VALUES` statements this replaced.
 * That is why numbers travel as Float64 rather than Int32 — every value the
 * parsers emit fits one exactly, and an out-of-range one (a 4-byte ASN in an
 * INTEGER column) fails the cast loudly instead of wrapping silently in a
 * typed array. A column that is NULL in every row carries no evidence either
 * way, and goes as Utf8, which casts from NULL to anything.
 *
 * The buffers are laid out by hand rather than through `vectorFromArray`, for
 * two reasons. Arrow's builders compile their null checks with `new Function`,
 * which the production CSP (`script-src 'self' 'wasm-unsafe-eval'`) refuses —
 * and, as with the extension fetch described at `insertRows`, the dev server
 * has no CSP to say so. And they are slow: several times what DuckDB then
 * spends reading the result, which made them most of the load time once the
 * SQL parser was out of the way. Nothing in this file may call a builder (`vectorFromArray`,
 * `tableFromArrays`, `tableFromJSON`, `makeBuilder`).
 *
 * Non-finite numbers become NULL because that is what the loader has always
 * done with them — first through `JSON.stringify`, then through the literal
 * writer — and a change of transport should not quietly start writing `NaN`
 * into an INTEGER column.
 */
function columnVector(arrow: Arrow, rows: Record<string, unknown>[], column: string): import('apache-arrow').Vector {
  const length = rows.length
  const values = rows.map((row) => row[column] ?? null)
  const sample = values.find((value) => value !== null)
  const { nullBitmap, nullCount } = validity(values, (value) => value !== null)

  if (typeof sample === 'number') {
    const data = new Float64Array(length)
    const finite = validity(values, (value) => typeof value === 'number' && Number.isFinite(value))
    for (let i = 0; i < length; i++) if (typeof values[i] === 'number') data[i] = values[i] as number
    return arrow.makeVector(arrow.makeData({ type: new arrow.Float64(), length, ...finite, data }))
  }

  if (typeof sample === 'boolean') {
    const data = new Uint8Array((length + 7) >> 3)
    for (let i = 0; i < length; i++) if (values[i] === true) data[i >> 3] |= 1 << (i & 7)
    return arrow.makeVector(arrow.makeData({ type: new arrow.Bool(), length, nullBitmap, nullCount, data }))
  }

  // The only list column is `parse_warnings`, which is text: the child is one
  // Utf8 column of every warning back to back, and the offsets say which rows
  // they belong to.
  if (Array.isArray(sample)) {
    const valueOffsets = new Int32Array(length + 1)
    const items: string[] = []
    for (let i = 0; i < length; i++) {
      const list = values[i] as string[] | null
      if (list) items.push(...list)
      valueOffsets[i + 1] = items.length
    }
    const child = new arrow.Field('item', new arrow.Utf8(), true)
    return arrow.makeVector(
      arrow.makeData({
        type: new arrow.List(child),
        length,
        nullBitmap,
        nullCount,
        valueOffsets,
        child: utf8Data(arrow, items),
      })
    )
  }

  return arrow.makeVector(utf8Data(arrow, values))
}

/** Which of `values` are present, as the bitmap Arrow keeps beside a column. */
function validity(
  values: unknown[],
  isPresent: (value: unknown) => boolean
): { nullBitmap: Uint8Array; nullCount: number } {
  const nullBitmap = new Uint8Array((values.length + 7) >> 3)
  let nullCount = 0
  for (let i = 0; i < values.length; i++) {
    if (isPresent(values[i])) nullBitmap[i >> 3] |= 1 << (i & 7)
    else nullCount++
  }
  return { nullBitmap, nullCount }
}

/**
 * A Utf8 column: every string back to back, with offsets marking where each
 * ends. Nearly all of it is ASCII — addresses, prefixes, names, base64 — so
 * bytes are written directly and only a string that needs it goes through the
 * encoder.
 */
function utf8Data(arrow: Arrow, values: unknown[]): import('apache-arrow').Data<import('apache-arrow').Utf8> {
  const length = values.length
  const { nullBitmap, nullCount } = validity(values, (value) => value !== null)
  const valueOffsets = new Int32Array(length + 1)
  let bytes = new Uint8Array(Math.max(1024, length * 16))
  let used = 0
  const encoder = new TextEncoder()
  for (let i = 0; i < length; i++) {
    if (values[i] !== null) {
      const text = String(values[i])
      // UTF-8 never needs more than three bytes per UTF-16 unit.
      if (used + text.length * 3 > bytes.length) {
        const grown = new Uint8Array(Math.max(bytes.length * 2, used + text.length * 3))
        grown.set(bytes.subarray(0, used))
        bytes = grown
      }
      let ascii = true
      for (let j = 0; j < text.length; j++) {
        const code = text.charCodeAt(j)
        if (code > 0x7f) {
          ascii = false
          break
        }
        bytes[used + j] = code
      }
      used += ascii ? text.length : encoder.encodeInto(text, bytes.subarray(used)).written
    }
    valueOffsets[i + 1] = used
  }
  return arrow.makeData({
    type: new arrow.Utf8(),
    length,
    nullBitmap,
    nullCount,
    valueOffsets,
    data: bytes.subarray(0, used),
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
 * which the app showed nothing but a spinner, because the packet list waits
 * on the load. People reasonably concluded it had hung.
 *
 * Arrow skips the parser entirely and is built into the WASM build, not an
 * extension, so it keeps the promise that loading a capture touches no network
 * (`offline.e2e.ts` holds it to that). The same capture now loads in a few
 * seconds.
 *
 * The rows go through a staging table and a named-column `INSERT ... SELECT`
 * rather than straight into the target, for two reasons. Inserting into an
 * existing table binds Arrow columns by *position*, so a column added to the
 * schema but not to the row object — or in a different order — would land
 * silently in the wrong place; naming them means each value can only reach the
 * column it was meant for. And the
 * SELECT is where DuckDB casts each column to its declared type, see
 * `columnVector`.
 */
async function insertRows(
  conn: AsyncDuckDBConnection,
  tableName: string,
  data: unknown[]
): Promise<void> {
  if (data.length === 0) return

  // Imported here, like DuckDB itself in `initDatabase`, so Arrow is fetched
  // with the database rather than weighing down the upload screen's bundle.
  const arrow = await import('apache-arrow')

  const rows = data as Record<string, unknown>[]
  const columns = Object.keys(rows[0])
  const columnList = columns.map((c) => `"${c}"`).join(', ')
  const staging = `__load_${tableName}`

  for (let start = 0; start < rows.length; start += ROWS_PER_BATCH) {
    const batch = rows.slice(start, start + ROWS_PER_BATCH)
    const vectors: Record<string, import('apache-arrow').Vector> = {}
    for (const column of columns) vectors[column] = columnVector(arrow, batch, column)
    const table = new arrow.Table(vectors)

    // `insertArrowTable` does exactly this serialisation, but with the copy of
    // apache-arrow DuckDB bundles; doing it here with ours means the Table
    // object never has to be recognised across two copies of the library.
    await conn.insertArrowFromIPCStream(arrow.tableToIPC(table, 'stream'), {
      name: staging,
      create: true,
    })
    try {
      await conn.query(`INSERT INTO ${tableName} (${columnList}) SELECT ${columnList} FROM ${staging}`)
    } finally {
      await conn.query(`DROP TABLE IF EXISTS ${staging}`)
    }
  }
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
  nlriData: PrefixRow[],
  withdrawnData: PrefixRow[],
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
  }>,
  extCommunitiesData: ExtendedCommunityRow[]
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

    // Extract extended communities
    if (attr.parsed?.type === 'EXTENDED_COMMUNITIES') {
      for (const community of (attr.parsed as ExtendedCommunitiesAttribute).communities) {
        extCommunitiesData.push({
          id: ++extCommunityIdCounter,
          message_id: messageId,
          kind: community.kind,
          value: community.value,
          formatted: formatExtendedCommunity(community),
          transitive: community.transitive,
          type_code: community.typeCode,
          subtype: community.subtype,
        })
      }
    }

    // Extract MP_REACH_NLRI
    if (attr.parsed?.type === 'MP_REACH_NLRI') {
      const mp = attr.parsed as MpReachNlriAttribute
      for (const prefix of mp.nlri) {
        nlriData.push(prefixRow(++nlriIdCounter, messageId, prefix, mp.afi, mp.safi))
      }
    }

    // Extract MP_UNREACH_NLRI
    if (attr.parsed?.type === 'MP_UNREACH_NLRI') {
      const mp = attr.parsed as MpUnreachNlriAttribute
      for (const prefix of mp.withdrawnRoutes) {
        withdrawnData.push(prefixRow(++withdrawnIdCounter, messageId, prefix, mp.afi, mp.safi))
      }
    }
  }

  // IPv4 NLRI
  for (const prefix of msg.nlri) {
    nlriData.push(prefixRow(++nlriIdCounter, messageId, prefix, 1, 1))
  }

  // IPv4 Withdrawn
  for (const prefix of msg.withdrawnRoutes) {
    withdrawnData.push(prefixRow(++withdrawnIdCounter, messageId, prefix, 1, 1))
  }
}

/**
 * One row of `nlri` or `withdrawn`. EVPN routes fill the evpn_* columns as
 * well; every other family leaves them NULL, which is what makes
 * `WHERE evpn_mac = …` a question SQL can answer over a mixed capture.
 */
function prefixRow(
  id: number,
  messageId: number,
  prefix: BgpPrefix,
  afi: number,
  safi: number
): PrefixRow {
  const evpn = prefix.evpn
  return {
    id,
    message_id: messageId,
    prefix: prefix.prefix,
    prefix_length: prefix.length,
    prefix_bits: bgpPrefixBitKey(prefix),
    afi,
    safi,
    evpn_route_type: evpn?.routeType ?? null,
    evpn_type_name: evpn?.routeTypeName ?? null,
    evpn_rd: evpn?.rd ?? null,
    evpn_mac: evpn?.macAddress ?? null,
    evpn_ip: evpn?.ipAddress ?? null,
    evpn_vni: evpn?.label ?? null,
    evpn_vni2: evpn?.label2 ?? null,
    evpn_esi: evpn?.esi ?? null,
    evpn_eth_tag: evpn?.ethernetTag ?? null,
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
