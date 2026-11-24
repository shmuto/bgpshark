import { yieldToPage } from '../yield-to-page'
import { BinaryReader } from '../pcap/reader'
import type { RawPacket } from '../pcap/types'
import {
  type BgpPacket,
  type BgpMessage,
  type BgpMessageHeader,
  type BgpOpenMessage,
  type BgpParseResult,
  BgpMessageType,
} from './types'
import { parseOpenMessage } from './open'
import { parseNotificationMessage } from './notification'
import { parseUpdateMessage } from './update'
import { BgpSessionTracker, endpointKey, type UpdateDecoding } from './session'
import { getAfiName, getSafiName } from './constants'

const BGP_HEADER_LENGTH = 19
const BGP_MIN_MESSAGE_LENGTH = 19
const BGP_MAX_MESSAGE_LENGTH = 4096

/**
 * TCP segment reassembly
 * -----------------------
 * BGP messages are carried over a TCP byte stream, so a single BGP message may be
 * split across two or more captured TCP segments (common with large UPDATE bursts
 * or full-table dumps), and a single segment may contain the tail of one message,
 * several complete messages, and the start of another.
 *
 * We track one leftover byte buffer per TCP flow, where a flow is the directional
 * 4-tuple (srcIp, srcPort, dstIp, dstPort). The two directions of a session are
 * deliberately kept as separate flows since each direction is an independent TCP
 * byte stream. Before parsing a packet's payload, any leftover bytes from a
 * previous segment of the same flow are prepended to it.
 *
 * Frame attribution: a reassembled message is attributed to the frame in which it
 * COMPLETED (i.e. the packet whose payload supplied the final byte of the
 * message), not the frame where it started. This keeps frameIndex/timestamp
 * monotonic and simple for the UI (which sorts/displays by frame): a message
 * never gets attached to a frame index earlier than a frame it depends on, and
 * every BgpPacket entry corresponds 1:1 to an actual captured frame.
 *
 * Defensive cap: whatever a segment doesn't resolve into a complete message -
 * a message genuinely still waiting on more bytes, or a run of bytes that
 * failed marker/length validation - is kept as the flow's leftover buffer, in
 * case a later segment lets it resync. A well-formed pending message can never
 * need more than BGP_MAX_MESSAGE_LENGTH bytes, so if the leftover for a flow
 * ever grows beyond that (e.g. a run of retransmitted/duplicated segments that
 * keeps failing validation and just keeps getting appended to), the flow is
 * considered desynced: we drop the buffer and emit a warning instead of
 * retaining it and growing unbounded.
 */

/**
 * Identify a directional TCP flow for reassembly bookkeeping
 */
function flowKey(raw: RawPacket): string {
  return `${raw.srcIp}:${raw.srcPort}->${raw.dstIp}:${raw.dstPort}`
}

/**
 * Concatenate two byte buffers
 */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * Parse BGP messages from raw TCP packets, reassembling messages that span
 * multiple TCP segments of the same flow.
 */
export function parseBgpFromPackets(rawPackets: RawPacket[]): BgpParseResult {
  const decoder = createBgpDecoder()
  for (let i = 0; i < rawPackets.length; i++) decoder.addPacket(rawPackets[i], i)
  return decoder.finish()
}

/**
 * How long one slice of `parseBgpFromPacketsAsync` may run before it hands
 * the page back — the same budget as the route statistics' slices.
 */
const DECODE_SLICE_MS = 12

/**
 * How many packets are decoded between looks at the clock. A dense frame —
 * a full segment of small UPDATEs — is a few tens of microseconds, so this
 * keeps a slice within a fraction of a millisecond of its budget without
 * paying for a clock read per packet.
 */
const DECODE_CLOCK_EVERY = 16

export interface DecodeSliceOptions {
  /** Called after each slice with the packets decoded so far. */
  onProgress?: (done: number, total: number) => void
  /** Checked after each slice; true abandons the decode and resolves to null. */
  shouldStop?: () => boolean
  /** Budget per slice in milliseconds. Tests set 0 to slice as finely as possible. */
  sliceMs?: number
}

/**
 * `parseBgpFromPackets`, in slices that return to the event loop between
 * them, so the page can repaint the load gauge while a large capture decodes.
 *
 * Decoding a 100MB capture in one go held the page for about seven seconds
 * with the gauge frozen at the start of the stage, which reads as a hang. The
 * work and its result are identical: every bit of state that carries from one
 * packet to the next — each flow's reassembly buffer, each session's
 * negotiated decoding — lives in the decoder, not the loop, so a slice
 * boundary between two segments of one message is no different from the gap
 * between two loop iterations.
 */
