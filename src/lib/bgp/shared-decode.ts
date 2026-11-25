/**
 * One copy of each decoded value that a capture repeats, shared by every
 * message that carries it.
 *
 * Decoded UPDATEs were four fifths of the JS heap after a load: about 630
 * bytes per UPDATE, measured with Chromium's sampling heap profiler on a 45MB
 * capture. Little of that is unique. A capture repeats itself — every UPDATE
 * of a flap re-announces the same attributes, a table transfer sends a handful
 * of ORIGIN, NEXT_HOP and MED values for a million prefixes, and the same few
 * thousand prefixes come and go — yet each message decoded its own copy of all
 * of it. At 200MB that was enough to run a tab out of its 4GB heap.
 *
 * So the decoder keeps, per capture, one copy of:
 *
 * - each path attribute block, keyed by its bytes — the whole reconciled
 *   attribute list of an UPDATE whose attributes match an earlier one's;
 * - each path attribute, for blocks that differ but share attributes;
 * - each prefix, keyed by family, length and bits.
 *
 * A shared value is only ever one the parser would have produced again from
 * the same bytes, under the same session decoding, *without a warning*: a
 * value whose decoding warned is decoded afresh each time, so its warning is
 * raised each time. MP_REACH_NLRI and MP_UNREACH_NLRI are never shared —
 * they carry the routes themselves, and their reading depends on ADD-PATH.
 *
 * Shared values must be treated as read-only: editing one edits every
 * message holding it. Nothing in the app modifies a decoded message. They are
 * deliberately *not* frozen, although that would enforce it: V8 gives frozen
 * arrays and objects a different representation, and the loops that walk
 * every message — collecting the filter's suggestions, for one — took twice
 * as long once some of what they walked was frozen (a filter on a 45MB
 * capture went from 1.1 to 2.1 seconds).
 */
import type { BgpPathAttribute, BgpPrefix } from './types'

/**
 * How many entries one table may hold before it starts over. A capture whose
 * values never repeat would otherwise grow a table as large as the values
 * themselves, for no gain; starting over keeps the recent ones, which is where
 * repeats are.
 */
const MAX_ENTRIES = 1 << 16

/**
 * A table checks its hit rate every `WINDOW` lookups. Below one in four it
 * rests for `REST` lookups — skipping them without so much as building a key —
 * then tries again.
 *
 * Sharing is not free: a key is built from the bytes and looked up for every
 * value, and a miss also stores it. On a capture where something repeats that
 * pays for itself many times over, in memory and in decoding skipped. On one
 * where nothing does — a new prefix, AS path and MED in every UPDATE — it was
 * pure overhead, and decoding took three times as long. Resting a table that
 * is not earning its keep bounds that to the windows spent finding out.
 */
const WINDOW = 4096
const REST = 16 * WINDOW

/** Handed to every message with no prefixes in a field, and every packet with no warnings. */
export const NO_PREFIXES: BgpPrefix[] = []
export const NO_WARNINGS: string[] = []

/**
 * `items` in an array exactly as long as it is.
 *
 * An array grown by `push` from empty reserves room for seventeen elements at
 * its first push, and V8 never hands the slack back. A decoded UPDATE held six
 * such arrays, nearly all of one element: its packet's messages, its
 * attributes, its NLRI, an AS_PATH's segments and their AS numbers, and the
 * route statistics' AS numbers for the path. On a capture where every UPDATE
 * is its own, a heap snapshot put them at a third of the heap (143MB of 425MB
 * in Node, for 156,000 UPDATEs), and in Chromium they were about 380 bytes of
 * every UPDATE: 0.9GB of a 300MB capture's 3.5GB. A copy made by `slice` holds
 * what it needs and no more; the array it was copied from is short-lived
 * garbage, which the young generation collects for next to nothing.
 */
export function fitted<T>(items: T[]): T[] {
  return items.slice()
}

/** The bytes as a string, one character per byte, to key a table with. */
export function bytesKey(tag: string, bytes: Uint8Array): string {
  return tag + String.fromCharCode.apply(null, bytes as unknown as number[])
}

export class SharedTable<K, V> {
  private map = new Map<K, V>()
  private lookups = 0
  private hits = 0
  private resting = 0

  /**
   * Whether to consult the table for this value at all. False while it rests;
   * callers check this before building a key, which is most of the cost.
   */
  active(): boolean {
    if (this.resting === 0) return true
    this.resting--
    return false
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) this.hits++
    if (++this.lookups === WINDOW) {
      if (this.hits * 4 < WINDOW) {
        this.resting = REST
        this.map.clear()
      }
      this.lookups = 0
      this.hits = 0
    }
    return value
  }

  set(key: K, value: V): V {
    if (this.map.size >= MAX_ENTRIES) this.map.clear()
    this.map.set(key, value)
    return value
  }
}

export class SharedDecodedValues {
  readonly attributeBlocks = new SharedTable<string, BgpPathAttribute[]>()
  /** One table per attribute type, so that ORIGINs that always repeat keep sharing while AS_PATHs that never do rest. */
  private attributeTables = new Map<number, SharedTable<string | number, BgpPathAttribute>>()
  readonly ipv4Prefixes = new Ipv4PrefixCache()
  readonly otherPrefixes = new SharedTable<string, BgpPrefix>()

