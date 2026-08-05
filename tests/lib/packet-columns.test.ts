import { describe, test, expect } from 'bun:test'
import {
  formatDeltaTime,
  summarizePacketPrefixes,
  PREFIX_DISPLAY_LIMIT,
} from '../../src/lib/packet-columns'
import type {
  BgpMessage,
  BgpPathAttribute,
  BgpPrefix,
  BgpUpdateMessage,
  ParsedPathAttribute,
} from '../../src/lib/bgp/types'

/** `10.0.12.0/24` written the short way the tests read in. */
function prefix(text: string): BgpPrefix {
  const [address, length] = text.split('/')
  return { prefix: address, length: Number(length) }
}

function attribute(parsed: ParsedPathAttribute): BgpPathAttribute {
  return {
    flags: { optional: false, transitive: true, partial: false, extendedLength: false },
    typeCode: 0,
    typeName: parsed.type,
    length: 0,
    rawValue: new Uint8Array(),
    parsed,
  }
}

function update(fields: Partial<BgpUpdateMessage> = {}): BgpUpdateMessage {
  return {
    type: 'UPDATE',
    withdrawnRoutesLength: 0,
    withdrawnRoutes: [],
    totalPathAttrLength: 0,
    pathAttributes: [],
    nlri: [],
    ...fields,
  }
}

const keepalive: BgpMessage = { type: 'KEEPALIVE' }

