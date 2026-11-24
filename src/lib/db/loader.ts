/**
 * Data Loader - Load BgpPacket[] into DuckDB
 */
import { yieldToPage } from '../yield-to-page'
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { getConnection, resetDatabase, markDataLoaded, CAPTURE_CATALOG } from './database'
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
import { StringDictionaryColumn, batchToIpc, type Column, type TableBatch } from './arrow-columns'
import { createBatches, type Batches } from './load-batches'

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
export async function loadPackets(
  packets: BgpPacket[],
  onProgress?: LoadProgressCallback
): Promise<void> {
  // A failed load must not poison the queue for the next caller, hence the
  // swallow on the tail — the error still reaches this call's own awaiter.
  const run = loadQueue.catch(() => {}).then(() => runLoad(packets, onProgress))
  loadQueue = run.catch(() => {})
  return run
}

/**
 * Drop the capture's tables, once the app has moved on to another capture or
 * none. Queued behind any load in flight, for the reasons `loadQueue` gives.
 */
export async function unloadPackets(): Promise<void> {
  const run = loadQueue.catch(() => {}).then(async () => {
    markDataLoaded(false)
    await resetDatabase()
  })
  loadQueue = run.catch(() => {})
  return run
}

/**
 * Packets inserted so far, out of the capture's BGP packets.
 *
 * Packets rather than rows because the load flattens and inserts a chunk at a
 * time, so the total number of rows is not known until the end. It is called
 * once with `done` at zero, then after every chunk, and a last time with
 * `done === total`.
 */
export type LoadProgressCallback = (done: number, total: number) => void

async function runLoad(packets: BgpPacket[], onProgress?: LoadProgressCallback): Promise<void> {
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

  await insertPackets(conn, packets, onProgress)

  markDataLoaded(true)
}

type PrefixBatch = Batches['nlri']

/**
 * How many rows, across all ten tables, to gather before sending them. Large
 * enough that the per-chunk overhead (a staging table per table, one
 * `INSERT ... SELECT` statement) stays small next to the rows it moves; small
 * enough that a chunk's buffers never dominate the heap.
 */
const ROWS_PER_FLUSH = 250_000

/** How long the flattening may hold the page before yielding, as elsewhere. */
const FLATTEN_SLICE_MS = 12

/**
 * Flatten the packets into the ten tables' columns and insert them, a chunk at
 * a time — building each chunk while the DuckDB worker inserts the one before.
 *
 * The two used to take turns: the page flattened a chunk while the worker sat
 * idle, then waited, idle itself, for the worker to insert it. On a 45MB
 * capture each was roughly half of a load of over twenty seconds. Now the
 * worker is handed a chunk and the page moves straight on to the next one,
 * so a load takes as long as the slower of the two rather than both.
 *
 * At most one chunk is in flight: the page waits for it before sending the
 * next, which keeps the buffers alive at once to two chunks' worth.
 */
async function insertPackets(
  conn: AsyncDuckDBConnection,
  packets: BgpPacket[],
  onProgress?: LoadProgressCallback
): Promise<void> {
  // Imported here, like DuckDB itself in `initDatabase`, so Arrow is fetched
  // with the database rather than weighing down the upload screen's bundle.
  const arrow = await import('apache-arrow')
  const batches = createBatches()
  const tables: Array<TableBatch<Record<string, Column>> & { reset(): void }> = Object.values(batches)
  await checkColumnOrder(conn, tables)
  const pendingRows = () => tables.reduce((sum, table) => sum + table.rows, 0)

  let inFlight: Promise<void> = Promise.resolve()
  // Packets whose rows are in the chunk in flight: inserted once it lands.
  let sentThrough = 0
  const flush = async (done: number) => {
    const chunk = tables
      .filter((table) => table.rows > 0)
      .map((table) => ({ name: table.name, ipc: batchToIpc(arrow, table) }))
    for (const table of tables) table.reset()
    // The previous chunk must be in before this one goes: that bounds memory,
    // and is where its failure, if any, surfaces.
    await inFlight
    onProgress?.(sentThrough, total)
    sentThrough = done
    inFlight = insertChunk(conn, chunk)
    // Marked handled now; the rejection still reaches whoever awaits it next.
    // Without this, a failure while the next chunk is being flattened is an
    // unhandled rejection until then.
    inFlight.catch(() => {})
  }

  const total = packets.length
  onProgress?.(0, total)
  let sliceStart = performance.now()
  for (let index = 0; index < total; index++) {
    flattenPacket(batches, packets[index])

    if (pendingRows() >= ROWS_PER_FLUSH) {
      await flush(index + 1)
      sliceStart = performance.now()
    } else if ((index & 0x3f) === 0x3f && performance.now() - sliceStart > FLATTEN_SLICE_MS) {
      // While the worker is busy with the chunk in flight there is nothing to
      // wait for, so the page would otherwise be held for the whole chunk.
      await yieldToPage()
      sliceStart = performance.now()
    }
  }
  await flush(total)
  await inFlight
  onProgress?.(total, total)
}

