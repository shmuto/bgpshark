/**
 * What the two ends of a BGP session agreed to, so UPDATEs can be decoded
 * rather than guessed at.
 *
 * Several things about an UPDATE's encoding are not visible in the UPDATE
 * itself — whether AS_PATH holds 2-byte or 4-byte AS numbers, whether each
 * NLRI is preceded by a Path Identifier. Both are settled during the OPEN
 * exchange, and both are negotiated: they apply only when *both* ends
 * advertised the capability. Parsing a message without that context means
 * guessing, and a wrong guess is not a parse failure — it is a plausible
 * looking route or AS path that was never on the wire.
 *
 * A capture that starts mid-session has no OPENs to learn from. There the
 * conservative defaults apply (see `DEFAULT_DECODING`), and the prefix length
 * validation in the UPDATE parser is what stops a mis-decode from being
 * silent.
 */
import type { BgpOpenMessage, AddPathCapability } from './types'

type AddPathSendReceive = AddPathCapability['addressFamilies'][number]['sendReceive']

/** How the UPDATEs flowing one way down a session should be decoded. */
export interface UpdateDecoding {
  /**
   * AS_PATH holds 4-byte AS numbers. `null` means no OPEN was seen for the
   * session, so the parser has to work it out from the attribute itself.
   */
  fourByteAs: boolean | null
  /**
   * `afi/safi` pairs whose NLRI carries a 4-byte Path Identifier (RFC 7911),
   * or `null` when the session's OPENs were not captured and there is nothing
   * to answer from.
   *
   * Null rather than an empty set, for the same reason `fourByteAs` is
   * `boolean | null`: "this session does not use ADD-PATH" and "we never saw
   * the OPENs" lead to the same decoding but are different statements, and
   * treating the second as the first is how a capture started mid-session ends
   * up showing prefixes nobody announced.
   */
  addPath: ReadonlySet<string> | null
}

export const DEFAULT_DECODING: UpdateDecoding = {
  fourByteAs: null,
  addPath: null,
}

export function afiSafiKey(afi: number, safi: number): string {
  return `${afi}/${safi}`
}

function advertisesSend(value: AddPathSendReceive): boolean {
  return value === 'send' || value === 'both'
}

function advertisesReceive(value: AddPathSendReceive): boolean {
  return value === 'receive' || value === 'both'
}

/** One end's advertised capabilities, reduced to what affects decoding. */
interface Advertised {
  fourByteAs: boolean
  /** afi/safi → what this end said it would do with Path Identifiers. */
  addPath: Map<string, AddPathSendReceive>
}

function advertisedFrom(open: BgpOpenMessage): Advertised {
  const addPath = new Map<string, AddPathSendReceive>()
  let fourByteAs = false

  for (const cap of open.capabilities) {
    if (cap.parsed?.type === 'FOUR_OCTET_AS') {
      fourByteAs = true
    } else if (cap.parsed?.type === 'ADD_PATH') {
      for (const family of (cap.parsed as AddPathCapability).addressFamilies) {
        addPath.set(afiSafiKey(family.afi, family.safi), family.sendReceive)
      }
    }
  }

  return { fourByteAs, addPath }
}

/** Identifies one end of a TCP connection. */
export function endpointKey(ip: string, port: number): string {
  return `${ip}:${port}`
}

export class BgpSessionTracker {
  /** endpoint → what that end advertised in its OPEN. */
  private advertised = new Map<string, Advertised>()

  /** Record an OPEN seen coming *from* `from`. */
  observeOpen(from: string, open: BgpOpenMessage): void {
    this.advertised.set(from, advertisedFrom(open))
  }

  /**
   * How to decode messages travelling `from` → `to`.
   *
   * Both capabilities are negotiated, so both ends have to have been seen for
   * either to apply; a session where only one OPEN was captured falls back to
   * the defaults rather than trusting half an exchange.
   */
  decodingFor(from: string, to: string): UpdateDecoding {
    const sender = this.advertised.get(from)
    const receiver = this.advertised.get(to)
    if (!sender || !receiver) return DEFAULT_DECODING

    const addPath = new Set<string>()
    for (const [key, sendReceive] of sender.addPath) {
      // The sender puts Path Identifiers on the wire only if it said it would
      // send them and the receiver said it could take them.
      const peer = receiver.addPath.get(key)
      if (peer !== undefined && advertisesSend(sendReceive) && advertisesReceive(peer)) {
        addPath.add(key)
      }
    }

    return {
      fourByteAs: sender.fourByteAs && receiver.fourByteAs,
      addPath,
    }
  }
}