describe('summarizePacketPrefixes', () => {
  test('shows the first prefixes and counts the rest', () => {
    const summary = summarizePacketPrefixes([
      update({ nlri: ['10.1.1.0/24', '10.2.0.0/16', '10.3.0.0/16', '10.4.0.0/16', '10.5.0.0/16'].map(prefix) }),
    ])

    expect(summary?.announced.shown).toEqual(['10.1.1.0/24', '10.2.0.0/16'])
    expect(summary?.announced.overflow).toBe(3)
    expect(summary?.withdrawn.shown).toEqual([])
    expect(summary?.withdrawn.overflow).toBe(0)
    expect(PREFIX_DISPLAY_LIMIT).toBe(2)
  })

  test('keeps announced and withdrawn apart in one UPDATE', () => {
    const summary = summarizePacketPrefixes([
      update({
        nlri: [prefix('10.1.1.0/24')],
        withdrawnRoutes: ['192.0.2.0/24', '198.51.100.0/24'].map(prefix),
      }),
    ])

    expect(summary?.announced.shown).toEqual(['10.1.1.0/24'])
    expect(summary?.withdrawn.shown).toEqual(['192.0.2.0/24', '198.51.100.0/24'])
    expect(summary?.withdrawn.overflow).toBe(0)
  })

  test('a withdrawn-only UPDATE announces nothing', () => {
    const summary = summarizePacketPrefixes([
      update({ withdrawnRoutes: ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'].map(prefix) }),
    ])

    expect(summary?.announced.shown).toEqual([])
    expect(summary?.withdrawn.shown).toEqual(['192.0.2.0/24', '198.51.100.0/24'])
    expect(summary?.withdrawn.overflow).toBe(1)
    expect(summary?.endOfRib).toBe(false)
  })

  test('counts MP_REACH and MP_UNREACH prefixes alongside the classic fields', () => {
    const summary = summarizePacketPrefixes([
      update({
        pathAttributes: [
          attribute({
            type: 'MP_REACH_NLRI',
            afi: 2,
            afiName: 'IPv6',
            safi: 1,
            safiName: 'Unicast',
            nextHop: '2001:db8:0:0:0:0:0:1',
            nlri: ['2001:db8:0:0:0:0:0:0/32', '2001:db8:1:0:0:0:0:0/48'].map(prefix),
          }),
          attribute({
            type: 'MP_UNREACH_NLRI',
            afi: 2,
            afiName: 'IPv6',
            safi: 1,
            safiName: 'Unicast',
            withdrawnRoutes: [prefix('2001:db8:2:0:0:0:0:0/48')],
          }),
        ],
      }),
    ])

    expect(summary?.announced.shown).toEqual(['2001:db8:0:0:0:0:0:0/32', '2001:db8:1:0:0:0:0:0/48'])
    expect(summary?.withdrawn.shown).toEqual(['2001:db8:2:0:0:0:0:0/48'])
  })

  test('classic NLRI comes before MP_REACH when both are present', () => {
    const summary = summarizePacketPrefixes([
      update({
        nlri: [prefix('10.1.1.0/24')],
        pathAttributes: [
          attribute({
            type: 'MP_REACH_NLRI',
            afi: 2,
            afiName: 'IPv6',
            safi: 1,
            safiName: 'Unicast',
            nextHop: '2001:db8:0:0:0:0:0:1',
            nlri: ['2001:db8:0:0:0:0:0:0/32', '2001:db8:1:0:0:0:0:0/48'].map(prefix),
          }),
        ],
      }),
    ])

    expect(summary?.announced.shown).toEqual(['10.1.1.0/24', '2001:db8:0:0:0:0:0:0/32'])
    expect(summary?.announced.overflow).toBe(1)
  })

  test('aggregates every UPDATE in a packet', () => {
    const summary = summarizePacketPrefixes([
      update({ nlri: [prefix('10.1.1.0/24')] }),
      update({ nlri: [prefix('10.2.0.0/16')] }),
      update({ nlri: [prefix('10.3.0.0/16')], withdrawnRoutes: [prefix('192.0.2.0/24')] }),
    ])

    expect(summary?.announced.shown).toEqual(['10.1.1.0/24', '10.2.0.0/16'])
    expect(summary?.announced.overflow).toBe(1)
    expect(summary?.withdrawn.shown).toEqual(['192.0.2.0/24'])
  })

  test('non-UPDATE messages summarise to nothing at all', () => {
    expect(summarizePacketPrefixes([keepalive])).toBeNull()
    expect(summarizePacketPrefixes([])).toBeNull()
  })

  test('an UPDATE alongside a KEEPALIVE still reports its prefixes', () => {
    const summary = summarizePacketPrefixes([keepalive, update({ nlri: [prefix('10.1.1.0/24')] })])

    expect(summary?.announced.shown).toEqual(['10.1.1.0/24'])
  })

  test('End-of-RIB is flagged rather than reported as an empty UPDATE', () => {
    const summary = summarizePacketPrefixes([update()])

    expect(summary?.endOfRib).toBe(true)
    expect(summary?.announced.shown).toEqual([])
    expect(summary?.announced.overflow).toBe(0)
    expect(summary?.withdrawn.shown).toEqual([])
  })

  test('an End-of-RIB packet that also carries routes still shows the routes', () => {
    const summary = summarizePacketPrefixes([update(), update({ nlri: [prefix('10.1.1.0/24')] })])

    expect(summary?.endOfRib).toBe(true)
    expect(summary?.announced.shown).toEqual(['10.1.1.0/24'])
  })
})

describe('formatDeltaTime', () => {
  test('sub-second gaps keep their milliseconds', () => {
    expect(formatDeltaTime(12)).toBe('+0.012s')
    expect(formatDeltaTime(0)).toBe('+0.000s')
    expect(formatDeltaTime(999)).toBe('+0.999s')
  })

  test('gaps of seconds read as seconds', () => {
    expect(formatDeltaTime(1000)).toBe('+1.0s')
    expect(formatDeltaTime(2040)).toBe('+2.0s')
    expect(formatDeltaTime(59_900)).toBe('+59.9s')
  })

  test('gaps past a minute read as minutes and seconds', () => {
    expect(formatDeltaTime(60_000)).toBe('+1m0s')
    expect(formatDeltaTime(100_000)).toBe('+1m40s')
    expect(formatDeltaTime(91_000)).toBe('+1m31s')
    expect(formatDeltaTime(3_599_000)).toBe('+59m59s')
  })

  test('gaps past an hour read as hours and minutes', () => {
    expect(formatDeltaTime(3_600_000)).toBe('+1h0m')
    expect(formatDeltaTime(7_500_000)).toBe('+2h5m')
  })

  test('a gap that rounds up to the next unit is shown in that unit', () => {
    expect(formatDeltaTime(999.7)).toBe('+1.0s')
    expect(formatDeltaTime(59_990)).toBe('+1m0s')
  })

  test('timestamps that go backwards are shown, not hidden', () => {
    expect(formatDeltaTime(-500)).toBe('-0.500s')
    expect(formatDeltaTime(-120_000)).toBe('-2m0s')
  })
})
