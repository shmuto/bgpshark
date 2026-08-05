/**
 * Decide which TCP packets carry BGP.
 *
 * Port 179 is the rule, but real captures contain sessions on other ports —
 * lab setups, NAT rewrites, route servers behind port forwards. Rather than a
 * "decode as" dialog, flows are sniffed: a BGP message can only begin with 16
 * bytes of 0xff marker followed by a plausible length and type, and sixteen
 * fixed bytes make accidental matches on other protocols vanishingly unlikely.
 *
 * Detection is per flow, not per packet: once one segment of a flow looks like
 * BGP, the whole flow (both directions) is decoded, because later segments are
 * continuations that need not start on a message boundary. The limitation is
 * the mirror of that: if the capture starts mid-message on a non-standard
 * port, the flow's first observed segment fails the sniff and the flow stays
 * undecoded until an aligned segment appears.
 */

const BGP_PORT = 179

/** BGP message types 1-5: OPEN, UPDATE, NOTIFICATION, KEEPALIVE, ROUTE-REFRESH. */
function looksLikeBgp(payload: Uint8Array): boolean {
  if (payload.length < 19) return false
  for (let i = 0; i < 16; i++) {
    if (payload[i] !== 0xff) return false
  }
  const length = (payload[16] << 8) | payload[17]
  if (length < 19 || length > 4096) return false
  const type = payload[18]
  return type >= 1 && type <= 5
}

export class BgpFlowDetector {
  private confirmed = new Set<string>()

  /** Direction-independent, so the reply leg of a confirmed flow is included. */
  private static flowKey(srcIp: string, srcPort: number, dstIp: string, dstPort: number): string {
    const a = `${srcIp}:${srcPort}`
    const b = `${dstIp}:${dstPort}`
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }

  /**
   * Whether this TCP payload belongs to a BGP session. Emits one warning per
   * non-standard-port flow so the engineer knows decoding rested on a
   * heuristic rather than on the port number.
   */
  isBgp(
    srcIp: string,
    srcPort: number,
    dstIp: string,
    dstPort: number,
    payload: Uint8Array,
    warnings: string[]
  ): boolean {
    if (srcPort === BGP_PORT || dstPort === BGP_PORT) return true

    const key = BgpFlowDetector.flowKey(srcIp, srcPort, dstIp, dstPort)
    if (this.confirmed.has(key)) return true

    if (looksLikeBgp(payload)) {
      this.confirmed.add(key)
      warnings.push(
        `TCP flow ${srcIp}:${srcPort} ↔ ${dstIp}:${dstPort} runs on a non-standard port but carries BGP — decoded as BGP`
      )
      return true
    }

    return false
  }
}
