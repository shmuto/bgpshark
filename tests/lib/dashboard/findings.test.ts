import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { computeAlerts } from '../../../src/components/dashboard/alerts'
import { groupFindings, alertsForPeering } from '../../../src/components/dashboard/findings'
import { parsePcapng } from '../../../src/lib/pcap'
import { parseBgpFromPackets } from '../../../src/lib/bgp'

/** The bundled sample: one hard reset on a router with three sessions. */
function sampleAlerts() {
  const buf = readFileSync(join(import.meta.dir, '../../../public/sample.pcapng'))
  const bytes = new Uint8Array(buf.byteLength)
  bytes.set(buf)
  const pcap = parsePcapng(bytes.buffer as ArrayBuffer)
  const { packets } = parseBgpFromPackets(pcap.packets)
  return computeAlerts(packets, pcap.allPackets)
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

describe('alertsForPeering', () => {
  test('keeps the session’s own findings and those with no session', () => {
    const alerts = sampleAlerts()
    const scoped = alertsForPeering(alerts, '1.1.1.1|2.2.2.2')
    expect(scoped.every((a) => !a.peering || a.peering === '1.1.1.1|2.2.2.2')).toBe(true)
    // 1 hard reset, 2 collisions, 1 session flap, 4 route flaps
    expect(scoped).toHaveLength(8)
  })

  test('no scope is everything', () => {
    const alerts = sampleAlerts()
    expect(alertsForPeering(alerts, null)).toBe(alerts)
  })
})
