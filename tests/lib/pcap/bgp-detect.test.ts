import { describe, expect, test } from 'bun:test'
import { BgpFlowDetector } from '../../../src/lib/pcap/bgp-detect'

/** A minimal well-formed KEEPALIVE: marker, length 19, type 4. */
function keepalive(): Uint8Array {
  const msg = new Uint8Array(19)
  msg.fill(0xff, 0, 16)
  msg[16] = 0x00
  msg[17] = 0x13
  msg[18] = 0x04
  return msg
}

describe('BgpFlowDetector', () => {
  test('port 179 is BGP without inspection', () => {
    const d = new BgpFlowDetector()
    const warnings: string[] = []
    expect(d.isBgp('10.0.0.1', 40000, '10.0.0.2', 179, new Uint8Array([1, 2, 3]), warnings)).toBe(true)
    expect(warnings).toEqual([])
  })

  test('a non-standard port flow is recognized by its message marker', () => {
    const d = new BgpFlowDetector()
    const warnings: string[] = []
    expect(d.isBgp('10.0.0.1', 40000, '10.0.0.2', 1790, keepalive(), warnings)).toBe(true)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('non-standard port')
  })

  test('once confirmed, continuation segments and the reply leg are included', () => {
    const d = new BgpFlowDetector()
    const warnings: string[] = []
    d.isBgp('10.0.0.1', 40000, '10.0.0.2', 1790, keepalive(), warnings)
    // Continuation not aligned on a message boundary
    expect(d.isBgp('10.0.0.1', 40000, '10.0.0.2', 1790, new Uint8Array([0x01, 0x02]), warnings)).toBe(true)
    // Reverse direction
    expect(d.isBgp('10.0.0.2', 1790, '10.0.0.1', 40000, new Uint8Array([0x99]), warnings)).toBe(true)
    // Still only one warning for the flow
    expect(warnings.length).toBe(1)
  })

  test('non-BGP payloads on other ports stay excluded', () => {
    const d = new BgpFlowDetector()
    const warnings: string[] = []
    const http = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
    expect(d.isBgp('10.0.0.1', 40000, '10.0.0.2', 80, http, warnings)).toBe(false)
    expect(warnings).toEqual([])
  })

  test('a marker with an impossible length or type is not BGP', () => {
    const d = new BgpFlowDetector()
    const warnings: string[] = []
    const badLength = keepalive()
    badLength[16] = 0x00
    badLength[17] = 0x01 // length 1 < 19
    expect(d.isBgp('a', 1, 'b', 2, badLength, warnings)).toBe(false)
    const badType = keepalive()
    badType[18] = 9
    expect(d.isBgp('a', 1, 'b', 2, badType, warnings)).toBe(false)
  })
})
