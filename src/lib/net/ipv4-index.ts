import type { BgpPrefix } from '../bgp/types'
import { ipv4Bits } from './prefix'

/**
 * An IPv4 prefix's network address as an int32, for `Ipv4PrefixIndex`; -1 for
 * anything else — IPv6, EVPN, text that is not a dotted quad. Note that -1 is
 * also 255.255.255.255 as an int32, so test for it before converting: the
 * value returned is unsigned.
 */
export function ipv4PrefixAddress(prefix: BgpPrefix): number {
  return prefix.evpn || prefix.length > 32 ? -1 : ipv4Bits(prefix.prefix)
}

/**
 * IPv4 prefixes by address and mask length, to a number: an open-addressing
 * table over one typed array, doubled whenever it is half full, with nothing
 * allocated per lookup.
 *
 * For the loops that meet every route of a capture and need to recognise one
 * they have met before: the route statistics, which find a route's index here,
 * and the filter's suggestions, which skip a prefix they have already listed.
 *
 * The statistics' routes used to be found through a `Map` keyed by
 * `prefix/length` text, so each announcement built a string and hashed it —
 * and on a table transfer cycling through 1.2 million routes, that string,
 * its hash and the lookups into a map of 1.2 million were most of 20 seconds
 * of route statistics. Here the address is read off the prefix's text in
 * place (`ipv4PrefixAddress`) and nothing is allocated.
 */
export class Ipv4PrefixIndex {
  /**
   * Two words per slot, side by side so a probe touches one cache line: the
   * address, then the prefix's number shifted past six bits holding its mask
   * length plus one. A second word of 0 is an empty slot.
   */
  private slots = new Int32Array(2 << 12)
  private size = 0

  private slot(address: number, length: number): number {
    // MurmurHash3's finaliser, as `shared-decode.ts` uses for the same keys.
    let h = address ^ Math.imul(length, 0x27d4eb2d)
    h ^= h >>> 16
    h = Math.imul(h, 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
    return h & ((this.slots.length >> 1) - 1)
  }

  /** The prefix's number, or -1. `address` is the four octets as an int32. */
  get(address: number, length: number): number {
    const slots = this.slots
    const mask = (slots.length >> 1) - 1
    for (let slot = this.slot(address, length); ; slot = (slot + 1) & mask) {
      const tag = slots[2 * slot + 1]
      if (tag === 0) return -1
      if ((tag & 63) === length + 1 && slots[2 * slot] === address) return tag >>> 6
    }
  }

  /** Add a prefix not already in the table; `id` must be below 2²⁵. */
  add(address: number, length: number, id: number): void {
    if (4 * (this.size + 1) > this.slots.length) this.grow()
    const slots = this.slots
    const mask = (slots.length >> 1) - 1
    let slot = this.slot(address, length)
    while (slots[2 * slot + 1] !== 0) slot = (slot + 1) & mask
    slots[2 * slot] = address
    slots[2 * slot + 1] = (id << 6) | (length + 1)
    this.size++
  }

  private grow(): void {
    const old = this.slots
    this.slots = new Int32Array(old.length * 2)
    this.size = 0
    for (let at = 0; at < old.length; at += 2) {
      const tag = old[at + 1]
      if (tag !== 0) this.add(old[at], (tag & 63) - 1, tag >>> 6)
    }
  }
}
