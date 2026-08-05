/**
 * Write a pcap file from frames taken out of a loaded capture.
 *
 * Output is always classic pcap, little-endian, even when the source was
 * pcapng: every tool that reads a capture reads this, and a slice handed to a
 * vendor or attached to a ticket is worth nothing if it needs a specific
 * reader. The link type is carried over from the source so the frames decode
 * the same way they did here.
 *
 * Timestamps are written at microsecond resolution but carry millisecond
 * precision, because that is all the parsed capture retains (`timestamp` is a
 * `Date`). Ordering and spacing survive; sub-millisecond detail from a
 * nanosecond pcapng does not.
 */

const PCAP_MAGIC = 0xa1b2c3d4
const GLOBAL_HEADER_LENGTH = 24
const PACKET_HEADER_LENGTH = 16

/** The snaplen written when the frames themselves do not call for a larger one. */
const DEFAULT_SNAPLEN = 65535

export interface ExportableFrame {
  timestamp: Date
  /** The captured bytes of the frame, as they appeared in the source file. */
  frameBytes: Uint8Array
  /** Length on the wire, which exceeds the captured length for a snapped frame. */
  originalLength: number
}

/**
 * Build a pcap file containing `frames`, in the order given.
 *
 * `linkType` must be the source capture's link type (LINKTYPE_ETHERNET = 1,
 * LINKTYPE_LINUX_SLL = 113, …); frames are copied verbatim, so writing them
 * under the wrong link type would produce a file that decodes to nonsense.
 */
export function writePcap(frames: ExportableFrame[], linkType: number): Uint8Array {
  const totalLength = frames.reduce(
    (sum, frame) => sum + PACKET_HEADER_LENGTH + frame.frameBytes.length,
    GLOBAL_HEADER_LENGTH
  )

  const out = new Uint8Array(totalLength)
  const view = new DataView(out.buffer)
  let offset = 0

  const snapLen = Math.max(
    DEFAULT_SNAPLEN,
    ...frames.map((frame) => frame.frameBytes.length)
  )

  // Global header
  view.setUint32(offset, PCAP_MAGIC, true)
  view.setUint16(offset + 4, 2, true) // version major
  view.setUint16(offset + 6, 4, true) // version minor
  view.setInt32(offset + 8, 0, true) // thiszone: timestamps are UTC
  view.setUint32(offset + 12, 0, true) // sigfigs, unused in practice
  view.setUint32(offset + 16, snapLen, true)
  view.setUint32(offset + 20, linkType, true)
  offset += GLOBAL_HEADER_LENGTH

  for (const frame of frames) {
    const ms = frame.timestamp.getTime()
    const seconds = Math.floor(ms / 1000)
    const microseconds = (ms - seconds * 1000) * 1000
    const capturedLength = frame.frameBytes.length

    view.setUint32(offset, seconds, true)
    view.setUint32(offset + 4, microseconds, true)
    view.setUint32(offset + 8, capturedLength, true)
    // A frame can never have been longer on the wire than what was captured of
    // it; a source that claims otherwise would make the file unreadable.
    view.setUint32(offset + 12, Math.max(frame.originalLength, capturedLength), true)
    offset += PACKET_HEADER_LENGTH

    out.set(frame.frameBytes, offset)
    offset += capturedLength
  }

  return out
}

/**
 * A file name for a slice of `sourceName`, e.g. `capture.pcapng` →
 * `capture-filtered.pcap`. The extension always becomes `.pcap` because that
 * is what `writePcap` produces.
 */
export function sliceFileName(sourceName: string | null): string {
  const base = (sourceName ?? 'capture').replace(/\.(pcap|pcapng|cap)$/i, '')
  return `${base}-filtered.pcap`
}
