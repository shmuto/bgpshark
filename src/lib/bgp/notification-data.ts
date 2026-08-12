/**
 * What a NOTIFICATION's data field means, which depends on the error it carries.
 *
 * RFC 4271 §6 defines the data field per error, and every definition is
 * something an operator wants: the AS number that did not match, the capability
 * the peer refused, the attribute it choked on. Rendered as a hex dump it is
 * none of those — it is the answer to the question that made them open the
 * packet, written in a form that requires decoding it by hand.
 *
 * Only the well-defined cases are decoded. Anything else keeps its hex dump,
 * which is also what happens when a sender puts something unexpected in the
 * field: a decoder that guessed would be worse than one that declines, because
 * the reader cannot tell a guess from a fact.
 */
import { BinaryReader } from '../pcap/reader'
import { getCapabilityName } from './constants'
import { parsePathAttribute } from './update'
import { BgpMessageType, type BgpPathAttribute } from './types'

/** Message type names, for a Bad Message Type that names one. */
const MESSAGE_TYPE_NAMES: Record<number, string> = {
  [BgpMessageType.OPEN]: 'OPEN',
  [BgpMessageType.UPDATE]: 'UPDATE',
  [BgpMessageType.NOTIFICATION]: 'NOTIFICATION',
  [BgpMessageType.KEEPALIVE]: 'KEEPALIVE',
  [BgpMessageType.ROUTE_REFRESH]: 'ROUTE-REFRESH',
}

export type NotificationData =
  /** RFC 4271 §6.3: the attribute that caused an UPDATE Message Error. */
  | { kind: 'attribute'; attribute: BgpPathAttribute }
  /** RFC 4271 §6.2: the largest version number the sender supports. */
  | { kind: 'version'; version: number }
  /** The AS number the sender expected, or received and rejected. */
  | { kind: 'as'; asNumber: number }
  /** RFC 4271 §6.2: the capabilities the sender does not support. */
  | { kind: 'capabilities'; capabilities: Array<{ code: number; name: string; length: number }> }
  /** RFC 4271 §6.1: the length field that was out of range. */
  | { kind: 'length'; length: number }
  /** RFC 4271 §6.1: the message type that was not recognised. */
  | { kind: 'messageType'; typeCode: number; typeName: string }
  /** RFC 9003: a human-readable reason for an administrative shutdown or reset. */
  | { kind: 'shutdownMessage'; message: string }

/**
 * Decode the data field, or return undefined to leave it as a hex dump.
 *
 * Never throws: a NOTIFICATION arrives because something already went wrong,
 * and a decoder that failed on a short or malformed field would take the rest
 * of the message's detail view with it.
 */
export function decodeNotificationData(
  errorCode: number,
  errorSubcode: number,
  data: Uint8Array
): NotificationData | undefined {
  if (data.length === 0) return undefined

  try {
    switch (errorCode) {
      case 1:
        return decodeHeaderError(errorSubcode, data)
      case 2:
        return decodeOpenError(errorSubcode, data)
      case 3:
        return decodeUpdateError(errorSubcode, data)
      case 6:
        return decodeCease(errorSubcode, data)
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/** Message Header Error (RFC 4271 §6.1). */
function decodeHeaderError(subcode: number, data: Uint8Array): NotificationData | undefined {
  // Bad Message Length: the two-byte length that was out of range.
  if (subcode === 2 && data.length >= 2) {
    return { kind: 'length', length: new BinaryReader(data, false).readUint16() }
  }
  // Bad Message Type: the one-byte type that was not recognised.
  if (subcode === 3 && data.length >= 1) {
    const typeCode = data[0]
    return {
      kind: 'messageType',
      typeCode,
      typeName: MESSAGE_TYPE_NAMES[typeCode] ?? `Unknown (${typeCode})`,
    }
  }
  return undefined
}

/** OPEN Message Error (RFC 4271 §6.2). */
function decodeOpenError(subcode: number, data: Uint8Array): NotificationData | undefined {
  // Unsupported Version Number: the largest version the sender supports.
  if (subcode === 1 && data.length >= 2) {
    return { kind: 'version', version: new BinaryReader(data, false).readUint16() }
  }

  // Bad Peer AS. RFC 4271 does not mandate a data field here, but senders that
  // fill it in put the AS number in it, which is exactly what the receiving
  // operator needs to compare against their neighbor statement. Both widths
  // occur, since a 4-byte speaker may report either.
  if (subcode === 2) {
    const reader = new BinaryReader(data, false)
    if (data.length === 2) return { kind: 'as', asNumber: reader.readUint16() }
    if (data.length === 4) return { kind: 'as', asNumber: reader.readUint32() }
    return undefined
  }

  // Unsupported Capability: the capabilities themselves, as they appeared in
  // the OPEN — a sequence of code/length/value triples.
  if (subcode === 7) {
    const reader = new BinaryReader(data, false)
    const capabilities: Array<{ code: number; name: string; length: number }> = []

    while (reader.remaining() >= 2) {
      const code = reader.readUint8()
      const length = reader.readUint8()
      if (reader.remaining() < length) break
      reader.skip(length)
      capabilities.push({ code, name: getCapabilityName(code), length })
    }

    return capabilities.length > 0 ? { kind: 'capabilities', capabilities } : undefined
  }

  return undefined
}

/**
 * UPDATE Message Error (RFC 4271 §6.3).
 *
 * Every subcode but Malformed Attribute List carries the offending attribute,
 * complete with its flags — and the flags are frequently the fault itself, as
 * with an unknown type code whose optional bit is clear.
 */
function decodeUpdateError(subcode: number, data: Uint8Array): NotificationData | undefined {
  // 1 is Malformed Attribute List, which is about the list rather than one
  // attribute, so there is nothing single to decode.
  if (subcode === 1) return undefined
  // A flags byte, a type byte and a length byte at minimum.
  if (data.length < 3) return undefined

  const attribute = parsePathAttribute(new BinaryReader(data, false), [])

  // A length that runs past the data is a sign this is not an attribute after
  // all — better a hex dump than a confidently wrong reading.
  if (attribute.length > data.length - 3) return undefined

  return { kind: 'attribute', attribute }
}

/**
 * Cease (RFC 4271 §6.7) with a shutdown communication (RFC 9003).
 *
 * Administrative Shutdown and Administrative Reset may carry a UTF-8 sentence
 * saying why — a maintenance window, a ticket number. It is the one place in
 * BGP where the far end can explain itself in words, and dumping it as hex
 * throws that away.
 */
function decodeCease(subcode: number, data: Uint8Array): NotificationData | undefined {
  if (subcode !== 2 && subcode !== 4) return undefined

  const length = data[0]
  if (length === 0 || data.length < 1 + length) return undefined

  const message = new TextDecoder('utf-8', { fatal: false })
    .decode(data.subarray(1, 1 + length))
    .trim()

  return message.length > 0 ? { kind: 'shutdownMessage', message } : undefined
}
