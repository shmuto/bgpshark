import { describe, expect, test } from 'bun:test'
import {
  parseExtendedCommunities,
  formatExtendedCommunity,
} from '../../../src/lib/bgp/extended-communities'
import { BinaryReader } from '../../../src/lib/pcap/reader'

function read(bytes: number[]) {
  return parseExtendedCommunities(new BinaryReader(new Uint8Array(bytes), false), bytes.length)
}

describe('Route Target', () => {
  test('a two-octet AS target reads as AS:number', () => {
    // 0x00 two-octet AS, subtype 0x02 route target, AS 65001, number 100
    const [rt] = read([0x00, 0x02, 0xfd, 0xe9, 0, 0, 0, 100])
    expect(rt.kind).toBe('Route Target')
    expect(rt.value).toBe('65001:100')
    expect(rt.transitive).toBe(true)
  })

  test('an IPv4 target reads as address:number', () => {
    const [rt] = read([0x01, 0x02, 10, 0, 0, 1, 0, 100])
    expect(rt.value).toBe('10.0.0.1:100')
  })

  test('a four-octet AS target reads as AS:number', () => {
    const [rt] = read([0x02, 0x02, 0x00, 0x01, 0x86, 0xa0, 0, 100])
    expect(rt.value).toBe('100000:100')
  })

  test('a non-transitive target says so', () => {
    // 0x40 sets the non-transitive bit on the two-octet AS type.
    const [rt] = read([0x40, 0x02, 0xfd, 0xe9, 0, 0, 0, 100])
    expect(rt.kind).toBe('Route Target')
    expect(rt.transitive).toBe(false)
  })

  test('route origin is told apart from route target', () => {
    const [soo] = read([0x00, 0x03, 0xfd, 0xe9, 0, 0, 0, 7])
    expect(soo.kind).toBe('Route Origin')
    expect(soo.value).toBe('65001:7')
  })
})

describe('the EVPN communities', () => {
  test('MAC Mobility carries the sequence number that settles a move', () => {
    // flags 0, reserved 0, sequence 3
    const [mm] = read([0x06, 0x00, 0x00, 0x00, 0, 0, 0, 3])
    expect(mm.kind).toBe('MAC Mobility')
    expect(mm.value).toBe('seq 3')
  })

  test('a sticky MAC is flagged, because then a move is a conflict', () => {
    const [mm] = read([0x06, 0x00, 0x01, 0x00, 0, 0, 0, 5])
    expect(mm.value).toBe('seq 5 (sticky)')
  })

  test("the router's MAC is read as a MAC", () => {
    const [rm] = read([0x06, 0x03, 0x00, 0x0c, 0x29, 0xaa, 0xbb, 0xcc])
    expect(rm.kind).toBe("Router's MAC")
    expect(rm.value).toBe('00:0c:29:aa:bb:cc')
  })

  test('an ESI label says which redundancy mode it is', () => {
    // flags 0x01 = single-active, label 0x007d21 >> 4 = 2002
    const [esi] = read([0x06, 0x01, 0x01, 0x00, 0x00, 0x00, 0x7d, 0x21])
    expect(esi.kind).toBe('ESI Label')
    expect(esi.value).toBe('2002 (single-active)')
  })

  test('an all-active ESI label says that instead', () => {
    const [esi] = read([0x06, 0x01, 0x00, 0x00, 0x00, 0x00, 0x7d, 0x21])
    expect(esi.value).toBe('2002 (all-active)')
  })
})

describe('encapsulation', () => {
  test('VXLAN is named', () => {
    // Opaque type, subtype 0x0c, tunnel type 8.
    const [enc] = read([0x03, 0x0c, 0, 0, 0, 0, 0, 8])
    expect(enc.kind).toBe('Encapsulation')
    expect(enc.value).toBe('VXLAN')
  })

  test('an unnamed tunnel type keeps its number', () => {
    const [enc] = read([0x03, 0x0c, 0, 0, 0, 0, 0, 200])
    expect(enc.value).toBe('tunnel type 200')
  })
})

describe('reading a whole attribute', () => {
  test('several communities are all read', () => {
    const communities = read([
      0x00, 0x02, 0xfd, 0xe9, 0, 0, 0, 100,
      0x06, 0x00, 0x00, 0x00, 0, 0, 0, 3,
      0x03, 0x0c, 0, 0, 0, 0, 0, 8,
    ])
    expect(communities.map((c) => c.kind)).toEqual(['Route Target', 'MAC Mobility', 'Encapsulation'])
  })

  test('a community this parser does not know keeps its bytes', () => {
    // Evidence is evidence even when it cannot be named.
    const [unknown] = read([0x80, 0x77, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01])
    expect(unknown.unknown).toBe(true)
    expect(unknown.value).toBe('de:ad:be:ef:00:01')
    expect(unknown.kind).toContain('0x80')
  })

  test('a trailing partial community is skipped rather than half-read', () => {
    const communities = read([0x00, 0x02, 0xfd, 0xe9, 0, 0, 0, 100, 0x00, 0x02, 0xff])
    expect(communities).toHaveLength(1)
  })
})

describe('formatExtendedCommunity', () => {
  test('reads as kind then value', () => {
    const [rt] = read([0x00, 0x02, 0xfd, 0xe9, 0, 0, 0, 100])
    expect(formatExtendedCommunity(rt)).toBe('Route Target 65001:100')
  })
})