  attributes(typeCode: number): SharedTable<string | number, BgpPathAttribute> {
    let table = this.attributeTables.get(typeCode)
    if (!table) {
      table = new SharedTable()
      this.attributeTables.set(typeCode, table)
    }
    return table
  }
}

/**
 * IPv4 prefixes without a Path Identifier — nearly every prefix in a capture —
 * in a table of slots. Each prefix may sit in one of two, and the two most
 * recent prefixes hashing there are the ones kept.
 *
 * Not a `Map`, and never resting, unlike the tables above. A prefix is looked
 * up for every route, so the lookup has to cost almost nothing even when it
 * misses: here it is a hash, two typed-array reads and, on a miss, a store
 * into a slot — nothing allocated. (A `Map` keyed by length × 2³² + address
 * allocated a heap number for every key, and on a capture of unique prefixes
 * that alone made decoding a third slower.) It cannot rest because of the most
 * common shape a large capture has: a table transfer, every prefix new, then
 * churn over the same prefixes. Resting through the transfer meant sharing
 * nothing once they started to repeat.
 *
 * It grows, doubling, while it is more than half full, up to `MAX_BITS`. It
 * used to stop at 2¹⁷ slots, which holds a few tens of thousands of prefixes
 * well — and a full IPv4 table is about a million. A capture that cycled
 * through 1.2 million routes shared almost none of its repeats: every
 * announcement decoded a prefix object and string of its own, and the route
 * statistics, the filter's suggestions and the garbage collector all paid for
 * it again. At its largest the table is about 20MB, against prefixes that the
 * packets would otherwise hold millions of copies of.
 *
 * Collisions just replace the slot's prefix; the cost is a prefix decoded
 * twice, never a wrong one, because the slot's address and length are compared.
 */
class Ipv4PrefixCache {
  private static readonly INITIAL_BITS = 14
  private static readonly MAX_BITS = 21
  private bits = Ipv4PrefixCache.INITIAL_BITS
  private lengths = new Uint8Array(1 << Ipv4PrefixCache.INITIAL_BITS)
  private addresses = new Int32Array(1 << Ipv4PrefixCache.INITIAL_BITS)
  private values: Array<BgpPrefix | undefined> = new Array(1 << Ipv4PrefixCache.INITIAL_BITS)
  /** Slots holding a prefix. */
  private filled = 0

  /**
   * The first of the two slots a prefix may occupy; the other is the one
   * after it. The hash is MurmurHash3's finaliser — a single multiply was not
   * enough: a /24's last octet is always zero, and 20,000 such prefixes landed
   * in under 10,000 slots.
   */
  private slot(address: number, length: number): number {
    let h = address ^ Math.imul(length, 0x27d4eb2d)
    h ^= h >>> 16
    h = Math.imul(h, 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
    return h & ((1 << this.bits) - 2)
  }

  private matches(slot: number, address: number, length: number): boolean {
    // Lengths are stored plus one, so an empty slot (0) never matches.
    return this.lengths[slot] === length + 1 && this.addresses[slot] === address
  }

  /** `address` is the prefix's four octets as an int32, zero-padded past its length. */
  get(address: number, length: number): BgpPrefix | undefined {
    const slot = this.slot(address, length)
    if (this.matches(slot, address, length)) return this.values[slot]
    if (this.matches(slot + 1, address, length)) return this.values[slot + 1]
    return undefined
  }

  /** Store in the first slot, moving what was there to the second: the older of the two is the one dropped. */
  set(address: number, length: number, prefix: BgpPrefix): BgpPrefix {
    if (this.filled * 2 > this.lengths.length && this.bits < Ipv4PrefixCache.MAX_BITS) this.grow()
    const slot = this.slot(address, length)
    // The second slot's prefix, if any, is the one pushed out.
    if (this.lengths[slot + 1] === 0) this.filled++
    this.lengths[slot + 1] = this.lengths[slot]
    this.addresses[slot + 1] = this.addresses[slot]
    this.values[slot + 1] = this.values[slot]
    this.lengths[slot] = length + 1
    this.addresses[slot] = address
    this.values[slot] = prefix
    return prefix
  }

  /** Twice the slots, with every prefix held moved over, older before newer. */
  private grow(): void {
    const { lengths, addresses, values } = this
    this.bits++
    this.lengths = new Uint8Array(1 << this.bits)
    this.addresses = new Int32Array(1 << this.bits)
    this.values = new Array(1 << this.bits)
    this.filled = 0
    for (let slot = 0; slot < lengths.length; slot += 2) {
      for (const at of [slot + 1, slot]) {
        if (lengths[at] !== 0) this.set(addresses[at], lengths[at] - 1, values[at]!)
      }
    }
  }
}

/** Whether an attribute may be shared: not one carrying routes, not one kept as raw bytes. */
export function isShareableAttribute(attribute: BgpPathAttribute): boolean {
  return attribute.typeCode !== 14 && attribute.typeCode !== 15 && attribute.rawValue === undefined
}
