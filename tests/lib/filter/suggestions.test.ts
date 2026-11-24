import { describe, expect, test } from 'bun:test'
import {
  filterValuesForAsync,
  getSuggestions,
  hasFilterValues,
  suggestionsAreSettled,
} from '../../../src/lib/filter/parser'
import type { BgpPacket } from '../../../src/lib/bgp/types'

function packet(srcIp: string, dstIp: string): BgpPacket {
  return {
    frameIndex: 1,
    timestamp: new Date(0),
    srcIp,
    dstIp,
    srcPort: 179,
    dstPort: 50000,
    messages: [],
    rawData: new Uint8Array(),
    parseWarnings: [],
  }
}

describe('when the suggestion list has nothing left to say', () => {
  const packets = [packet('10.0.13.1', '10.0.13.3')]
  const settled = (query: string) =>
    suggestionsAreSettled(query, getSuggestions(query, query.length, packets))

  test('a value typed in full closes it', () => {
    expect(settled('ip = 10.0.13.1')).toBe(true)
    expect(settled('type = UPDATE')).toBe(true)
    expect(settled('type = update')).toBe(true)
  })

  test('a value still being typed keeps it open', () => {
    expect(settled('ip = 10.0.13')).toBe(false)
    expect(settled('type = UPD')).toBe(false)
    expect(settled('')).toBe(false)
  })
})

describe('values gathered in the background', () => {
  const texts = (query: string, packets: BgpPacket[], onlyGatheredValues: boolean) =>
    getSuggestions(query, query.length, packets, 'en', { onlyGatheredValues }).map((s) => s.text)

  test('until they are gathered, a value list is empty and nothing walks the packets', () => {
    const packets = [packet('10.0.13.1', '10.0.13.3')]
    expect(texts('ip = ', packets, true)).toEqual([])
    expect(texts('src_ip = 10', packets, true)).toEqual([])
    expect(hasFilterValues(packets)).toBe(false)
  })

  test('fields, operators and fixed values are offered meanwhile', () => {
    const packets = [packet('10.0.13.1', '10.0.13.3')]
    expect(texts('', packets, true)).toContain('prefix')
    expect(texts('src_ip ', packets, true)).toContain('=')
    expect(texts('type = ', packets, true)).toContain('UPDATE')
    expect(hasFilterValues(packets)).toBe(false)
  })

  test('once gathered, they are the values a synchronous call finds', async () => {
    const packets = [packet('10.0.13.1', '10.0.13.3'), packet('10.0.13.3', '10.0.13.1')]
    expect(await filterValuesForAsync(packets)).toBe(true)
    expect(hasFilterValues(packets)).toBe(true)
    expect(texts('ip = ', packets, true)).toEqual(texts('ip = ', [...packets], false))
    expect(texts('ip = ', packets, true)).toEqual(['10.0.13.1', '10.0.13.3'])
  })

  test('focusing an empty box gathers nothing', () => {
    const packets = [packet('10.0.13.1', '10.0.13.3')]
    getSuggestions('', 0, packets)
    getSuggestions('prefix', 6, packets)
    expect(hasFilterValues(packets)).toBe(false)
  })
})
