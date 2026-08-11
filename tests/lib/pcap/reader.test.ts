import { describe, test, expect } from 'bun:test'
import { BinaryReader } from '../../../src/lib/pcap/reader'

/**
 * What is worth pinning here is the reader's own behaviour at the edges, not
 * that `DataView` reads integers. Every parser in the suite drives this class
 * on real captures, so a broken `readUint16` does not slip through quietly —
 * it takes those tests down with it. What those tests would *not* diagnose is
 * a bound checked one byte too late, so that is what is covered.
 */
describe('BinaryReader', () => {
  test('reads past the end rather than returning garbage', () => {
    // The parsers depend on this: a truncated capture has to raise, because
    // the alternative is decoding whatever follows in memory as a route.
    const reader = new BinaryReader(new Uint8Array([0x42]))
    expect(reader.readUint8()).toBe(0x42)
    expect(() => reader.readUint8()).toThrow('Buffer underflow')
    expect(() => new BinaryReader(new Uint8Array([1, 2, 3])).readBytes(5)).toThrow(
      'Buffer underflow'
    )
  })

  test('seeking outside the buffer throws at both ends', () => {
    const reader = new BinaryReader(new Uint8Array([1, 2, 3]))
    expect(() => reader.seek(10)).toThrow('out of bounds')
    expect(() => reader.seek(-1)).toThrow('out of bounds')
  })

  test('remaining and hasBytes agree with the position', () => {
    // Both are read as "is there enough left for this field", so an off-by-one
    // here is a field read from past the end.
    const reader = new BinaryReader(new Uint8Array([1, 2, 3, 4, 5]))
    expect(reader.remaining()).toBe(5)
    expect(reader.hasBytes(5)).toBe(true)
    expect(reader.hasBytes(6)).toBe(false)

    reader.skip(3)
    expect(reader.remaining()).toBe(2)
    expect(reader.hasBytes(2)).toBe(true)
    expect(reader.hasBytes(3)).toBe(false)
  })

  test('endianness can change part-way through', () => {
    // pcap takes its byte order from the file header, so this is decided after
    // the reader already exists.
    const reader = new BinaryReader(new Uint8Array([0x12, 0x34, 0x12, 0x34]), true)
    reader.setLittleEndian(false)
    expect(reader.readUint16()).toBe(0x1234)
    reader.setLittleEndian(true)
    expect(reader.readUint16()).toBe(0x3412)
  })

  test('peeking does not move the position', () => {
    const reader = new BinaryReader(new Uint8Array([0x01, 0x02, 0x12, 0x34]), false)
    expect(Array.from(reader.peek(2))).toEqual([0x01, 0x02])
    expect(reader.peekUint16At(2)).toBe(0x1234)
    expect(reader.offset).toBe(0)
  })

  test('a sub-reader is bounded, and the parent moves past it', () => {
    // This is how an attribute is read inside its own declared length: what the
    // sub-reader does cannot run into the next attribute, and the parent
    // resumes at the right place whether or not the body was read in full.
    const reader = new BinaryReader(new Uint8Array([1, 2, 3, 4, 5]))
    reader.skip(1)
    const sub = reader.subReader(3)
    expect(sub.length).toBe(3)
    expect(sub.readUint8()).toBe(2)
    expect(reader.offset).toBe(4)
  })

  test('an IPv4 address reads as dotted decimal', () => {
    const reader = new BinaryReader(new Uint8Array([192, 168, 1, 1]))
    expect(reader.readIpv4Address()).toBe('192.168.1.1')
  })
})
