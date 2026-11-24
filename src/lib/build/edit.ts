/**
 * Captures that already exist, as material: read one in, change it, write it
 * back out.
 *
 * The builders make clean captures, and some of what BGPShark has to cope with
 * is not clean — a frame missing from the middle, a clock that jumped, bytes
 * damaged in transit, a file cut off mid-record or whose record headers lie.
 * Starting from a real capture is also the quickest way to a capture that
 * looks like one. Every function here takes a `BuiltCapture` and returns a new
 * one, so they chain, and their output merges with everything else.
 *
 * Reading is done here rather than with `lib/pcap`'s parsers on purpose. Those
 * keep only the IP frames, because that is all the app shows; a capture read
 * in to be edited has to come back out with its ARP, LLDP and everything else
 * still in it.
 *
 * Timestamps are milliseconds, because `ExportableFrame` holds a `Date`: a
 * capture read in and written back keeps its frame order but loses any
 * sub-millisecond part.
 */
import { LinkLayerType } from '../pcap/types'
import { writePcap, type ExportableFrame } from '../pcap/writer'
import type { BuiltCapture } from './scenario'

const PCAP_GLOBAL_HEADER = 24
const PCAP_RECORD_HEADER = 16

const BLOCK_SECTION_HEADER = 0x0a0d0d0a
const BLOCK_INTERFACE = 0x00000001
const BLOCK_SIMPLE_PACKET = 0x00000003
const BLOCK_ENHANCED_PACKET = 0x00000006
const PCAPNG_BYTE_ORDER = 0x1a2b3c4d

/** `'ff ff 00:13 0x04'` → bytes. Spaces, colons and a leading `0x` are ignored. */
export function hex(text: string): Uint8Array {
  const digits = text.replace(/0x/gi, '').replace(/[\s:,-]/g, '')
  if (!/^(?:[0-9a-f]{2})*$/i.test(digits)) throw new Error(`Not hex bytes: "${text}"`)
  return Uint8Array.from(digits.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every frame of a pcap or pcapng file, whatever it carries.
 *
 * Throws rather than warns on a damaged file: this is for taking a capture
 * apart, and a file that cannot be read completely would come back out
 * silently shorter.
 */
export function readCapture(bytes: Uint8Array): BuiltCapture {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 4 && view.getUint32(0, true) === BLOCK_SECTION_HEADER) return readPcapng(view)
  return readPcap(view)
}

function captured(frames: ExportableFrame[], linkType: number): BuiltCapture {
  return {
    bytes: writePcap(frames, linkType),
    frames,
    senders: frames.map(() => undefined),
    linkType,
    warnings: [],
  }
}

function readPcap(view: DataView): BuiltCapture {
  if (view.byteLength < PCAP_GLOBAL_HEADER) throw new Error('Not a pcap file: too short')

  const magic = view.getUint32(0, true)
  let little: boolean
  if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d) little = true
  else if (magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1) little = false
  else throw new Error('Not a pcap or pcapng file: unrecognised magic number')
  // The nanosecond magic, read in the file's own byte order.
  const nanoseconds = view.getUint32(0, little) === 0xa1b23c4d

  const linkType = view.getUint32(20, little)
  const frames: ExportableFrame[] = []
  let offset = PCAP_GLOBAL_HEADER

  while (offset < view.byteLength) {
    if (offset + PCAP_RECORD_HEADER > view.byteLength) {
      throw new Error(`Record ${frames.length + 1} is cut off in its header at byte ${offset}`)
    }
    const seconds = view.getUint32(offset, little)
    const fraction = view.getUint32(offset + 4, little)
    const capturedLength = view.getUint32(offset + 8, little)
    const originalLength = view.getUint32(offset + 12, little)
    offset += PCAP_RECORD_HEADER

    if (offset + capturedLength > view.byteLength) {
      throw new Error(
        `Record ${frames.length + 1} claims ${capturedLength} bytes but only ` +
          `${view.byteLength - offset} remain`
      )
    }

    frames.push({
      timestamp: new Date(seconds * 1000 + Math.floor(fraction / (nanoseconds ? 1e6 : 1e3))),
      frameBytes: new Uint8Array(view.buffer, view.byteOffset + offset, capturedLength).slice(),
      originalLength,
    })
    offset += capturedLength
  }

  return captured(frames, linkType)
}

interface PcapngInterface {
  linkType: number
  /** Units per second of this interface's timestamps. */
  ticksPerSecond: number
}