/** An address's bit string, worked out once per address per batch. */
function setAddressBits(column: StringDictionaryColumn, row: number, address: string): void {
  const entry = column.keys.set(row, address)
  if (entry >= 0) column.add(entry, addressBitKey(address))
}

/** One packet's rows, appended to the batches. */
function flattenPacket(batches: Batches, packet: BgpPacket): void {
  const p = batches.packets
  const row = p.rows++
  const c = p.columns
  c.frame_index.set(row, packet.frameIndex)
  c.timestamp.set(row, packet.timestamp.getTime())
  c.src_ip.set(row, packet.srcIp)
  c.dst_ip.set(row, packet.dstIp)
  setAddressBits(c.src_ip_bits, row, packet.srcIp)
  setAddressBits(c.dst_ip_bits, row, packet.dstIp)
  c.src_port.set(row, packet.srcPort)
  c.dst_port.set(row, packet.dstPort)
  c.parse_warnings.set(row, packet.parseWarnings)

  for (let msgIdx = 0; msgIdx < packet.messages.length; msgIdx++) {
    const msg = packet.messages[msgIdx]
    const messageId = ++messageIdCounter
    flattenMessage(batches.messages, msg, packet.frameIndex, msgIdx, messageId)
    if (msg.type === 'OPEN') {
      flattenOpen(batches.capabilities, msg, messageId)
    } else if (msg.type === 'UPDATE') {
      flattenUpdate(batches, msg, messageId)
    }
  }
}

/**
 * Send one chunk: each table's rows appended straight from Arrow.
 *
 * The tables are sent together and awaited together — the order they arrive
 * in does not matter — so the page is not held to one round trip per table
 * while it flattens the next chunk.
 *
 * Each batch used to land in a staging table first and reach its table
 * through a named-column `INSERT ... SELECT`, because an append binds columns
 * by *position*: a column out of place in `createBatches` would land silently
 * in its neighbour's. That wrote every row twice, and the second write was
 * most of the worker's time — on a 94MB capture of 22 million routes, about
 * 5 of the 22 seconds the SQL console waited. The order is now checked
 * instead (`checkColumnOrder`, and tests/lib/db/load-batches.test.ts against
 * the schema), and the append casts each Arrow column to the type the table
 * declares just as the SELECT did, see `arrow-columns.ts`.
 *
 * Arrow IPC itself is the third transport this loader has had; both earlier
 * ones failed in ways worth remembering.
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
 * rows across these tables, and took nearly two minutes to load.
 *
 * Arrow skips the parser entirely and is built into the WASM build, not an
 * extension, so it keeps the promise that loading a capture touches no network
 * (`offline.e2e.ts` holds it to that).
 */
async function insertChunk(conn: AsyncDuckDBConnection, chunk: Array<{ name: string; ipc: Uint8Array }>): Promise<void> {
  await Promise.all(chunk.map(({ name, ipc }) => conn.insertArrowFromIPCStream(ipc, { name, create: false })))
}

/**
 * Refuse to load if any table's columns, as `createBatches` lists them, are
 * not the live table's columns in the same order — the one mistake a
 * positional append would otherwise make silently. One small query per load.
 */
async function checkColumnOrder(
  conn: AsyncDuckDBConnection,
  tables: Array<TableBatch<Record<string, Column>>>
): Promise<void> {
  const result = await conn.query(
    `SELECT table_name, column_name FROM duckdb_columns() WHERE database_name = '${CAPTURE_CATALOG}' AND schema_name = 'main' ORDER BY table_name, column_index`
  )
  const live = new Map<string, string[]>()
  for (const row of result.toArray() as Array<{ table_name: string; column_name: string }>) {
    const columns = live.get(row.table_name) ?? []
    columns.push(row.column_name)
    live.set(row.table_name, columns)
  }
  for (const table of tables) {
    const expected = Object.keys(table.columns).join(', ')
    const actual = (live.get(table.name) ?? []).join(', ')
    if (expected !== actual) {
      throw new Error(`The loader's columns for ${table.name} (${expected}) are not the table's (${actual})`)
    }
  }
}

/**
 * One `messages` row. Columns for other message types are left unwritten,
 * which is NULL.
 */
