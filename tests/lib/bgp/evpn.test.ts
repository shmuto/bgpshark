import { describe, expect, test } from 'bun:test'
import { parseEvpnNlri, formatEvpnRoute } from '../../../src/lib/bgp/evpn'
import { parseUpdateMessage } from '../../../src/lib/bgp/update'
import { BinaryReader } from '../../../src/lib/pcap/reader'
import type { MpReachNlriAttribute } from '../../../src/lib/bgp/types'

/** RD type 1: an IPv4 administrator and an assigned number, as `10.0.0.1:100`. */
const RD_IP = [0, 1, 10, 0, 0, 1, 0, 100]
const ESI_ZERO = new Array(10).fill(0)
const ETHERNET_TAG_0 = [0, 0, 0, 0]
/** 0x007d21 >> 4 = 2002: the VNI, where VXLAN puts it (RFC 8365). */
const LABEL_2002 = [0x00, 0x7d, 0x21]
const MAC = [0x00, 0x0c, 0x29, 0xaa, 0xbb, 0xcc]

function nlri(routeType: number, value: number[]): number[] {
  return [routeType, value.length, ...value]
}

function read(bytes: number[]) {
  const warnings: string[] = []
  const routes = parseEvpnNlri(new BinaryReader(new Uint8Array(bytes), false), bytes.length, warnings)
  return { routes, warnings }
}

describe('Type 2 — MAC/IP Advertisement', () => {
  const macOnly = nlri(2, [...RD_IP, ...ESI_ZERO, ...ETHERNET_TAG_0, 48, ...MAC, 0, ...LABEL_2002])

  test('reads the MAC, the RD and the VNI', () => {
    const { routes, warnings } = read(macOnly)

    expect(warnings).toEqual([])
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      routeType: 2,
      routeTypeName: 'MAC/IP Advertisement',
      rd: '10.0.0.1:100',
      macAddress: '00:0c:29:aa:bb:cc',
      label: 2002,
      ethernetTag: 0,
    })
  })

  test('a zero ESI is called out as single-homed', () => {
    // The common case, and the one that rules multi-homing out of a problem.
    expect(read(macOnly).routes[0].esi).toBe('0 (single-homed)')
  })

  test('a real ESI is shown as it is', () => {
    const esi = [0x01, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x00, 0x00, 0x01]
    const { routes } = read(nlri(2, [...RD_IP, ...esi, ...ETHERNET_TAG_0, 48, ...MAC, 0, ...LABEL_2002]))
    expect(routes[0].esi).toBe('01:11:22:33:44:55:66:00:00:01')
  })

  test('an IPv4 address alongside the MAC is read', () => {
    const { routes } = read(
      nlri(2, [...RD_IP, ...ESI_ZERO, ...ETHERNET_TAG_0, 48, ...MAC, 32, 192, 168, 1, 10, ...LABEL_2002])
    )
    expect(routes[0].ipAddress).toBe('192.168.1.10')
  })

  test('an IPv6 address alongside the MAC is read', () => {
    const ipv6 = [0x20, 0x01, 0x0d, 0xb8, ...new Array(11).fill(0), 0x01]
    const { routes } = read(
      nlri(2, [...RD_IP, ...ESI_ZERO, ...ETHERNET_TAG_0, 48, ...MAC, 128, ...ipv6, ...LABEL_2002])
    )
    expect(routes[0].ipAddress).toBe('2001:db8::1')
  })

  test('a second label is read when the route carries an L3 VNI too', () => {
    const label3 = [0x00, 0xbb, 0x81] // >> 4 = 3000
    const { routes } = read(
      nlri(2, [...RD_IP, ...ESI_ZERO, ...ETHERNET_TAG_0, 48, ...MAC, 0, ...LABEL_2002, ...label3])
    )
    expect(routes[0].label).toBe(2002)
    expect(routes[0].label2).toBe(3000)
  })

  test('a non-zero Ethernet Tag is kept', () => {
    const { routes } = read(nlri(2, [...RD_IP, ...ESI_ZERO, 0, 0, 0, 42, 48, ...MAC, 0, ...LABEL_2002]))
    expect(routes[0].ethernetTag).toBe(42)
  })
})

describe('Type 3 — Inclusive Multicast Ethernet Tag', () => {
  const imet = nlri(3, [...RD_IP, ...ETHERNET_TAG_0, 32, 10, 0, 0, 1])

  test('names the router that originated it', () => {
    // Which VTEPs are in a VNI, the question behind missing BUM traffic.
    const { routes, warnings } = read(imet)

    expect(warnings).toEqual([])
    expect(routes[0]).toMatchObject({
      routeType: 3,
      routeTypeName: 'Inclusive Multicast Ethernet Tag',
      rd: '10.0.0.1:100',
      ethernetTag: 0,
      originatingRouterIp: '10.0.0.1',
    })
  })

  test('an IPv6 originating router is read', () => {
    const ipv6 = [0x20, 0x01, 0x0d, 0xb8, ...new Array(11).fill(0), 0x02]
    const { routes } = read(nlri(3, [...RD_IP, ...ETHERNET_TAG_0, 128, ...ipv6]))
    expect(routes[0].originatingRouterIp).toBe('2001:db8::2')
  })

  test('carries no MAC and no ESI', () => {
    const { routes } = read(imet)
    expect(routes[0].macAddress).toBeUndefined()
    expect(routes[0].esi).toBeUndefined()
  })
})

