import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { computeAlerts, scopeAlerts } from '../../../src/components/dashboard/alerts'
import { groupFindings } from '../../../src/components/dashboard/findings'
import { parsePcapng } from '../../../src/lib/pcap'
import { parseBgpFromPackets } from '../../../src/lib/bgp'

/** The bundled sample: one hard reset on a router with three sessions. */
function sample() {
  const buf = readFileSync(join(import.meta.dir, '../../../public/sample.pcapng'))
  const bytes = new Uint8Array(buf.byteLength)
  bytes.set(buf)
  const pcap = parsePcapng(bytes.buffer as ArrayBuffer)
  const { packets } = parseBgpFromPackets(pcap.packets)
  return { packets, alerts: computeAlerts(packets, pcap.allPackets) }
}

function sampleAlerts() {
  return sample().alerts
}

describe('groupFindings', () => {
  test('folds one event across three sessions into one row per kind', () => {
    const alerts = sampleAlerts()
    expect(alerts.length).toBe(16)

    const groups = groupFindings(alerts)
    expect(groups.map((g) => [g.key, g.severity, g.alerts.length])).toEqual([
      ['notification-6-9', 'critical', 3],
      ['route-flap', 'warning', 4],
      ['session-flap', 'warning', 3],
      ['notification-6-7', 'info', 6],
    ])
    expect(groups[0].peerings).toHaveLength(3)
  })

  test('different NOTIFICATION codes stay apart', () => {
    const groups = groupFindings(sampleAlerts())
    expect(groups.filter((g) => g.rule === 'notification')).toHaveLength(2)
  })
})

describe('occurrences', () => {
  test('a group counts what its ×N badges add up to, not its rows', () => {
    const groups = groupFindings(sampleAlerts())
    // Four route-flap rows stand for six flaps; the heading once said 16
    // findings above badges that summed to 18.
    expect(groups.map((g) => [g.key, g.alerts.length, g.occurrences])).toEqual([
      ['notification-6-9', 3, 3],
      ['route-flap', 4, 6],
      ['session-flap', 3, 3],
      ['notification-6-7', 6, 6],
    ])
    expect(groups.reduce((sum, g) => sum + g.occurrences, 0)).toBe(18)
  })
})

describe('scopeAlerts', () => {
  const SESSION = '10.0.13.1|10.0.13.3'

  test('keeps the session’s own findings and drops the others’', () => {
    const { packets, alerts } = sample()
    const scoped = scopeAlerts(alerts, packets, SESSION)
    expect(scoped.filter((a) => a.peering).every((a) => a.peering === SESSION)).toBe(true)
    expect(groupFindings(scoped).map((g) => [g.key, g.alerts.length, g.occurrences])).toEqual([
      ['notification-6-9', 1, 1],
      ['route-flap', 2, 2],
      ['session-flap', 1, 1],
      ['notification-6-7', 2, 2],
    ])
  })

  test('counts route flaps over the session alone', () => {
    // Over the capture 1.1.1.1/32 flapped twice, once on each of two
    // sessions; inside one of them it flapped once.
    const { packets, alerts } = sample()
    const whole = alerts.find((a) => a.id === 'route-flap-1.1.1.1/32')!
    expect(whole.count).toBe(2)
    const scoped = scopeAlerts(alerts, packets, SESSION).find((a) => a.id === 'route-flap-1.1.1.1/32')!
    expect(scoped.count).toBe(1)
    expect(scopeAlerts(alerts, packets, '1.1.1.1|2.2.2.2').some((a) => a.id === 'route-flap-1.1.1.1/32')).toBe(false)
  })

  test('a recomputed finding still opens a packet of that session, in the capture’s numbering', () => {
    const { packets, alerts } = sample()
    for (const alert of scopeAlerts(alerts, packets, SESSION)) {
      if (alert.packetIndex === undefined) continue
      const packet = packets[alert.packetIndex]
      expect([packet.srcIp, packet.dstIp].sort().join('|')).toBe(SESSION)
    }
  })

  test('no scope is everything', () => {
    const { packets, alerts } = sample()
    expect(scopeAlerts(alerts, packets, null)).toBe(alerts)
  })
})
