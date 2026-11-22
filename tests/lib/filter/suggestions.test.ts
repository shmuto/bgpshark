import { describe, expect, test } from 'bun:test'
import { getSuggestions, suggestionsAreSettled } from '../../../src/lib/filter/parser'
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