export async function parseBgpFromPacketsAsync(
  rawPackets: RawPacket[],
  options: DecodeSliceOptions = {}
): Promise<BgpParseResult | null> {
  const { onProgress, shouldStop, sliceMs = DECODE_SLICE_MS } = options
  const decoder = createBgpDecoder()
  const total = rawPackets.length
  let sliceStart = performance.now()
  for (let i = 0; i < total; i++) {
    decoder.addPacket(rawPackets[i], i)
    if (i % DECODE_CLOCK_EVERY === DECODE_CLOCK_EVERY - 1 && performance.now() - sliceStart >= sliceMs) {
      onProgress?.(i + 1, total)
      await yieldToPage()
      if (shouldStop?.()) return null
      sliceStart = performance.now()
    }
  }
  onProgress?.(total, total)
  return decoder.finish()
}

/**
 * The decoder behind both entry points: packets go in one at a time, in
 * capture order, and `finish` returns what they decoded to.
 */
function createBgpDecoder() {
  const packets: BgpPacket[] = []
  const warnings: string[] = []
  const flowBuffers = new Map<string, Uint8Array>()
  // What each session negotiated in its OPENs. Packets are walked in capture
  // order, so by the time UPDATEs arrive the OPENs that govern how to read
  // them have already been seen.
  const sessions = new BgpSessionTracker()

  /** Decode one packet; `i` is its position in the capture's TCP packets. */
  function addPacket(raw: RawPacket, i: number): void {
    const packetWarnings: string[] = []
    const key = flowKey(raw)

    try {
      const leftover = flowBuffers.get(key)
      const payload =
        leftover && leftover.length > 0 ? concatBytes(leftover, raw.tcpPayload) : raw.tcpPayload

      const from = endpointKey(raw.srcIp, raw.srcPort)
      const to = endpointKey(raw.dstIp, raw.dstPort)
      const { messages, remainder } = parseBgpMessages(payload, packetWarnings, i + 1, {
        decoding: () => sessions.decodingFor(from, to),
        observeOpen: (open) => sessions.observeOpen(from, open),
      })

      if (remainder.length > BGP_MAX_MESSAGE_LENGTH) {
        packetWarnings.push(
          `Packet ${i + 1}: TCP flow ${key} appears desynced ` +
            `(buffered ${remainder.length} bytes exceeds max BGP message length ` +
            `${BGP_MAX_MESSAGE_LENGTH}). Discarding buffered data.`
        )
        flowBuffers.delete(key)
      } else if (remainder.length > 0) {
        flowBuffers.set(key, remainder)
      } else {
        flowBuffers.delete(key)
      }

      if (messages.length > 0) {
        packets.push({
          frameIndex: raw.frameIndex,
          timestamp: raw.timestamp,
          srcIp: raw.srcIp,
          dstIp: raw.dstIp,
          srcPort: raw.srcPort,
          dstPort: raw.dstPort,
          messages,
          rawData: raw.tcpPayload,
          parseWarnings: [...packetWarnings],
        })
      }

      warnings.push(...packetWarnings)
    } catch (e) {
      warnings.push(
        `Packet ${i + 1}: BGP parse error - ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  function finish(): BgpParseResult {
    // Flag any flow that still has an incomplete message buffered once the
    // capture ends, rather than silently discarding it.
    for (const [key, remainder] of flowBuffers) {
      if (remainder.length > 0) {
        warnings.push(
          `Flow ${key}: capture ended with ${remainder.length} incomplete byte(s) buffered ` +
            `(partial BGP message never completed).`
        )
      }
    }
    return { packets, warnings }
  }

  return { addPacket, finish }
}

/**
 * Result of parsing all complete BGP messages out of a (possibly reassembled)
 * TCP payload, along with any trailing bytes that belong to a message which is
 * not yet complete and must be carried over to the next segment of the flow.
 */
interface BgpMessagesResult {
  messages: BgpMessage[]
  remainder: Uint8Array
}

/**
 * Parse multiple BGP messages from a TCP payload
 */
/**
 * How a payload's messages connect back to the session they belong to: the
 * decoding rules in force for this direction, and somewhere to report an OPEN
 * so that later messages are read the way the session agreed.
 */
interface SessionContext {
  decoding: () => UpdateDecoding
  observeOpen: (open: BgpOpenMessage) => void
}

function parseBgpMessages(
  payload: Uint8Array,
  warnings: string[],
  packetIndex: number,
  session: SessionContext
): BgpMessagesResult {
  const messages: BgpMessage[] = []
  const reader = new BinaryReader(payload, false) // BGP uses network byte order (big-endian)

  while (reader.remaining() >= BGP_HEADER_LENGTH) {
    const startOffset = reader.offset

    // Validate marker
    const marker = reader.peek(16)
    if (!validateMarker(marker)) {
      // Could be a genuinely corrupt stream, or a flow whose alignment we've
      // lost (e.g. a missed segment). Either way we can't safely resume
      // parsing from here in this call; the unparsed tail (from startOffset
      // onward, i.e. reader.offset, since peek() doesn't advance it) is left
      // for the caller to decide whether to keep buffering (bounded by the
      // per-flow cap) or give up on.
      warnings.push(
        `Packet ${packetIndex}: Invalid BGP marker at offset ${startOffset}. ` +
          `Possible TCP segment fragmentation or corrupt data.`
      )
      break
    }

    // Peek at length to check if we have complete message
    const length = reader.peekUint16At(16)

    if (length < BGP_MIN_MESSAGE_LENGTH || length > BGP_MAX_MESSAGE_LENGTH) {
      warnings.push(
        `Packet ${packetIndex}: Invalid BGP message length ${length} at offset ${startOffset}`
      )
      break
    }

    if (reader.remaining() < length) {
      // Message spans multiple TCP segments - stop here so the unparsed tail
      // (still at startOffset) is buffered for the next segment of this flow.
      break
    }

    // Read the complete message
    const header = parseBgpHeader(reader)
    const messageBodyLength = header.length - BGP_HEADER_LENGTH
    const messageReader = reader.subReader(messageBodyLength)

    try {
      const message = parseBgpMessageBody(
        header.type,
        messageReader,
        session.decoding(),
        warnings,
        packetIndex
      )
      if (message) {
        // Registered as it is read, so an OPEN and an UPDATE arriving in the
        // same segment are still read in the right order.
        if (message.type === 'OPEN') session.observeOpen(message)
        messages.push(message)
      }
    } catch (e) {
      warnings.push(
        `Packet ${packetIndex}: Error parsing BGP message type ${header.type}: ` +
          `${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  // Whatever hasn't been consumed into a complete message - whether because
  // the loop ran out of bytes for even a header, hit an invalid marker/length,
  // or is waiting on more bytes for a message in progress - is returned as the
  // remainder. The caller (parseBgpFromPackets) is responsible for bounding
  // how large this is allowed to grow across segments of the same flow.
  const remainder = payload.slice(reader.offset)

  return { messages, remainder }
}

/**
 * Validate BGP marker (16 bytes of 0xFF)
 */
function validateMarker(marker: Uint8Array): boolean {
  if (marker.length < 16) {
    return false
  }
  for (let i = 0; i < 16; i++) {
    if (marker[i] !== 0xff) {
      return false
    }
  }
  return true
}

/**
 * Parse BGP message header
 */
function parseBgpHeader(reader: BinaryReader): BgpMessageHeader {
  const marker = reader.readBytes(16)
  const length = reader.readUint16()
  const type = reader.readUint8()

  return { marker, length, type }
}

/**
 * Parse BGP message body based on type
 */
function parseBgpMessageBody(
  type: number,
  reader: BinaryReader,
  decoding: UpdateDecoding,
  warnings: string[],
  packetIndex: number
): BgpMessage | null {
  switch (type) {
    case BgpMessageType.OPEN:
      return parseOpenMessage(reader)

    case BgpMessageType.UPDATE: {
      // parseUpdateMessage expects raw bytes, not a BinaryReader
      const updateData = reader.readBytes(reader.remaining())
      // Into the packet's own list, so they surface next to the packet they
      // came from. These used to go into a module-level array that nothing ever
      // read, which meant the UPDATE parser's warnings — a prefix length past
      // the family maximum, an NLRI block that decodes two different ways —
      // were collected and then dropped. The parser was talking to no one.
      const before = warnings.length
      const message = parseUpdateMessage(updateData, warnings, decoding)
      for (let i = before; i < warnings.length; i++) {
        warnings[i] = `Packet ${packetIndex}: ${warnings[i]}`
      }
      return message
    }

    case BgpMessageType.NOTIFICATION:
      return parseNotificationMessage(reader)

    case BgpMessageType.KEEPALIVE:
      return { type: 'KEEPALIVE' }

    case BgpMessageType.ROUTE_REFRESH:
      return parseRouteRefreshMessage(reader)

    default:
      return null
  }
}

/**
 * Parse ROUTE-REFRESH message
 */
function parseRouteRefreshMessage(reader: BinaryReader): BgpMessage {
  const afi = reader.readUint16()
  reader.skip(1) // Reserved
  const safi = reader.readUint8()

  return {
    type: 'ROUTE_REFRESH',
    afi,
    safi,
    afiName: getAfiName(afi),
    safiName: getSafiName(safi),
  }
}