function readPcapng(view: DataView): BuiltCapture {
  let little = true
  let interfaces: PcapngInterface[] = []
  const frames: ExportableFrame[] = []
  let linkType: number | undefined
  let offset = 0

  const u32 = (at: number) => view.getUint32(at, little)

  while (offset + 12 <= view.byteLength) {
    // The section header's type reads the same in either byte order, which is
    // what lets each section state its own — and that order governs even the
    // section header's own length field.
    const type = view.getUint32(offset, little)
    if (type === BLOCK_SECTION_HEADER) {
      little = view.getUint32(offset + 8, true) === PCAPNG_BYTE_ORDER
      if (!little && view.getUint32(offset + 8, false) !== PCAPNG_BYTE_ORDER) {
        throw new Error(`Section at byte ${offset} has no valid byte-order magic`)
      }
      interfaces = []
    }

    const length = u32(offset + 4)
    if (length < 12 || length % 4 !== 0 || offset + length > view.byteLength) {
      throw new Error(`Block at byte ${offset} has an impossible length (${length})`)
    }
    const body = offset + 8
    const end = offset + length - 4

    if (type === BLOCK_INTERFACE) {
      interfaces.push({
        linkType: view.getUint16(body, little),
        ticksPerSecond: interfaceResolution(view, body + 8, end, little),
      })
    } else if (type === BLOCK_ENHANCED_PACKET || type === BLOCK_SIMPLE_PACKET) {
      const enhanced = type === BLOCK_ENHANCED_PACKET
      const iface = interfaces[enhanced ? u32(body) : 0]
      if (!iface) throw new Error(`Packet block at byte ${offset} names an interface that was never described`)

      if (linkType === undefined) linkType = iface.linkType
      else if (iface.linkType !== linkType) {
        // A classic pcap has one link type, and that is what comes back out.
        throw new Error(
          `Interfaces with different link types (${linkType} and ${iface.linkType}) cannot be read into one capture`
        )
      }

      let timestamp = new Date(0)
      let capturedLength: number
      let originalLength: number
      let data: number
      if (enhanced) {
        const ticks = u32(body + 4) * 0x100000000 + u32(body + 8)
        timestamp = new Date(Math.floor((ticks / iface.ticksPerSecond) * 1000))
        capturedLength = u32(body + 12)
        originalLength = u32(body + 16)
        data = body + 20
      } else {
        originalLength = u32(body)
        data = body + 4
        capturedLength = Math.min(originalLength, end - data)
      }
      if (data + capturedLength > end) {
        throw new Error(`Packet block at byte ${offset} claims more bytes than it holds`)
      }

      frames.push({
        timestamp,
        frameBytes: new Uint8Array(view.buffer, view.byteOffset + data, capturedLength).slice(),
        originalLength,
      })
    }

    offset += length
  }

  return captured(frames, linkType ?? LinkLayerType.ETHERNET)
}

/** The `if_tsresol` option, as ticks per second. Microseconds when absent. */
function interfaceResolution(view: DataView, start: number, end: number, little: boolean): number {
  let at = start
  while (at + 4 <= end) {
    const code = view.getUint16(at, little)
    const length = view.getUint16(at + 2, little)
    if (code === 0) break
    if (code === 9 && length >= 1) {
      const value = view.getUint8(at + 4)
      return value & 0x80 ? 2 ** (value & 0x7f) : 10 ** value
    }
    at += 4 + length + ((4 - (length % 4)) % 4)
  }
  return 1e6
}

// ---------------------------------------------------------------------------
// Frame edits
// ---------------------------------------------------------------------------

/** The capture rebuilt from a new list of frames, senders kept with them. */
function rebuilt(
  capture: BuiltCapture,
  entries: Array<{ frame: ExportableFrame; sender: BuiltCapture['senders'][number] }>
): BuiltCapture {
  const frames = entries.map((entry) => entry.frame)
  return {
    ...capture,
    bytes: writePcap(frames, capture.linkType),
    frames,
    senders: entries.map((entry) => entry.sender),
  }
}

function entriesOf(capture: BuiltCapture) {
  return capture.frames.map((frame, i) => ({ frame, sender: capture.senders[i], number: i + 1 }))
}

function checkFrameNumbers(capture: BuiltCapture, numbers: number[]): void {
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > capture.frames.length) {
      throw new Error(`No frame ${n}: frames are numbered 1 to ${capture.frames.length}`)
    }
  }
}

/**
 * Only the frames `keep` accepts. `number` is the frame's 1-based position, as
 * Wireshark and the app number it.
 */
export function filterFrames(
  capture: BuiltCapture,
  keep: (frame: ExportableFrame, number: number) => boolean
): BuiltCapture {
  return rebuilt(capture, entriesOf(capture).filter((entry) => keep(entry.frame, entry.number)))
}

/** Every frame except these (1-based) — a capture that lost packets. */
export function dropFrames(capture: BuiltCapture, numbers: number[]): BuiltCapture {
  checkFrameNumbers(capture, numbers)
  const dropped = new Set(numbers)
  return filterFrames(capture, (_, number) => !dropped.has(number))
}

