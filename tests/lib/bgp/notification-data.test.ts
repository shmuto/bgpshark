import { describe, test, expect } from 'bun:test'
import { decodeNotificationData } from '../../../src/lib/bgp/notification-data'

/**
 * The data field of a NOTIFICATION, decoded per error code.
 *
 * Half of these assert that decoding *happens*; the other half assert that it
 * declines. The second half is the important one — a NOTIFICATION arrives
 * because something already went wrong, so the field is exactly where a
 * confident misreading is most likely and least welcome.
 */
describe('decoding a NOTIFICATION data field', () => {
  test('an empty field decodes to nothing', () => {
    expect(decodeNotificationData(3, 2, new Uint8Array())).toBeUndefined()
  })

  test('an error with no defined data field is left alone', () => {
    // Hold Timer Expired (4) carries nothing meaningful even when bytes arrive.
    expect(decodeNotificationData(4, 0, new Uint8Array([1, 2, 3]))).toBeUndefined()
  })

  describe('Message Header Error', () => {
    test('Bad Message Length gives the length that was rejected', () => {
      const decoded = decodeNotificationData(1, 2, new Uint8Array([0x10, 0x01]))
      expect(decoded).toEqual({ kind: 'length', length: 4097 })
    })

    test('Bad Message Type names the type when it is one BGP defines', () => {
      expect(decodeNotificationData(1, 3, new Uint8Array([2]))).toEqual({
        kind: 'messageType',
        typeCode: 2,
        typeName: 'UPDATE',
      })
    })

    test('an unknown message type is reported as unknown rather than guessed', () => {
      expect(decodeNotificationData(1, 3, new Uint8Array([99]))).toEqual({
        kind: 'messageType',
        typeCode: 99,
        typeName: 'Unknown (99)',
      })
    })
  })

  describe('OPEN Message Error', () => {
    test('Unsupported Version Number gives the version the peer can do', () => {
      expect(decodeNotificationData(2, 1, new Uint8Array([0x00, 0x04]))).toEqual({
        kind: 'version',
        version: 4,
      })
    })

    test('Bad Peer AS reads a 2-byte AS', () => {
      expect(decodeNotificationData(2, 2, new Uint8Array([0xfd, 0xe9]))).toEqual({
        kind: 'as',
        asNumber: 65001,
      })
    })

    test('Bad Peer AS reads a 4-byte AS', () => {
      expect(decodeNotificationData(2, 2, new Uint8Array([0x00, 0x00, 0xfd, 0xe9]))).toEqual({
        kind: 'as',
        asNumber: 65001,
      })
    })

    test('a Bad Peer AS field of some other width is not guessed at', () => {
      // Three bytes is neither width. Reading two of them and calling it an AS
      // number would produce a plausible, wrong answer.
      expect(decodeNotificationData(2, 2, new Uint8Array([1, 2, 3]))).toBeUndefined()
    })

    test('Unsupported Capability lists the capabilities by name', () => {
      // Two capability triples: 4-byte AS (65, len 4) and ADD-PATH (69, len 4).
      const data = new Uint8Array([65, 4, 0, 1, 0, 1, 69, 4, 0, 1, 1, 1])
      const decoded = decodeNotificationData(2, 7, data)

      expect(decoded).toEqual({
        kind: 'capabilities',
        capabilities: [
          { code: 65, name: '4-byte AS Number', length: 4 },
          { code: 69, name: 'ADD-PATH', length: 4 },
        ],
      })
    })

    test('a capability whose length runs past the field stops the list', () => {
      // The first triple is complete, the second claims more than is there.
      const data = new Uint8Array([2, 0, 65, 40])
      const decoded = decodeNotificationData(2, 7, data)

      expect(decoded).toEqual({
        kind: 'capabilities',
        capabilities: [{ code: 2, name: 'Route Refresh', length: 0 }],
      })
    })
  })

  describe('UPDATE Message Error', () => {
    // Flags 0x40 is transitive with optional clear, type 199, length 4 — an
    // unknown well-known attribute, which is what error 3/2 is about. These are
    // the same bytes `testlab/scenarios.ts` puts in s6-malformed-update.
    const offending = new Uint8Array([0x40, 0xc7, 0x04, 0xde, 0xad, 0xbe, 0xef])

    test('the offending attribute comes back with its flags', () => {
      const decoded = decodeNotificationData(3, 2, offending)

      expect(decoded?.kind).toBe('attribute')
      if (decoded?.kind !== 'attribute') return
      expect(decoded.attribute.typeCode).toBe(199)
      expect(decoded.attribute.typeName).toBe('UNKNOWN(199)')
      expect(decoded.attribute.length).toBe(4)
      // The clear optional bit is the fault, so it has to survive the decode.
      expect(decoded.attribute.flags.optional).toBe(false)
      expect(decoded.attribute.flags.transitive).toBe(true)
    })

    test('a well-known attribute decodes its value too', () => {
      // ORIGIN (type 1), length 1, value 0 = IGP.
      const decoded = decodeNotificationData(3, 4, new Uint8Array([0x40, 0x01, 0x01, 0x00]))

      expect(decoded?.kind).toBe('attribute')
      if (decoded?.kind !== 'attribute') return
      expect(decoded.attribute.typeName).toBe('ORIGIN')
      expect(decoded.attribute.parsed).toMatchObject({ type: 'ORIGIN', value: 'IGP' })
    })

    test('Malformed Attribute List is about the list, so nothing single is decoded', () => {
      expect(decodeNotificationData(3, 1, offending)).toBeUndefined()
    })

    test('an attribute whose length runs past the field is refused', () => {
      // Claims 40 bytes of value and carries one. A hex dump is the honest
      // answer; a truncated attribute would look like a decoded fact.
      expect(decodeNotificationData(3, 2, new Uint8Array([0x40, 0xc7, 0x28, 0x01]))).toBeUndefined()
    })

    test('a field too short to be an attribute at all is refused', () => {
      expect(decodeNotificationData(3, 2, new Uint8Array([0x40, 0xc7]))).toBeUndefined()
    })
  })

  describe('Cease', () => {
    const shutdown = (text: string, subcode = 2) => {
      const bytes = new TextEncoder().encode(text)
      return decodeNotificationData(6, subcode, new Uint8Array([bytes.length, ...bytes]))
    }

    test('an administrative shutdown carries its reason in words', () => {
      expect(shutdown('maintenance window CHG0042')).toEqual({
        kind: 'shutdownMessage',
        message: 'maintenance window CHG0042',
      })
    })

    test('an administrative reset carries one too', () => {
      expect(shutdown('policy change', 4)).toEqual({
        kind: 'shutdownMessage',
        message: 'policy change',
      })
    })

    test('other Cease subcodes are left as bytes', () => {
      // Peer De-configured (3) defines no shutdown communication.
      expect(shutdown('ignored', 3)).toBeUndefined()
    })

    test('a length that does not match the bytes present is refused', () => {
      expect(decodeNotificationData(6, 2, new Uint8Array([40, 0x68, 0x69]))).toBeUndefined()
    })

    test('an empty message is not shown as an empty box', () => {
      expect(decodeNotificationData(6, 2, new Uint8Array([0]))).toBeUndefined()
    })
  })
})
