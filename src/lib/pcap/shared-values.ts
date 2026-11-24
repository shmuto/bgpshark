/**
 * Values a capture repeats on nearly every frame, made once and shared.
 *
 * A capture is hundreds of thousands of frames between a handful of
 * addresses, and each frame used to carry its own copy of the same address
 * strings and its own TCP flags object. Those copies were a large part of
 * what a parsed capture weighs — and the weight is what decides how large a
 * capture the tab can open before it runs out of heap.
 *
 * Shared values are never mutated: the flag objects are frozen, and strings
 * are immutable anyway.
 */
import type { TcpFlags } from './types'

/** The 64 combinations of the six classic TCP flag bits. */
const TCP_FLAGS: ReadonlyArray<TcpFlags> = Array.from({ length: 64 }, (_, bits) =>
  Object.freeze({
    fin: (bits & 0x01) !== 0,
    syn: (bits & 0x02) !== 0,
    rst: (bits & 0x04) !== 0,
    psh: (bits & 0x08) !== 0,
    ack: (bits & 0x10) !== 0,
    urg: (bits & 0x20) !== 0,
  })
)

/** The shared flags object for the low six bits of a TCP header's flag field. */
export function tcpFlagsFor(bits: number): TcpFlags {
  return TCP_FLAGS[bits & 0x3f]
}

/**
 * How many distinct addresses to remember. A capture of a scan can hold
 * millions, and interning those would only add a map entry to each string, so
 * past this many, new addresses are simply not shared.
 */
const MAX_INTERNED = 65_536

const ipv4ByValue = new Map<number, string>()
const internedText = new Map<string, string>()

/** The dotted-quad text of an IPv4 address given as its four octets. */
export function ipv4Text(a: number, b: number, c: number, d: number): string {
  const value = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
  let text = ipv4ByValue.get(value)
  if (text === undefined) {
    text = `${a}.${b}.${c}.${d}`
    if (ipv4ByValue.size < MAX_INTERNED) ipv4ByValue.set(value, text)
  }
  return text
}

/** One shared copy of a piece of text that recurs, such as an IPv6 address. */
export function intern(text: string): string {
  const shared = internedText.get(text)
  if (shared !== undefined) return shared
  if (internedText.size < MAX_INTERNED) internedText.set(text, text)
  return text
}
