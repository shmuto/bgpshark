import { describe, expect, test } from 'bun:test'
import { parseUpdateMessage } from '../../../src/lib/bgp/update'
import { afiSafiKey, type UpdateDecoding } from '../../../src/lib/bgp/session'
import type { AsPathAttribute } from '../../../src/lib/bgp/types'

const attr = (flags: number, type: number, value: number[]) => [flags, type, value.length, ...value]
const seg = (type: number, asns: number[], size: 2 | 4) => [
  type,
  asns.length,
  ...asns.flatMap((a) =>
    size === 2
      ? [(a >> 8) & 0xff, a & 0xff]
      : [(a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff]
  ),
]
const ORIGIN = attr(0x40, 1, [0])
const NEXT_HOP = attr(0x40, 3, [10, 0, 0, 1])

function update(attrs: number[], nlri: number[] = [], withdrawn: number[] = []) {
  return new Uint8Array([
    (withdrawn.length >> 8) & 0xff, withdrawn.length & 0xff, ...withdrawn,
    (attrs.length >> 8) & 0xff, attrs.length & 0xff, ...attrs,
    ...nlri,
  ])
}

const decoding = (over: Partial<UpdateDecoding> = {}): UpdateDecoding => ({
  fourByteAs: null,
  addPath: new Set(),
  ...over,
})

const asPathOf = (attrs: ReturnType<typeof parseUpdateMessage>['pathAttributes']) => {
  const found = attrs.find((a) => a.typeCode === 2)?.parsed
  return found?.type === 'AS_PATH' ? (found as AsPathAttribute).segments : null
}

describe('NLRI with Path Identifiers (RFC 7911)', () => {
  // 10.1.1.0/24 announced twice, once per path, as a session with ADD-PATH sends it.
  const withPathIds = [0, 0, 0, 1, 24, 10, 1, 1, 0, 0, 0, 2, 24, 10, 1, 1]

  test('reads the prefixes when the session negotiated ADD-PATH', () => {
    const warnings: string[] = []
    const msg = parseUpdateMessage(
      update([...ORIGIN, ...NEXT_HOP], withPathIds),
      warnings,
      decoding({ addPath: new Set([afiSafiKey(1, 1)]) })
    )

    expect(msg.nlri.map((p) => `${p.prefix}/${p.length}`)).toEqual(['10.1.1.0/24', '10.1.1.0/24'])
    expect(warnings).toEqual([])
  })

  test('a Path Identifier is not mistaken for prefixes when it is really there', () => {
    // Without the fix this decoded into 0.0.0.0/0 and friends — routes nobody
    // announced, a default route among them.
    const msg = parseUpdateMessage(
      update([...ORIGIN, ...NEXT_HOP], withPathIds),
      [],
      decoding({ addPath: new Set([afiSafiKey(1, 1)]) })
    )
    expect(msg.nlri.some((p) => p.length === 0)).toBe(false)
  })

  test('an NLRI block ending mid Path Identifier is reported', () => {
    const warnings: string[] = []
    parseUpdateMessage(
      update([...ORIGIN, ...NEXT_HOP], [0, 0]),
      warnings,
      decoding({ addPath: new Set([afiSafiKey(1, 1)]) })
    )
    expect(warnings.join(' ')).toContain('Path Identifier')
  })

  test('a session without ADD-PATH still reads plain NLRI', () => {
    const msg = parseUpdateMessage(update([...ORIGIN, ...NEXT_HOP], [24, 10, 1, 1]), [], decoding())
    expect(msg.nlri.map((p) => `${p.prefix}/${p.length}`)).toEqual(['10.1.1.0/24'])
  })
})

describe('prefix length validation', () => {
  test('a length beyond the family maximum is a warning, not a lost message', () => {
    const warnings: string[] = []
    const msg = parseUpdateMessage(update([...ORIGIN, ...NEXT_HOP], [40, 10, 1, 1, 0, 0]), warnings)

    // The attributes still arrived; only the bad NLRI block was abandoned.
    expect(msg.pathAttributes.length).toBe(2)
    expect(warnings.join(' ')).toContain('exceeds the maximum 32')
  })

  test('a prefix running past its block is a warning too', () => {
    const warnings: string[] = []
    parseUpdateMessage(update([...ORIGIN, ...NEXT_HOP], [24, 10]), warnings)
    expect(warnings.join(' ')).toContain('runs past the end')
  })

  test('the warning points at ADD-PATH, the usual cause', () => {
    const warnings: string[] = []
    parseUpdateMessage(update([...ORIGIN, ...NEXT_HOP], [40, 10, 1, 1, 0, 0]), warnings)
    expect(warnings.join(' ')).toContain('ADD-PATH')
  })
})

describe('AS_PATH sizing', () => {
  // Aggregation puts an AS_SET after the sequence, which is where guessing the
  // AS size from the byte count used to go wrong in both directions.
  const twoByte = [...seg(2, [65001, 65002], 2), ...seg(1, [65003], 2)]
  const fourByte = [...seg(2, [65001, 65002], 4), ...seg(1, [65003], 4)]

  test('a session that negotiated 4-byte reads a 4-byte path', () => {
    const msg = parseUpdateMessage(
      update([...ORIGIN, ...attr(0x40, 2, fourByte), ...NEXT_HOP], [24, 10, 1, 1]),
      [],
      decoding({ fourByteAs: true })
    )
    expect(asPathOf(msg.pathAttributes)).toEqual([
      { type: 'AS_SEQUENCE', asNumbers: [65001, 65002] },
      { type: 'AS_SET', asNumbers: [65003] },
    ])
  })

  test('a session that did not reads a 2-byte path', () => {
    const msg = parseUpdateMessage(
      update([...ORIGIN, ...attr(0x40, 2, twoByte), ...NEXT_HOP], [24, 10, 1, 1]),
      [],
      decoding({ fourByteAs: false })
    )
    expect(asPathOf(msg.pathAttributes)).toEqual([
      { type: 'AS_SEQUENCE', asNumbers: [65001, 65002] },
      { type: 'AS_SET', asNumbers: [65003] },
    ])
  })

  test('a 4-byte path is read correctly with no session to go on', () => {
    const msg = parseUpdateMessage(
      update([...ORIGIN, ...attr(0x40, 2, fourByte), ...NEXT_HOP], [24, 10, 1, 1]),
      [],
      decoding()
    )
    expect(asPathOf(msg.pathAttributes)).toEqual([
      { type: 'AS_SEQUENCE', asNumbers: [65001, 65002] },
      { type: 'AS_SET', asNumbers: [65003] },
    ])
  })

  test('a path that fits both ways without a session says so', () => {
    const warnings: string[] = []
    parseUpdateMessage(
      update([...ORIGIN, ...attr(0x40, 2, twoByte), ...NEXT_HOP], [24, 10, 1, 1]),
      warnings,
      decoding()
    )
    // Undecidable from the attribute alone, so the reading is declared rather
    // than presented as fact.
    expect(warnings.join(' ')).toContain('may be wrong')
  })

  test('an unambiguous single-segment path needs no warning', () => {
    const warnings: string[] = []
    const msg = parseUpdateMessage(
      update([...ORIGIN, ...attr(0x40, 2, seg(2, [65001, 65002], 2)), ...NEXT_HOP], [24, 10, 1, 1]),
      warnings,
      decoding()
    )
    expect(asPathOf(msg.pathAttributes)).toEqual([{ type: 'AS_SEQUENCE', asNumbers: [65001, 65002] }])
    expect(warnings).toEqual([])
  })
})

describe('AS4_PATH reconciliation (RFC 6793)', () => {
  test('the real AS number replaces AS_TRANS', () => {
    const msg = parseUpdateMessage(
      update(
        [
          ...ORIGIN,
          ...attr(0x40, 2, seg(2, [65001, 23456], 2)),
          ...attr(0xc0, 17, seg(2, [65001, 100000], 4)),
          ...NEXT_HOP,
        ],
        [24, 10, 1, 1]
      ),
      [],
      decoding({ fourByteAs: false })
    )
    expect(asPathOf(msg.pathAttributes)).toEqual([{ type: 'AS_SEQUENCE', asNumbers: [65001, 100000] }])
  })

  test('hops only AS_PATH knows about are kept in front', () => {
    const msg = parseUpdateMessage(
      update(
        [
          ...ORIGIN,
          ...attr(0x40, 2, seg(2, [65001, 65002, 23456], 2)),
          ...attr(0xc0, 17, seg(2, [100000], 4)),
          ...NEXT_HOP,
        ],
        [24, 10, 1, 1]
      ),
      [],
      decoding({ fourByteAs: false })
    )
    expect(asPathOf(msg.pathAttributes)).toEqual([
      { type: 'AS_SEQUENCE', asNumbers: [65001, 65002] },
      { type: 'AS_SEQUENCE', asNumbers: [100000] },
    ])
  })

  test('both attributes are still available for inspection', () => {
    const msg = parseUpdateMessage(
      update(
        [...ORIGIN, ...attr(0x40, 2, seg(2, [65001, 23456], 2)), ...attr(0xc0, 17, seg(2, [65001, 100000], 4)), ...NEXT_HOP],
        [24, 10, 1, 1]
      ),
      [],
      decoding({ fourByteAs: false })
    )
    expect(msg.pathAttributes.some((a) => a.typeCode === 17)).toBe(true)
  })

  test('an AS_PATH shorter than AS4_PATH is left alone', () => {
    // RFC 6793 says AS_PATH wins when it is the shorter of the two.
    const msg = parseUpdateMessage(
      update(
        [...ORIGIN, ...attr(0x40, 2, seg(2, [23456], 2)), ...attr(0xc0, 17, seg(2, [65001, 100000], 4)), ...NEXT_HOP],
        [24, 10, 1, 1]
      ),
      [],
      decoding({ fourByteAs: false })
    )
    expect(asPathOf(msg.pathAttributes)).toEqual([{ type: 'AS_SEQUENCE', asNumbers: [23456] }])
  })

  test('an UPDATE without AS4_PATH is untouched', () => {
    const msg = parseUpdateMessage(
      update([...ORIGIN, ...attr(0x40, 2, seg(2, [65001, 65002], 2)), ...NEXT_HOP], [24, 10, 1, 1]),
      [],
      decoding({ fourByteAs: false })
    )
    expect(asPathOf(msg.pathAttributes)).toEqual([{ type: 'AS_SEQUENCE', asNumbers: [65001, 65002] }])
  })
})
