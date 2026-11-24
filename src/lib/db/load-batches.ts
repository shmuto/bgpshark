import type { BgpPrefix } from '../bgp/types'
import {
  BoolColumn,
  DictionaryColumn,
  DictionaryKeys,
  Int32Column,
  NumberColumn,
  StringDictionaryColumn,
  TextColumn,
  TextListColumn,
  TimestampColumn,
  tableBatch,
} from './arrow-columns'

/**
 * The ten tables' columns for one chunk of the DuckDB load, by the names the
 * schema gives them and **in the order it declares them**.
 *
 * The order matters: a chunk is appended to its table straight from Arrow
 * (see `insertChunk` in the loader), and an append binds columns by position.
 * A column listed here out of place would land, cast or not, in its
 * neighbour's column. Two checks keep that from happening quietly:
 * tests/lib/db/load-batches.test.ts compares this list with `SCHEMA_SQL`, and
 * the loader compares it with the live tables before it inserts anything.
 *
 * A column's kind is its Arrow transport type, not its declared SQL type: see
 * `arrow-columns.ts`. Kept apart from the loader so the test can read it
 * without starting DuckDB.
 */
export function createBatches() {
  // Transport types; see `arrow-columns.ts`. `i` for values that always fit
  // 32 bits (ids, indexes, lengths, ports, codes), `n` for the unsigned 32-bit
  // protocol fields that may not, `d` for text that repeats.
  const i = () => new Int32Column()
  const n = () => new NumberColumn()
  const b = () => new BoolColumn()
  const t = () => new TextColumn()
  const d = () => new StringDictionaryColumn()
  const prefixColumns = () => {
    // Both read off the decoded prefix, which repeats as one object.
    const keys = new DictionaryKeys<BgpPrefix>()
    return {
      id: i(),
      message_id: i(),
      prefix: new DictionaryColumn(keys),
      prefix_length: i(),
      prefix_bits: new DictionaryColumn(keys),
      afi: i(),
      safi: i(),
      evpn_route_type: i(),
      evpn_type_name: d(),
      evpn_rd: d(),
      evpn_mac: d(),
      evpn_ip: d(),
      evpn_vni: i(),
      evpn_vni2: i(),
      evpn_esi: d(),
      evpn_eth_tag: n(),
    }
  }
  return {
    packets: tableBatch('packets', () => ({
      frame_index: i(),
      timestamp: new TimestampColumn(),
      src_ip: d(),
      dst_ip: d(),
      src_ip_bits: d(),
      dst_ip_bits: d(),
      src_port: i(),
      dst_port: i(),
      parse_warnings: new TextListColumn(),
    })),
    messages: tableBatch('messages', () => ({
      id: i(),
      frame_index: i(),
      message_index: i(),
      type: d(),
      version: i(),
      my_as: n(),
      hold_time: i(),
      router_id: d(),
      error_code: i(),
      error_subcode: i(),
      error_code_name: d(),
      error_subcode_name: d(),
      afi: i(),
      safi: i(),
      afi_name: d(),
      safi_name: d(),
    })),
    capabilities: tableBatch('capabilities', () => ({
      id: i(),
      message_id: i(),
      code: i(),
      name: d(),
      cap_type: d(),
      cap_afi: i(),
      cap_afi_name: d(),
      cap_safi: i(),
      cap_safi_name: d(),
      cap_as_number: n(),
    })),
    pathAttributes: tableBatch('path_attributes', () => ({
      id: i(),
      message_id: i(),
      type_code: i(),
      type_name: d(),
      flags_optional: b(),
      flags_transitive: b(),
      flags_partial: b(),
      flags_extended: b(),
      origin_value: d(),
      next_hop: d(),
      med_value: n(),
      local_pref: n(),
      aggregator_as: n(),
      aggregator_addr: d(),
    })),
    asPath: tableBatch('as_path', () => ({
      id: i(),
      message_id: i(),
      segment_type: d(),
      segment_index: i(),
      as_index: i(),
      asn: n(),
    })),
    nlri: tableBatch('nlri', prefixColumns),
    withdrawn: tableBatch('withdrawn', prefixColumns),
    communities: tableBatch('communities', () => ({
      id: i(),
      message_id: i(),
      asn: i(),
      value: i(),
      formatted: d(),
    })),
    largeCommunities: tableBatch('large_communities', () => ({
      id: i(),
      message_id: i(),
      global_admin: n(),
      local_data1: n(),
      local_data2: n(),
      formatted: t(),
    })),
    extCommunities: tableBatch('extended_communities', () => ({
      id: i(),
      message_id: i(),
      kind: d(),
      value: d(),
      formatted: d(),
      transitive: b(),
      type_code: i(),
      subtype: i(),
    })),
  }
}

export type Batches = ReturnType<typeof createBatches>
