import { describe, test, expect } from 'bun:test'
import { BinaryReader } from '../../../src/lib/pcap/reader'

describe('BinaryReader', () => {
  describe('constructor', () => {
    test('creates reader from ArrayBuffer', () => {
      const buffer = new ArrayBuffer(10)
      const reader = new BinaryReader(buffer)
      expect(reader.length).toBe(10)
      expect(reader.offset).toBe(0)
    })

    test('creates reader from Uint8Array', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const reader = new BinaryReader(data)
      expect(reader.length).toBe(5)
    })
  })

  describe('readUint8', () => {
    test('reads single byte', () => {
      const data = new Uint8Array([0x42, 0xff])
      const reader = new BinaryReader(data)
      expect(reader.readUint8()).toBe(0x42)
      expect(reader.readUint8()).toBe(0xff)
      expect(reader.offset).toBe(2)
    })

    test('throws on buffer underflow', () => {
      const data = new Uint8Array([0x42])
      const reader = new BinaryReader(data)
      reader.readUint8()
      expect(() => reader.readUint8()).toThrow('Buffer underflow')
    })
  })

  describe('readUint16', () => {
    test('reads little-endian by default', () => {
      const data = new Uint8Array([0x34, 0x12])
      const reader = new BinaryReader(data, true)
      expect(reader.readUint16()).toBe(0x1234)
    })

    test('reads big-endian when configured', () => {
      const data = new Uint8Array([0x12, 0x34])
      const reader = new BinaryReader(data, false)
      expect(reader.readUint16()).toBe(0x1234)
    })
  })

  describe('readUint32', () => {
    test('reads little-endian by default', () => {
      const data = new Uint8Array([0x78, 0x56, 0x34, 0x12])
      const reader = new BinaryReader(data, true)
      expect(reader.readUint32()).toBe(0x12345678)
    })

    test('reads big-endian when configured', () => {
      const data = new Uint8Array([0x12, 0x34, 0x56, 0x78])
      const reader = new BinaryReader(data, false)
      expect(reader.readUint32()).toBe(0x12345678)
    })
  })

  describe('readBytes', () => {
    test('reads specified number of bytes', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const reader = new BinaryReader(data)
      const bytes = reader.readBytes(3)
      expect(Array.from(bytes)).toEqual([1, 2, 3])
      expect(reader.offset).toBe(3)
    })

    test('throws on buffer underflow', () => {
      const data = new Uint8Array([1, 2, 3])
      const reader = new BinaryReader(data)
      expect(() => reader.readBytes(5)).toThrow('Buffer underflow')
    })
  })

  describe('readIpv4Address', () => {
    test('reads IPv4 address as dotted-decimal string', () => {
      const data = new Uint8Array([192, 168, 1, 1])
      const reader = new BinaryReader(data)
      expect(reader.readIpv4Address()).toBe('192.168.1.1')
    })

    test('reads 0.0.0.0', () => {
      const data = new Uint8Array([0, 0, 0, 0])
      const reader = new BinaryReader(data)
      expect(reader.readIpv4Address()).toBe('0.0.0.0')
    })

    test('reads 255.255.255.255', () => {
      const data = new Uint8Array([255, 255, 255, 255])
      const reader = new BinaryReader(data)
      expect(reader.readIpv4Address()).toBe('255.255.255.255')
    })
  })

  describe('position management', () => {
    test('seek moves to absolute position', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const reader = new BinaryReader(data)
      reader.seek(3)
      expect(reader.offset).toBe(3)
      expect(reader.readUint8()).toBe(4)
    })

    test('seek throws on out of bounds', () => {
      const data = new Uint8Array([1, 2, 3])
      const reader = new BinaryReader(data)
      expect(() => reader.seek(10)).toThrow('out of bounds')
      expect(() => reader.seek(-1)).toThrow('out of bounds')
    })

    test('skip advances position', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const reader = new BinaryReader(data)
      reader.skip(2)
      expect(reader.offset).toBe(2)
      expect(reader.readUint8()).toBe(3)
    })

    test('remaining returns correct count', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const reader = new BinaryReader(data)
      expect(reader.remaining()).toBe(5)
      reader.skip(2)
      expect(reader.remaining()).toBe(3)
    })

    test('hasBytes checks availability', () => {
      const data = new Uint8Array([1, 2, 3])
      const reader = new BinaryReader(data)
      expect(reader.hasBytes(3)).toBe(true)
      expect(reader.hasBytes(4)).toBe(false)
      reader.skip(1)
      expect(reader.hasBytes(3)).toBe(false)
      expect(reader.hasBytes(2)).toBe(true)
    })
  })

  describe('endianness', () => {
    test('setLittleEndian changes byte order', () => {
      const data = new Uint8Array([0x12, 0x34, 0x12, 0x34])
      const reader = new BinaryReader(data, true)

      reader.setLittleEndian(false)
      expect(reader.readUint16()).toBe(0x1234)

      reader.setLittleEndian(true)
      expect(reader.readUint16()).toBe(0x3412)
    })
  })

  describe('peek', () => {
    test('peek returns bytes without advancing position', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const reader = new BinaryReader(data)
      const peeked = reader.peek(3)
      expect(Array.from(peeked)).toEqual([1, 2, 3])
      expect(reader.offset).toBe(0)
    })

    test('peekUint16At reads at relative offset', () => {
      const data = new Uint8Array([0x00, 0x00, 0x12, 0x34])
      const reader = new BinaryReader(data, false)
      expect(reader.peekUint16At(2)).toBe(0x1234)
      expect(reader.offset).toBe(0)
    })
  })

  describe('subReader', () => {
    test('creates sub-reader with portion of buffer', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const reader = new BinaryReader(data)
      reader.skip(1)
      const sub = reader.subReader(3)
      expect(sub.length).toBe(3)
      expect(sub.readUint8()).toBe(2)
      expect(reader.offset).toBe(4)
    })
  })
})