/**
 * Frames moved in time. `by` is milliseconds; give `from` to move only the
 * frames from that one on — a clock that jumped mid-capture, or a gap opened up
 * to make a hold timer expire.
 */
export function shiftTime(capture: BuiltCapture, by: number, options: { from?: number } = {}): BuiltCapture {
  const from = options.from ?? 1
  checkFrameNumbers(capture, [from])
  return rebuilt(
    capture,
    entriesOf(capture).map(({ frame, sender, number }) => ({
      sender,
      frame:
        number < from ? frame : { ...frame, timestamp: new Date(frame.timestamp.getTime() + by) },
    }))
  )
}

/** The capture moved so its first frame is at `time`. */
export function startAt(capture: BuiltCapture, time: Date): BuiltCapture {
  const first = capture.frames[0]
  return first ? shiftTime(capture, time.getTime() - first.timestamp.getTime()) : capture
}

/**
 * One frame's bytes replaced by whatever `edit` returns. Checksums are not
 * recomputed — a damaged frame should look damaged.
 */
export function editFrame(
  capture: BuiltCapture,
  number: number,
  edit: (bytes: Uint8Array) => Uint8Array
): BuiltCapture {
  checkFrameNumbers(capture, [number])
  return rebuilt(
    capture,
    entriesOf(capture).map(({ frame, sender, number: n }) => {
      if (n !== number) return { frame, sender }
      const frameBytes = edit(frame.frameBytes.slice())
      return {
        sender,
        frame: { ...frame, frameBytes, originalLength: Math.max(frame.originalLength, frameBytes.length) },
      }
    })
  )
}

/** `bytes` written over one frame at `offset` — a bit flipped in transit. */
export function overwriteBytes(
  capture: BuiltCapture,
  number: number,
  offset: number,
  bytes: Uint8Array | ArrayLike<number>
): BuiltCapture {
  return editFrame(capture, number, (frame) => {
    if (offset < 0 || offset + bytes.length > frame.length) {
      throw new Error(`Frame ${number} is ${frame.length} bytes; cannot write ${bytes.length} at ${offset}`)
    }
    frame.set(Uint8Array.from(bytes), offset)
    return frame
  })
}

/**
 * Every frame cut to at most `length` captured bytes, its length on the wire
 * kept — what `tcpdump -s <length>` produces, and the reason a BGP message can
 * be cut off in a capture of a session where nothing went wrong.
 */
export function snapFrames(capture: BuiltCapture, length: number): BuiltCapture {
  return rebuilt(
    capture,
    entriesOf(capture).map(({ frame, sender }) => ({
      sender,
      frame:
        frame.frameBytes.length <= length
          ? frame
          : { ...frame, frameBytes: frame.frameBytes.slice(0, length) },
    }))
  )
}

// ---------------------------------------------------------------------------
// File edits
// ---------------------------------------------------------------------------

/**
 * A pcap file whose record header for one frame says something other than the
 * truth. This works on the file's bytes, not on a `BuiltCapture`, because the
 * whole point is a file the readers here would refuse — so it comes last, and
 * its result is written out as it is rather than merged.
 *
 * `capturedLength` larger than the frame makes the file read as truncated from
 * that record on; `originalLength` smaller than the frame is a contradiction
 * some tools reject; `timestamp` can go backwards.
 */
export function patchRecord(
  pcap: Uint8Array,
  number: number,
  patch: { capturedLength?: number; originalLength?: number; timestamp?: Date }
): Uint8Array {
  const out = pcap.slice()
  const view = new DataView(out.buffer)
  if (out.length < PCAP_GLOBAL_HEADER || view.getUint32(0, true) !== 0xa1b2c3d4) {
    throw new Error('patchRecord works on the little-endian microsecond pcap that writePcap produces')
  }

  let offset = PCAP_GLOBAL_HEADER
  for (let n = 1; n < number; n++) {
    if (offset + PCAP_RECORD_HEADER > out.length) throw new Error(`No frame ${number}`)
    offset += PCAP_RECORD_HEADER + view.getUint32(offset + 8, true)
  }
  if (number < 1 || offset + PCAP_RECORD_HEADER > out.length) throw new Error(`No frame ${number}`)

  if (patch.timestamp) {
    const ms = patch.timestamp.getTime()
    view.setUint32(offset, Math.floor(ms / 1000), true)
    view.setUint32(offset + 4, (ms % 1000) * 1000, true)
  }
  if (patch.capturedLength !== undefined) view.setUint32(offset + 8, patch.capturedLength, true)
  if (patch.originalLength !== undefined) view.setUint32(offset + 12, patch.originalLength, true)
  return out
}
