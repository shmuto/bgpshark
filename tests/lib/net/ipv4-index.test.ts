import { describe, test, expect } from 'bun:test'
import { Ipv4PrefixIndex, ipv4PrefixAddress } from '../../../src/lib/net/ipv4-index'

describe('Ipv4PrefixIndex', () => {
  test('finds what was added, by address and length both', () => {
    const index = new Ipv4PrefixIndex()
    const ten = ipv4PrefixAddress({ prefix: '10.0.0.0', length: 8 })
    index.add(ten | 0, 8, 7)
    expect(index.get(ten | 0, 8)).toBe(7)
    // The same address under another mask is another route.
    expect(index.get(ten | 0, 16)).toBe(-1)
    expect(index.get((ten + 1) | 0, 8)).toBe(-1)
  })

  test('keeps every entry as it grows', () => {
    const index = new Ipv4PrefixIndex()
    const count = 200_000
    for (let n = 0; n < count; n++) index.add((n << 8) | 0, 24, n)
    for (let n = 0; n < count; n++) expect(index.get((n << 8) | 0, 24)).toBe(n)
    expect(index.get(count << 8, 24)).toBe(-1)
  })

  test('covers the edges of the address space and of the mask', () => {
    const index = new Ipv4PrefixIndex()
    const all = ipv4PrefixAddress({ prefix: '255.255.255.255', length: 32 })
    expect(all).toBe(4_294_967_295)
    index.add(all | 0, 32, 1)
    index.add(0, 0, 2)
    expect(index.get(all | 0, 32)).toBe(1)
    expect(index.get(0, 0)).toBe(2)
  })

  test('only IPv4 prefixes have an address', () => {
    expect(ipv4PrefixAddress({ prefix: '2001:db8::', length: 32 })).toBe(-1)
    expect(ipv4PrefixAddress({ prefix: '10.0.0.0', length: 33 })).toBe(-1)
    expect(
      ipv4PrefixAddress({
        prefix: '[2] 00:0c:29:aa:bb:cc',
        length: 0,
        evpn: { routeType: 2, routeTypeName: 'MAC/IP Advertisement', rd: '1:1' },
      } as never)
    ).toBe(-1)
  })
})
