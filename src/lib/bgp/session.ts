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

/**
 * What one direction of a session agreed about ADD-PATH, for one family.
 *
 * The two halves are kept apart rather than reduced to a yes/no because the
 * interesting failure is not "neither side asked for it" — it is two routers
 * both configured to *send* additional paths and neither willing to receive
 * them. Both OPENs name the family, a capability diff comparing advertisements
 * calls that a match, and no Path Identifier is ever sent in either direction.
 */
export interface AddPathDirection {
  afi: number
  safi: number
  /** The sending end advertised that it would send Path Identifiers. */
  senderSends: boolean
  /** The receiving end advertised that it could take them. */
  receiverReceives: boolean
  /** Both of the above, which is the only case that puts identifiers on the wire. */
  negotiated: boolean
}

/**
 * ADD-PATH for messages travelling from the sender of `from` to the sender of
 * `to`, per address family.
 *
 * Every family either OPEN named is reported, including one only a single side
 * named — that is a mismatch, and leaving it out would hide it.
 *
 * The one place this is worked out. `decodingFor` reads it to decide how to
 * parse NLRI and the neighbour screen reads it to say what was agreed; two
 * implementations of a negotiation this asymmetric would drift, and the screen
 * would then contradict the prefixes on it.
 */
export function addPathDirections(
  from: BgpOpenMessage,
  to: BgpOpenMessage
): AddPathDirection[] {
  return addPathBetween(advertisedFrom(from).addPath, advertisedFrom(to).addPath)
}

type AddPathFamilies = ReadonlyMap<string, AddPathSendReceive>

function addPathBetween(sender: AddPathFamilies, receiver: AddPathFamilies): AddPathDirection[] {
  return [...new Set([...sender.keys(), ...receiver.keys()])]
    .map((key) => {
      const [afi, safi] = key.split('/').map(Number)
      const senderSends = advertisesSend(sender.get(key) ?? 'receive')
      const receiverReceives = advertisesReceive(receiver.get(key) ?? 'send')
      // A family the other side never named is not negotiated whatever this
      // side offered, which the defaults above already produce: the missing
      // side reads as the direction it did not commit to.
      const present = sender.has(key) && receiver.has(key)
      return {
        afi,
        safi,
        senderSends: sender.has(key) && senderSends,
        receiverReceives: receiver.has(key) && receiverReceives,
        negotiated: present && senderSends && receiverReceives,
      }
    })
    .sort((a, b) => a.afi - b.afi || a.safi - b.safi)
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

    // Through the same function the neighbour screen uses, so what that screen
    // says was agreed and how the NLRI on it was parsed cannot disagree.
    const addPath = new Set(
      addPathBetween(sender.addPath, receiver.addPath)
        .filter((family) => family.negotiated)
        .map((family) => afiSafiKey(family.afi, family.safi))
    )

    return {
      fourByteAs: sender.fourByteAs && receiver.fourByteAs,
      addPath,
    }
  }
}