function flattenMessage(
  batch: Batches['messages'],
  msg: BgpMessage,
  frameIndex: number,
  msgIndex: number,
  messageId: number
): void {
  const row = batch.rows++
  const c = batch.columns
  c.id.set(row, messageId)
  c.frame_index.set(row, frameIndex)
  c.message_index.set(row, msgIndex)
  c.type.set(row, msg.type)

  if (msg.type === 'OPEN') {
    const open = msg as BgpOpenMessage
    c.version.set(row, open.version)
    c.my_as.set(row, open.fourByteAs ?? open.myAs)
    c.hold_time.set(row, open.holdTime)
    c.router_id.set(row, open.bgpIdentifier)
  } else if (msg.type === 'NOTIFICATION') {
    const notif = msg as BgpNotificationMessage
    c.error_code.set(row, notif.errorCode)
    c.error_subcode.set(row, notif.errorSubcode)
    c.error_code_name.set(row, notif.errorCodeName)
    c.error_subcode_name.set(row, notif.errorSubcodeName)
  } else if (msg.type === 'ROUTE_REFRESH') {
    const rr = msg as BgpRouteRefreshMessage
    c.afi.set(row, rr.afi)
    c.safi.set(row, rr.safi)
    c.afi_name.set(row, rr.afiName)
    c.safi_name.set(row, rr.safiName)
  }
}

/** An OPEN's `capabilities` rows. */
function flattenOpen(batch: Batches['capabilities'], msg: BgpOpenMessage, messageId: number): void {
  const c = batch.columns
  for (const cap of msg.capabilities) {
    const row = batch.rows++
    c.id.set(row, ++capabilityIdCounter)
    c.message_id.set(row, messageId)
    c.code.set(row, cap.code)
    c.name.set(row, cap.name)
    c.cap_type.set(row, cap.parsed?.type ?? null)
    if (cap.parsed?.type === 'MULTIPROTOCOL') {
      c.cap_afi.set(row, cap.parsed.afi)
      c.cap_afi_name.set(row, cap.parsed.afiName)
      c.cap_safi.set(row, cap.parsed.safi)
      c.cap_safi_name.set(row, cap.parsed.safiName)
    } else if (cap.parsed?.type === 'FOUR_OCTET_AS') {
      c.cap_as_number.set(row, cap.parsed.asNumber)
    }
  }
}

/** An UPDATE's rows: its attributes and everything they carry, then its IPv4 NLRI. */
function flattenUpdate(batches: Batches, msg: BgpUpdateMessage, messageId: number): void {
  for (const attr of msg.pathAttributes) {
    flattenPathAttribute(batches.pathAttributes, attr, messageId)

    const parsed = attr.parsed
    if (!parsed) continue
    switch (parsed.type) {
      case 'AS_PATH':
        flattenAsPath(batches.asPath, parsed as AsPathAttribute, messageId)
        break
      case 'COMMUNITIES':
        flattenCommunities(batches.communities, parsed as CommunitiesAttribute, messageId)
        break
      case 'LARGE_COMMUNITIES':
        flattenLargeCommunities(batches.largeCommunities, parsed as LargeCommunitiesAttribute, messageId)
        break
      case 'EXTENDED_COMMUNITIES': {
        const batch = batches.extCommunities
        const c = batch.columns
        for (const community of (parsed as ExtendedCommunitiesAttribute).communities) {
          const row = batch.rows++
          c.id.set(row, ++extCommunityIdCounter)
          c.message_id.set(row, messageId)
          c.kind.set(row, community.kind)
          c.value.set(row, community.value)
          c.formatted.set(row, formatExtendedCommunity(community))
          c.transitive.set(row, community.transitive)
          c.type_code.set(row, community.typeCode)
          c.subtype.set(row, community.subtype)
        }
        break
      }
      case 'MP_REACH_NLRI': {
        const mp = parsed as MpReachNlriAttribute
        for (const prefix of mp.nlri) {
          flattenPrefix(batches.nlri, ++nlriIdCounter, messageId, prefix, mp.afi, mp.safi)
        }
        break
      }
      case 'MP_UNREACH_NLRI': {
        const mp = parsed as MpUnreachNlriAttribute
        for (const prefix of mp.withdrawnRoutes) {
          flattenPrefix(batches.withdrawn, ++withdrawnIdCounter, messageId, prefix, mp.afi, mp.safi)
        }
        break
      }
    }
  }

  for (const prefix of msg.nlri) {
    flattenPrefix(batches.nlri, ++nlriIdCounter, messageId, prefix, 1, 1)
  }
  for (const prefix of msg.withdrawnRoutes) {
    flattenPrefix(batches.withdrawn, ++withdrawnIdCounter, messageId, prefix, 1, 1)
  }
}

/**
 * One row of `nlri` or `withdrawn`. EVPN routes fill the evpn_* columns as
 * well; every other family leaves them NULL, which is what makes
 * `WHERE evpn_mac = …` a question SQL can answer over a mixed capture.
 */
