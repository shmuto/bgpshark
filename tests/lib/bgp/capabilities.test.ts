import { describe, test, expect } from 'bun:test'
import { parseBgpFromPackets } from '../../../src/lib/bgp/parser'
import type { RawPacket } from '../../../src/lib/pcap/types'
import type {
  BgpOpenMessage,
  AddPathCapability,
  ExtendedNextHopCapability,
} from '../../../src/lib/bgp/types'

/**
 * These capabilities carry a variable-length list, which is exactly what the
 * flattened DuckDB `capabilities` table (one AFI/SAFI pair, one AS number)
 * cannot represent. Rebuilding packets from those rows produced capabilities
 * whose `parsed` was missing its list entirely, and the OPEN detail view
 * crashed on `.map()` the moment a filter was applied.
 *
 * The fix removed that reconstruction — DuckDB now returns frame indexes and
 * the UI keeps using these parsed objects — so what is worth pinning here is
 * that the parser really does produce complete structures. Anything that
 * reintroduces a lossy round-trip has to fail against these shapes.
 */

function createOpenWithCapabilities(capabilityBytes: number[]): RawPacket {
  const optParams = [2, capabilityBytes.length, ...capabilityBytes]
  const body = [
    4, // version
    0xfd, 0xe9, // my AS 65001
    0x00, 0x5a, // hold time 90
    10, 0, 0, 1, // BGP identifier
    optParams.length,
    ...optParams,
  ]

  const length = 19 + body.length
  const data = new Uint8Array([
    ...new Array(16).fill(0xff),
    (length >> 8) & 0xff,
    length & 0xff,
    1, // OPEN
    ...body,
  ])

  return {
    frameIndex: 1,
    timestamp: new Date(0),
    srcIp: '10.0.0.1',
    dstIp: '10.0.0.2',
    srcPort: 179,
    dstPort: 50000,
    tcpPayload: data,
  } as RawPacket
}

function parseSingleOpen(capabilityBytes: number[]): BgpOpenMessage {
  const result = parseBgpFromPackets([createOpenWithCapabilities(capabilityBytes)])
  expect(result.packets).toHaveLength(1)
  const message = result.packets[0].messages[0]
  expect(message.type).toBe('OPEN')
  return message as BgpOpenMessage
}

describe('capabilities carrying variable-length lists', () => {
  test('ADD-PATH keeps every address family it advertised', () => {
    // Code 69, length 8: two families - IPv4/unicast receive, IPv6/unicast both
    const open = parseSingleOpen([
      69, 8,
      0x00, 0x01, 0x01, 1,
      0x00, 0x02, 0x01, 3,
    ])

    const addPath = open.capabilities.find((c) => c.parsed?.type === 'ADD_PATH')
    expect(addPath).toBeDefined()

    const parsed = addPath!.parsed as AddPathCapability
    // The crash was parsed.addressFamilies being undefined here
    expect(Array.isArray(parsed.addressFamilies)).toBe(true)
    expect(parsed.addressFamilies).toHaveLength(2)
    expect(parsed.addressFamilies[0].sendReceive).toBe('receive')
    expect(parsed.addressFamilies[1].sendReceive).toBe('both')
    for (const af of parsed.addressFamilies) {
      expect(typeof af.afiName).toBe('string')
      expect(typeof af.safiName).toBe('string')
    }
  })

  test('Extended Next Hop keeps every entry it advertised', () => {
    // Code 5, length 12: two triples
    const open = parseSingleOpen([
      5, 12,
      0x00, 0x01, 0x00, 0x01, 0x00, 0x02,
      0x00, 0x01, 0x00, 0x80, 0x00, 0x02,
    ])

    const cap = open.capabilities.find((c) => c.parsed?.type === 'EXTENDED_NEXT_HOP')
    expect(cap).toBeDefined()

    const parsed = cap!.parsed as ExtendedNextHopCapability
    expect(Array.isArray(parsed.entries)).toBe(true)
    expect(parsed.entries).toHaveLength(2)
    for (const entry of parsed.entries) {
      expect(typeof entry.nlriAfiName).toBe('string')
      expect(typeof entry.nexthopAfiName).toBe('string')
    }
  })

  test('a capability the schema can represent still round-trips its detail', () => {
    // Multiprotocol (code 1) and 4-byte AS (code 65) are the two the table does
    // have columns for; they must keep working alongside the list-valued ones.
    const open = parseSingleOpen([
      1, 4, 0x00, 0x01, 0x00, 0x01,
      65, 4, 0x00, 0x00, 0xfd, 0xe9,
    ])

    const mp = open.capabilities.find((c) => c.parsed?.type === 'MULTIPROTOCOL')
    expect(mp).toBeDefined()

    const fourByte = open.capabilities.find((c) => c.parsed?.type === 'FOUR_OCTET_AS')
    expect(fourByte).toBeDefined()
    expect(open.fourByteAs).toBe(65001)
  })
})
