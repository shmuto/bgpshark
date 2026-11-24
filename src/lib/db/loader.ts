/**
 * Data Loader - Load BgpPacket[] into DuckDB
 */
import { yieldToPage } from '../yield-to-page'
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
import {
  BoolColumn,
  NumberColumn,
  TextColumn,
  TextListColumn,
  batchToIpc,
  tableBatch,
  type Column,
  type TableBatch,
} from './arrow-columns'

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

/**
 * The ten tables' columns for one chunk, by the names the schema gives them.
 *
 * A column's kind is its Arrow transport type, not its declared SQL type: see
 * `arrow-columns.ts`. Listing them here, once, is what replaced the row
 * object types the extract functions used to build — a column added to the
 * schema and not here is caught by the named-column `INSERT ... SELECT`.
 */
function createBatches() {
  const n = () => new NumberColumn()
  const b = () => new BoolColumn()
  const t = () => new TextColumn()
  const prefixColumns = () => ({
    id: n(),
    message_id: n(),
    prefix: t(),
    prefix_length: n(),
    prefix_bits: t(),
    afi: n(),
    safi: n(),
    evpn_route_type: n(),
    evpn_type_name: t(),
    evpn_rd: t(),
    evpn_mac: t(),
    evpn_ip: t(),
    evpn_vni: n(),
    evpn_vni2: n(),
    evpn_esi: t(),
    evpn_eth_tag: n(),
  })
  return {
    packets: tableBatch('packets', () => ({
      frame_index: n(),
      timestamp: t(),
      src_ip: t(),
      dst_ip: t(),
      src_ip_bits: t(),
      dst_ip_bits: t(),
      src_port: n(),
      dst_port: n(),
      parse_warnings: new TextListColumn(),
    })),
    messages: tableBatch('messages', () => ({
      id: n(),
      frame_index: n(),
      message_index: n(),
      type: t(),
      version: n(),
      my_as: n(),
      hold_time: n(),
      router_id: t(),
      error_code: n(),
      error_subcode: n(),
      error_code_name: t(),
      error_subcode_name: t(),
      afi: n(),
      safi: n(),
      afi_name: t(),
      safi_name: t(),
    })),
    capabilities: tableBatch('capabilities', () => ({
      id: n(),
      message_id: n(),
      code: n(),
      name: t(),
      cap_type: t(),
      cap_afi: n(),
      cap_afi_name: t(),
      cap_safi: n(),
      cap_safi_name: t(),
      cap_as_number: n(),
    })),
    pathAttributes: tableBatch('path_attributes', () => ({
      id: n(),
      message_id: n(),
      type_code: n(),
      type_name: t(),
      flags_optional: b(),
      flags_transitive: b(),
      flags_partial: b(),
      flags_extended: b(),
      origin_value: t(),
      next_hop: t(),
      med_value: n(),
      local_pref: n(),
      aggregator_as: n(),
      aggregator_addr: t(),
    })),
    asPath: tableBatch('as_path', () => ({
      id: n(),
      message_id: n(),
      segment_type: t(),
      segment_index: n(),
      as_index: n(),
      asn: n(),
    })),
    nlri: tableBatch('nlri', prefixColumns),
    withdrawn: tableBatch('withdrawn', prefixColumns),
    communities: tableBatch('communities', () => ({
      id: n(),
      message_id: n(),
      asn: n(),
      value: n(),
      formatted: t(),
    })),
    largeCommunities: tableBatch('large_communities', () => ({
      id: n(),
      message_id: n(),
      global_admin: n(),
      local_data1: n(),
      local_data2: n(),
      formatted: t(),
    })),
    extCommunities: tableBatch('extended_communities', () => ({
      id: n(),
      message_id: n(),
      kind: t(),
      value: t(),
      formatted: t(),
      transitive: b(),
      type_code: n(),
      subtype: n(),
    })),
  }
}

type Batches = ReturnType<typeof createBatches>
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
  const pendingRows = () => tables.reduce((sum, table) => sum + table.rows, 0)

  let inFlight: Promise<void> = Promise.resolve()
  // Packets whose rows are in the chunk in flight: inserted once it lands.
  let sentThrough = 0
  const flush = async (done: number) => {
    const chunk = tables
      .filter((table) => table.rows > 0)
      .map((table) => ({ name: table.name, columns: Object.keys(table.columns), ipc: batchToIpc(arrow, table) }))
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

/** One packet's rows, appended to the batches. */
function flattenPacket(batches: Batches, packet: BgpPacket): void {
  const p = batches.packets
  const row = p.rows++
  const c = p.columns
  c.frame_index.set(row, packet.frameIndex)
  c.timestamp.set(row, packet.timestamp.toISOString())
  c.src_ip.set(row, packet.srcIp)
  c.dst_ip.set(row, packet.dstIp)
  c.src_ip_bits.set(row, addressBitKey(packet.srcIp))
  c.dst_ip_bits.set(row, addressBitKey(packet.dstIp))
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
 * Send one chunk: every table into a staging table of its own, then a single
 * statement that moves each into its real table and drops the staging.
 *
 * The staging tables are sent together and awaited together — the order they
 * arrive in does not matter — so a chunk costs the worker two round trips
 * rather than three per table. That matters now that the page is busy
 * flattening the next chunk in between: each round trip waits for the page to
 * yield before the next request goes out.
 *
 * The rows go through a staging table and a named-column `INSERT ... SELECT`
 * rather than straight into the target, for two reasons. Inserting into an
 * existing table binds Arrow columns by *position*, so a column added to the
 * schema but not to `createBatches` — or in a different order — would land
 * silently in the wrong place; naming them means each value can only reach the
 * column it was meant for. And the SELECT is where DuckDB casts each column to
 * its declared type, see `arrow-columns.ts`.
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
async function insertChunk(
  conn: AsyncDuckDBConnection,
  chunk: Array<{ name: string; columns: string[]; ipc: Uint8Array }>
): Promise<void> {
  if (chunk.length === 0) return
  const staging = (name: string) => `__load_${name}`
  await Promise.all(
    chunk.map(({ name, ipc }) => conn.insertArrowFromIPCStream(ipc, { name: staging(name), create: true }))
  )
  const statements = chunk.flatMap(({ name, columns }) => {
    const list = columns.map((column) => `"${column}"`).join(', ')
    return [`INSERT INTO ${name} (${list}) SELECT ${list} FROM ${staging(name)}`]
  })
  try {
    await conn.query(statements.join(';\n'))
  } finally {
    await conn.query(chunk.map(({ name }) => `DROP TABLE IF EXISTS ${staging(name)}`).join(';\n'))
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
  c.prefix.set(row, prefix.prefix)
  c.prefix_length.set(row, prefix.length)
  c.prefix_bits.set(row, bgpPrefixBitKey(prefix))
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