describe('the other route types', () => {
  test('Type 1 auto-discovery is identified with its ESI and VNI', () => {
    const { routes } = read(nlri(1, [...RD_IP, ...ESI_ZERO, ...ETHERNET_TAG_0, ...LABEL_2002]))
    expect(routes[0]).toMatchObject({ routeType: 1, rd: '10.0.0.1:100', label: 2002 })
  })

  test('Type 4 ethernet segment names its router', () => {
    const esi = [0x01, ...new Array(9).fill(0)]
    const { routes } = read(nlri(4, [...RD_IP, ...esi, 32, 10, 0, 0, 2]))
    expect(routes[0]).toMatchObject({ routeType: 4, originatingRouterIp: '10.0.0.2' })
  })

  test('Type 5 IP prefix reads its prefix and gateway', () => {
    const { routes } = read(
      nlri(5, [...RD_IP, ...ESI_ZERO, ...ETHERNET_TAG_0, 24, 10, 1, 1, 0, 10, 0, 0, 1, ...LABEL_2002])
    )
    expect(routes[0]).toMatchObject({
      routeType: 5,
      ipAddress: '10.1.1.0',
      ipPrefixLength: 24,
      gatewayIp: '10.0.0.1',
    })
  })

  test('an unknown route type still reports its RD rather than derailing', () => {
    const { routes } = read(nlri(9, [...RD_IP, 1, 2, 3, 4]))
    expect(routes[0].routeType).toBe(9)
    expect(routes[0].routeTypeName).toBe('Unknown type 9')
    expect(routes[0].rd).toBe('10.0.0.1:100')
  })
})

describe('reading a block of routes', () => {
  test('several routes in one attribute are all read', () => {
    const { routes } = read([
      ...nlri(2, [...RD_IP, ...ESI_ZERO, ...ETHERNET_TAG_0, 48, ...MAC, 0, ...LABEL_2002]),
      ...nlri(3, [...RD_IP, ...ETHERNET_TAG_0, 32, 10, 0, 0, 1]),
    ])
    expect(routes.map((r) => r.routeType)).toEqual([2, 3])
  })

  test('a route claiming more bytes than remain is reported, not guessed at', () => {
    const { routes, warnings } = read([2, 99, ...RD_IP])
    expect(routes).toEqual([])
    expect(warnings.join(' ')).toContain('only')
  })

  test('a body shorter than its type needs marks that route truncated', () => {
    // The declared length is honest, so the next route still starts correctly;
    // only this one is short.
    const { routes } = read([...nlri(2, [...RD_IP, 1, 2, 3]), ...nlri(3, [...RD_IP, ...ETHERNET_TAG_0, 32, 10, 0, 0, 1])])
    expect(routes[0].truncated).toBe(true)
    expect(routes[0].rd).toBe('10.0.0.1:100')
    expect(routes[1].routeType).toBe(3)
  })
})

describe('formatEvpnRoute', () => {
  test('a MAC/IP route leads with the MAC', () => {
    const { routes } = read(
      nlri(2, [...RD_IP, ...ESI_ZERO, ...ETHERNET_TAG_0, 48, ...MAC, 32, 192, 168, 1, 10, ...LABEL_2002])
    )
    expect(formatEvpnRoute(routes[0])).toBe('[2] 00:0c:29:aa:bb:cc 192.168.1.10 RD 10.0.0.1:100 VNI 2002')
  })

  test('a multicast route leads with the VTEP it came from', () => {
    const { routes } = read(nlri(3, [...RD_IP, ...ETHERNET_TAG_0, 32, 10, 0, 0, 1]))
    expect(formatEvpnRoute(routes[0])).toBe('[3] IMET 10.0.0.1 RD 10.0.0.1:100')
  })
})

describe('EVPN inside an UPDATE', () => {
  /** MP_REACH_NLRI for AFI 25 / SAFI 70 with an IPv4 next hop. */
  function evpnUpdate(routes: number[]) {
    const mpReach = [0, 25, 70, 4, 10, 0, 0, 1, 0, ...routes]
    const attrs = [0x40, 0x01, 0x01, 0x00, 0x80, 0x0e, mpReach.length, ...mpReach]
    return new Uint8Array([0, 0, (attrs.length >> 8) & 0xff, attrs.length & 0xff, ...attrs])
  }

  test('the address family, the next hop and the routes all arrive', () => {
    const warnings: string[] = []
    const msg = parseUpdateMessage(
      evpnUpdate(nlri(2, [...RD_IP, ...ESI_ZERO, ...ETHERNET_TAG_0, 48, ...MAC, 0, ...LABEL_2002])),
      warnings
    )

    const mp = msg.pathAttributes.find((a) => a.parsed?.type === 'MP_REACH_NLRI')
      ?.parsed as MpReachNlriAttribute
    expect(mp.afiName).toBe('L2VPN')
    expect(mp.safiName).toBe('EVPN')
    // The VTEP, which used to read as "(4 bytes)".
    expect(mp.nextHop).toBe('10.0.0.1')
    expect(mp.nlri[0].evpn?.macAddress).toBe('00:0c:29:aa:bb:cc')
    expect(warnings).toEqual([])
  })

  test('a withdrawn EVPN route is read the same way', () => {
    const mpUnreach = [0, 25, 70, ...nlri(3, [...RD_IP, ...ETHERNET_TAG_0, 32, 10, 0, 0, 1])]
    const attrs = [0x80, 0x0f, mpUnreach.length, ...mpUnreach]
    const msg = parseUpdateMessage(
      new Uint8Array([0, 0, (attrs.length >> 8) & 0xff, attrs.length & 0xff, ...attrs]),
      []
    )

    const mp = msg.pathAttributes.find((a) => a.parsed?.type === 'MP_UNREACH_NLRI')?.parsed
    expect(mp?.type).toBe('MP_UNREACH_NLRI')
    expect(mp?.type === 'MP_UNREACH_NLRI' && mp.withdrawnRoutes[0].evpn?.routeType).toBe(3)
  })
})
