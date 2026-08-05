/**
 * A growable big-endian byte buffer, and the address helpers the encoders need.
 *
 * Everything BGP and everything in an IP or TCP header is network byte order, so
 * unlike `BinaryReader` on the parsing side there is no endianness to configure
 * here: a writer that could be pointed the wrong way would only ever be pointed
 * the wrong way by mistake.
 */
import { parsePrefix, type ParsedPrefix } from '../net/prefix'

export class ByteWriter {
  private buffer = new Uint8Array(256)
  private length = 0

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return

    let capacity = this.buffer.length * 2
    while (capacity < this.length + extra) capacity *= 2

    const grown = new Uint8Array(capacity)
    grown.set(this.buffer.subarray(0, this.length))
    this.buffer = grown
  }

  get size(): number {
    return this.length
  }

  u8(value: number): this {
    this.ensure(1)
    this.buffer[this.length++] = value & 0xff
    return this
  }

  u16(value: number): this {
    this.ensure(2)
    this.buffer[this.length++] = (value >>> 8) & 0xff
    this.buffer[this.length++] = value & 0xff
    return this
  }

  u32(value: number): this {
    this.ensure(4)
    // `>>> 24` rather than `>> 24`: a value above 2^31 (a 4-byte AS number, a
    // community, a TCP sequence number) is negative under the signed shift.
    this.buffer[this.length++] = (value >>> 24) & 0xff
    this.buffer[this.length++] = (value >>> 16) & 0xff
    this.buffer[this.length++] = (value >>> 8) & 0xff
    this.buffer[this.length++] = value & 0xff
    return this
  }

  bytes(value: Uint8Array): this {
    this.ensure(value.length)
    this.buffer.set(value, this.length)
    this.length += value.length
    return this
  }

  /** `count` zero bytes — reserved fields, IP options padding, and the like. */
  zeros(count: number): this {
    this.ensure(count)
    this.buffer.fill(0, this.length, this.length + count)
    this.length += count
    return this
  }

  /**
   * Write a placeholder for a length that is only known once the thing it
   * measures has been written, and return the offset to `patchU16` later.
   */
  placeholderU16(): number {
    const offset = this.length
    this.u16(0)
    return offset
  }

  patchU16(offset: number, value: number): void {
    this.buffer[offset] = (value >>> 8) & 0xff
    this.buffer[offset + 1] = value & 0xff
  }

  patchU8(offset: number, value: number): void {
    this.buffer[offset] = value & 0xff
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length)
  }
}

/** The `count` most significant bytes of `bits`, big-endian. */
export function bigintToBytes(bits: bigint, count: number): Uint8Array {
  const out = new Uint8Array(count)
  let remaining = bits
  for (let i = count - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return out
}

/**
 * An address as it goes on the wire: 4 bytes for IPv4, 16 for IPv6.
 *
 * Throws rather than returning null because every caller is encoding something
 * a user typed into a field that says "address", and there is no sensible
 * fallback for a value that is not one — the error carries the text back up to
 * where it can be shown.
 */
export function addressBytes(text: string, expect?: 4 | 6): Uint8Array {
  const parsed = parsePrefix(text)
  if (!parsed || parsed.hasMask) {
    throw new Error(`Not an IP address: "${text}"`)
  }
  if (expect && parsed.family !== expect) {
    throw new Error(`Expected an IPv${expect} address, got "${text}"`)
  }
  return bigintToBytes(parsed.bits, parsed.family === 4 ? 4 : 16)
}

/** `10.0.0.0/24` or a bare address (which is taken as a host route). */
export function parsePrefixText(text: string): ParsedPrefix {
  const parsed = parsePrefix(text)
  if (!parsed) {
    throw new Error(`Not a prefix: "${text}"`)
  }
  return parsed
}

/**
 * A prefix in BGP's variable-length NLRI encoding: a length byte followed by
 * only as many address bytes as that length needs, so a /24 costs four bytes
 * and a /0 costs one.
 */
export function writePrefix(writer: ByteWriter, prefix: ParsedPrefix): void {
  const octets = Math.ceil(prefix.length / 8)
  const full = bigintToBytes(prefix.bits, prefix.family === 4 ? 4 : 16)
  writer.u8(prefix.length)
  writer.bytes(full.subarray(0, octets))
}

/** One's-complement sum over 16-bit words, as IPv4, TCP and UDP all define it. */
export function internetChecksum(...parts: Uint8Array[]): number {
  let sum = 0

  for (const part of parts) {
    let i = 0
    for (; i + 1 < part.length; i += 2) {
      sum += (part[i] << 8) | part[i + 1]
    }
    // An odd-length part is padded on the right with a zero byte. Every caller
    // here passes an even-length part except the payload, which is why the
    // pseudo-header and headers are summed separately rather than concatenated.
    if (i < part.length) {
      sum += part[i] << 8
    }
    // Fold as we go: summing a full-size frame's words would otherwise overflow
    // the 32-bit range that bitwise operators work in.
    while (sum > 0xffff) {
      sum = (sum & 0xffff) + (sum >>> 16)
    }
  }

  return ~sum & 0xffff
}
