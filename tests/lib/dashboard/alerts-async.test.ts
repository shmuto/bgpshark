/**
 * The workspace shows a large capture's findings as worked out in slices
 * (`alertsForAsync`, `scopedAlertsForAsync`), while every other test reads
 * `computeAlerts`. These pin the two to the same answer over the scenario
 * corpus, so a rule cannot behave differently depending on which way it ran.
 */
import { describe, test, expect } from 'bun:test'
import {
  alertsFor,
  alertsForAsync,
  computeAlerts,
  hasAlerts,
  hasScopedAlerts,
  scopeAlerts,
  scopedAlertsFor,
  scopedAlertsForAsync,
} from '../../../src/components/dashboard/alerts'
import { parseBgpFromPackets } from '../../../src/lib/bgp/parser'
import { peeringKey } from '../../../src/lib/bgp/peering'
import { parsePcap } from '../../../src/lib/pcap'
import { SCENARIOS } from '../../../testlab/scenarios'

async function load(id: string) {
  const scenario = SCENARIOS.find((entry) => entry.id === id)!
  const { bytes } = await scenario.build()
  const pcap = parsePcap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  return { packets: parseBgpFromPackets(pcap.packets).packets, allPackets: pcap.allPackets }
}

describe('findings worked out in slices', () => {
  for (const { id } of SCENARIOS) {
    test(`${id}: the same findings either way, for the capture and every session`, async () => {
      const { packets, allPackets } = await load(id)
      if (packets.length === 0) return
      for (const locale of ['en', 'ja'] as const) {
        const expected = computeAlerts(packets, allPackets, locale)
        const sliced = await alertsForAsync(packets, allPackets, locale)
        expect(sliced).toEqual(expected)

        for (const scope of new Set(packets.map((p) => peeringKey(p.srcIp, p.dstIp)))) {
          const sessionPackets = packets.filter((p) => peeringKey(p.srcIp, p.dstIp) === scope)
          const scoped = await scopedAlertsForAsync(sliced!, packets, scope, locale, sessionPackets)
          expect(scoped).toEqual(scopeAlerts(expected, packets, scope, locale, sessionPackets))
        }
      }
    })
  }

  test('the cache answers synchronously once the sliced run has finished', async () => {
    const { packets, allPackets } = await load('s10-churn')
    expect(hasAlerts(packets, allPackets, 'en')).toBe(false)
    const sliced = await alertsForAsync(packets, allPackets, 'en')
    expect(hasAlerts(packets, allPackets, 'en')).toBe(true)
    expect(alertsFor(packets, allPackets, 'en')).toBe(sliced!)
    // Another language is another set of findings.
    expect(hasAlerts(packets, allPackets, 'ja')).toBe(false)

    const scope = peeringKey(packets[0].srcIp, packets[0].dstIp)
    const sessionPackets = packets.filter((p) => peeringKey(p.srcIp, p.dstIp) === scope)
    expect(hasScopedAlerts(sliced!, packets, scope, 'en', sessionPackets)).toBe(false)
    const scoped = await scopedAlertsForAsync(sliced!, packets, scope, 'en', sessionPackets)
    expect(scopedAlertsFor(sliced!, packets, scope, 'en', sessionPackets)).toBe(scoped!)
    expect(hasScopedAlerts(sliced!, packets, null, 'en', sessionPackets)).toBe(true)
  })
})
