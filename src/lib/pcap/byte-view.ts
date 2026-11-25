/**
 * Packets whose bytes are a view made when asked for, rather than one held
 * per packet.
 *
 * Every frame of a capture kept a `Uint8Array` over its bytes in the file
 * (`GenericPacket.frameBytes`), and every BGP packet another over its TCP
 * payload (`BgpPacket.rawData`). A view is cheap to make but not to keep: in
 * Chromium each is an object of about 70 bytes, so the two were some 140 bytes
 * of every packet — over 300MB of a 300MB capture of small UPDATEs — to hold
 * bytes that are read for one packet at a time: the one open in the detail
 * pane, or the ones being written out to a file. Keeping where the bytes are
 * instead costs three small integers and a reference to the file's buffer,
 * which the views kept alive anyway.
 *
 * Each read makes a new view, so `packet.rawData !== packet.rawData`; read it
 * once into a local where that matters. Nothing reads it in a loop over every
 * packet.
 */
import type { BgpMessage, BgpPacket } from '../bgp/types'
import type { GenericPacket, TcpFlags } from './types'

/** A `GenericPacket` made from one with its frame bytes as a view, which it does not keep. */
export class CapturedFrame implements GenericPacket {
  readonly frameIndex: number
  readonly timestamp: Date
  readonly capturedLength: number
  readonly originalLength: number
  readonly srcIp: string
  readonly dstIp: string
  readonly protocol: GenericPacket['protocol']
  readonly protocolNumber: number
  readonly srcPort?: number
  readonly dstPort?: number
  readonly tcpFlags?: TcpFlags
  readonly payloadLength: number
  private readonly source: ArrayBufferLike
  private readonly byteOffset: number
  private readonly byteLength: number

  constructor(init: GenericPacket) {
    this.frameIndex = init.frameIndex
    this.timestamp = init.timestamp
    this.capturedLength = init.capturedLength
    this.originalLength = init.originalLength
    this.srcIp = init.srcIp
    this.dstIp = init.dstIp
    this.protocol = init.protocol
    this.protocolNumber = init.protocolNumber
    this.srcPort = init.srcPort
    this.dstPort = init.dstPort
    this.tcpFlags = init.tcpFlags
    this.payloadLength = init.payloadLength
    this.source = init.frameBytes.buffer
    this.byteOffset = init.frameBytes.byteOffset
    this.byteLength = init.frameBytes.byteLength
  }

  get frameBytes(): Uint8Array {
    return new Uint8Array(this.source, this.byteOffset, this.byteLength)
  }
}

/** A `BgpPacket` with its TCP payload given as a view, which it does not keep. */
export class DecodedPacket implements BgpPacket {
  readonly frameIndex: number
  readonly timestamp: Date
  readonly srcIp: string
  readonly dstIp: string
  readonly srcPort: number
  readonly dstPort: number
  readonly messages: BgpMessage[]
  readonly parseWarnings: string[]
  private readonly source: ArrayBufferLike
  private readonly byteOffset: number
  private readonly byteLength: number

  constructor(init: BgpPacket) {
    this.frameIndex = init.frameIndex
    this.timestamp = init.timestamp
    this.srcIp = init.srcIp
    this.dstIp = init.dstIp
    this.srcPort = init.srcPort
    this.dstPort = init.dstPort
    this.messages = init.messages
    this.parseWarnings = init.parseWarnings
    this.source = init.rawData.buffer
    this.byteOffset = init.rawData.byteOffset
    this.byteLength = init.rawData.byteLength
  }

  get rawData(): Uint8Array {
    return new Uint8Array(this.source, this.byteOffset, this.byteLength)
  }
}
