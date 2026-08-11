/**
 * Every built frame is checked the way a receiving stack checks it.
 *
 * A one's-complement checksum has the property that summing a header which
 * already contains its checksum comes out to zero. So rather than recomputing
 * the checksum here — which would just be the encoder's arithmetic written
 * twice — these tests run the verification a real IP stack runs. A frame that
 * passes will be accepted by Wireshark, tcpdump and a router; BGPShark's own
 * parser never looks at these fields and so would never have told us.
 */
import { describe, expect, test } from 'bun:test'
import { buildScenario } from '../../../src/lib/build/scenario'
import { PRESETS } from '../../../src/lib/build/presets'
import { ByteWriter, internetChecksum } from '../../../src/lib/build/bytes'
import { EtherType, IpProtocol, LinkLayerType } from '../../../src/lib/pcap/types'

const IPV4_MIN_HEADER = 20
const IPV6_HEADER = 40

interface Layers {
  family: 4 | 6
  srcIp: Uint8Array
  dstIp: Uint8Array
  ipHeader: Uint8Array
  tcpSegment: Uint8Array
}

/** Walk a built Ethernet frame down to the pieces the checksums cover. */
function layersOf(frame: Uint8Array): Layers {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)

  let offset = 12
  let etherType = view.getUint16(offset)
  offset += 2
  while (etherType === EtherType.VLAN || etherType === EtherType.QINQ) {
    etherType = view.getUint16(offset + 2)
    offset += 4
  }

  if (etherType === EtherType.IPV4) {
    const headerLength = (frame[offset] & 0x0f) * 4
    const totalLength = view.getUint16(offset + 2)
    return {
      family: 4,
      srcIp: frame.subarray(offset + 12, offset + 16),
      dstIp: frame.subarray(offset + 16, offset + 20),
      ipHeader: frame.subarray(offset, offset + headerLength),
      tcpSegment: frame.subarray(offset + headerLength, offset + totalLength),
    }
  }

  const payloadLength = view.getUint16(offset + 4)
  return {
    family: 6,
    srcIp: frame.subarray(offset + 8, offset + 24),
    dstIp: frame.subarray(offset + 24, offset + 40),
    ipHeader: frame.subarray(offset, offset + IPV6_HEADER),
    tcpSegment: frame.subarray(offset + IPV6_HEADER, offset + IPV6_HEADER + payloadLength),
  }
}

function pseudoHeader(layers: Layers): Uint8Array {
  const writer = new ByteWriter()
  writer.bytes(layers.srcIp).bytes(layers.dstIp)

  if (layers.family === 4) {
    writer.u8(0).u8(IpProtocol.TCP).u16(layers.tcpSegment.length)
  } else {
    writer.u32(layers.tcpSegment.length).zeros(3).u8(IpProtocol.TCP)
  }

  return writer.toBytes()
}

describe.each(PRESETS.map((preset) => [preset.id, preset] as const))(
  'the %s scenario',
  (_id, preset) => {
    const built = buildScenario(preset.build())

    test('writes IP headers that verify', () => {
      for (const [index, frame] of built.frames.entries()) {
        const layers = layersOf(frame.frameBytes)

        // IPv6 has no header checksum of its own, so there is nothing to verify
        // there — only the TCP checksum below covers those addresses.
        if (layers.family === 4) {
          expect({ frame: index + 1, checksum: internetChecksum(layers.ipHeader) }).toEqual({
            frame: index + 1,
            checksum: 0,
          })
          expect(layers.ipHeader.length).toBeGreaterThanOrEqual(IPV4_MIN_HEADER)
        }
      }
    })

    test('writes TCP checksums that verify over the pseudo-header', () => {
      for (const [index, frame] of built.frames.entries()) {
        const layers = layersOf(frame.frameBytes)
        const checksum = internetChecksum(pseudoHeader(layers), layers.tcpSegment)

        expect({ frame: index + 1, checksum }).toEqual({ frame: index + 1, checksum: 0 })
      }
    })

    test('pads short frames to Ethernet’s minimum', () => {
      for (const frame of built.frames) {
        expect(frame.frameBytes.length).toBeGreaterThanOrEqual(60)
        expect(frame.originalLength).toBe(frame.frameBytes.length)
      }
    })
  }
)

describe('other link layers and encapsulations', () => {
  const base = PRESETS[0].build()

  test('an SLL capture still checksums correctly', () => {
    const built = buildScenario({ ...base, linkType: LinkLayerType.SLL })

    for (const frame of built.frames) {
      // The SLL header is 16 bytes to Ethernet's 14, so the same walk would land
      // two bytes short; shift the frame to reuse it.
      const shifted = new Uint8Array(frame.frameBytes.length - 2)
      shifted.set(frame.frameBytes.subarray(2))

      const layers = layersOf(shifted)
      expect(internetChecksum(layers.ipHeader)).toBe(0)
      expect(internetChecksum(pseudoHeader(layers), layers.tcpSegment)).toBe(0)
    }
  })

  test('VLAN tags do not disturb the checksums underneath them', () => {
    const built = buildScenario({ ...base, vlanIds: [100, 200] })

    for (const frame of built.frames) {
      const layers = layersOf(frame.frameBytes)
      expect(internetChecksum(layers.ipHeader)).toBe(0)
      expect(internetChecksum(pseudoHeader(layers), layers.tcpSegment)).toBe(0)
    }
  })

  test('an IPv6 session checksums over the v6 pseudo-header', () => {
    const built = buildScenario(PRESETS.find((p) => p.id === 'ipv6')!.build())

    for (const frame of built.frames) {
      const layers = layersOf(frame.frameBytes)
      expect(layers.family).toBe(6)
      expect(internetChecksum(pseudoHeader(layers), layers.tcpSegment)).toBe(0)
    }
  })
})