function flattenPrefix(
  batch: PrefixBatch,
  id: number,
  messageId: number,
  prefix: BgpPrefix,
  afi: number,
  safi: number
): void {
  const row = batch.rows++
  const c = batch.columns
  c.id.set(row, id)
  c.message_id.set(row, messageId)
  const entry = c.prefix.keys.set(row, prefix)
  if (entry >= 0) {
    c.prefix.add(entry, prefix.prefix)
    c.prefix_bits.add(entry, bgpPrefixBitKey(prefix))
  }
  c.prefix_length.set(row, prefix.length)
  c.afi.set(row, afi)
  c.safi.set(row, safi)
  const evpn = prefix.evpn
  if (evpn) {
    c.evpn_route_type.set(row, evpn.routeType)
    c.evpn_type_name.set(row, evpn.routeTypeName)
    c.evpn_rd.set(row, evpn.rd)
    c.evpn_mac.set(row, evpn.macAddress)
    c.evpn_ip.set(row, evpn.ipAddress)
    c.evpn_vni.set(row, evpn.label)
    c.evpn_vni2.set(row, evpn.label2)
    c.evpn_esi.set(row, evpn.esi)
    c.evpn_eth_tag.set(row, evpn.ethernetTag)
  }
}

/** One `path_attributes` row, with the value of the attributes simple enough to have a column. */
function flattenPathAttribute(batch: Batches['pathAttributes'], attr: BgpPathAttribute, messageId: number): void {
  const row = batch.rows++
  const c = batch.columns
  c.id.set(row, ++pathAttrIdCounter)
  c.message_id.set(row, messageId)
  c.type_code.set(row, attr.typeCode)
  c.type_name.set(row, attr.typeName)
  c.flags_optional.set(row, attr.flags.optional)
  c.flags_transitive.set(row, attr.flags.transitive)
  c.flags_partial.set(row, attr.flags.partial)
  c.flags_extended.set(row, attr.flags.extendedLength)

  switch (attr.parsed?.type) {
    case 'ORIGIN':
      c.origin_value.set(row, attr.parsed.value)
      break
    case 'NEXT_HOP':
      c.next_hop.set(row, attr.parsed.address)
      break
    case 'MULTI_EXIT_DISC':
      c.med_value.set(row, attr.parsed.value)
      break
    case 'LOCAL_PREF':
      c.local_pref.set(row, attr.parsed.value)
      break
    case 'AGGREGATOR':
      c.aggregator_as.set(row, attr.parsed.asNumber)
      c.aggregator_addr.set(row, attr.parsed.address)
      break
  }
}

/** An AS_PATH's `as_path` rows, one per AS number. */
function flattenAsPath(batch: Batches['asPath'], asPath: AsPathAttribute, messageId: number): void {
  const c = batch.columns
  for (let segIdx = 0; segIdx < asPath.segments.length; segIdx++) {
    const segment = asPath.segments[segIdx]
    for (let asIdx = 0; asIdx < segment.asNumbers.length; asIdx++) {
      const row = batch.rows++
      c.id.set(row, ++asPathIdCounter)
      c.message_id.set(row, messageId)
      c.segment_type.set(row, segment.type)
      c.segment_index.set(row, segIdx)
      c.as_index.set(row, asIdx)
      c.asn.set(row, segment.asNumbers[asIdx])
    }
  }
}

/** A COMMUNITIES attribute's rows; anything not shaped `ASN:VALUE` is skipped, as it always was. */
function flattenCommunities(batch: Batches['communities'], communities: CommunitiesAttribute, messageId: number): void {
  const c = batch.columns
  for (const community of communities.communities) {
    const parts = community.split(':')
    if (parts.length !== 2) continue
    const row = batch.rows++
    c.id.set(row, ++communityIdCounter)
    c.message_id.set(row, messageId)
    c.asn.set(row, parseInt(parts[0], 10))
    c.value.set(row, parseInt(parts[1], 10))
    c.formatted.set(row, community)
  }
}

function flattenLargeCommunities(
  batch: Batches['largeCommunities'],
  largeCommunities: LargeCommunitiesAttribute,
  messageId: number
): void {
  const c = batch.columns
  for (const lc of largeCommunities.communities) {
    const row = batch.rows++
    c.id.set(row, ++largeCommunityIdCounter)
    c.message_id.set(row, messageId)
    c.global_admin.set(row, lc.globalAdmin)
    c.local_data1.set(row, lc.localData1)
    c.local_data2.set(row, lc.localData2)
    c.formatted.set(row, `${lc.globalAdmin}:${lc.localData1}:${lc.localData2}`)
  }
}
