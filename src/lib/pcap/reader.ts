/**
 * Binary reader utility for parsing pcap and protocol data.
 * Wraps DataView with convenient methods and position tracking.
 */
export class BinaryReader {
  private view: DataView
  private _offset: number
  private _littleEndian: boolean

  constructor(buffer: ArrayBuffer | Uint8Array, littleEndian = true) {
    if (buffer instanceof Uint8Array) {
      this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } else {
      this.view = new DataView(buffer)
    }
    this._offset = 0
    this._littleEndian = littleEndian
  }

  /** Get current read position */
  get offset(): number {
    return this._offset
  }

  /** Get total buffer length */
  get length(): number {
    return this.view.byteLength
  }

  /** Get remaining bytes from current position */
  remaining(): number {
    return this.view.byteLength - this._offset
  }

  /** Check if there are enough bytes to read */
  hasBytes(count: number): boolean {
    return this.remaining() >= count
  }

  /** Set endianness for multi-byte reads */
  setLittleEndian(value: boolean): void {
    this._littleEndian = value
  }

  /** Move to absolute position */
  seek(offset: number): void {
    if (offset < 0 || offset > this.view.byteLength) {
      throw new RangeError(`Seek offset ${offset} out of bounds (0-${this.view.byteLength})`)
    }
    this._offset = offset
  }

  /** Skip bytes from current position */
  skip(count: number): void {
    if (this._offset + count > this.view.byteLength) {
      throw new RangeError(`Skip would exceed buffer bounds`)
    }
    this._offset += count
  }

  /** Read unsigned 8-bit integer */
  readUint8(): number {
    if (!this.hasBytes(1)) {
      throw new RangeError('Buffer underflow: cannot read Uint8')
    }
    const value = this.view.getUint8(this._offset)
    this._offset += 1
    return value
  }

  /** Read unsigned 16-bit integer */
  readUint16(): number {
    if (!this.hasBytes(2)) {
      throw new RangeError('Buffer underflow: cannot read Uint16')
    }
    const value = this.view.getUint16(this._offset, this._littleEndian)
    this._offset += 2
    return value
  }

  /** Read unsigned 32-bit integer */
  readUint32(): number {
    if (!this.hasBytes(4)) {
      throw new RangeError('Buffer underflow: cannot read Uint32')
    }
    const value = this.view.getUint32(this._offset, this._littleEndian)
    this._offset += 4
    return value
  }

  /** Read signed 32-bit integer */
  readInt32(): number {
    if (!this.hasBytes(4)) {
      throw new RangeError('Buffer underflow: cannot read Int32')
    }
    const value = this.view.getInt32(this._offset, this._littleEndian)
    this._offset += 4
    return value
  }

  /** Read raw bytes */
  readBytes(length: number): Uint8Array {
    if (!this.hasBytes(length)) {
      throw new RangeError(`Buffer underflow: cannot read ${length} bytes`)
    }
    const start = this.view.byteOffset + this._offset
    const result = new Uint8Array(this.view.buffer, start, length)
    this._offset += length
    return result
  }

  /** Read IPv4 address as dotted-decimal string */
  readIpv4Address(): string {
    const bytes = this.readBytes(4)
    return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`
  }

  /** Read IPv6 address as hex string */
  readIpv6Address(): string {
    const bytes = this.readBytes(16)
    const groups: string[] = []
    for (let i = 0; i < 16; i += 2) {
      const value = (bytes[i] << 8) | bytes[i + 1]
      groups.push(value.toString(16))
    }
    return groups.join(':')
  }

  /** Check if there are more bytes to read */
  hasMore(): boolean {
    return this._offset < this.view.byteLength
  }

  /** Get current position */
  getPosition(): number {
    return this._offset
  }

  /** Peek at bytes without advancing position */
  peek(length: number): Uint8Array {
    if (!this.hasBytes(length)) {
      throw new RangeError(`Buffer underflow: cannot peek ${length} bytes`)
    }
    const start = this.view.byteOffset + this._offset
    return new Uint8Array(this.view.buffer, start, length)
  }

  /** Peek Uint16 at specific offset from current position */
  peekUint16At(relativeOffset: number): number {
    const absoluteOffset = this._offset + relativeOffset
    if (absoluteOffset + 2 > this.view.byteLength) {
      throw new RangeError('Peek would exceed buffer bounds')
    }
    return this.view.getUint16(absoluteOffset, this._littleEndian)
  }

  /** Create a sub-reader for a portion of the buffer */
  subReader(length: number): BinaryReader {
    const bytes = this.readBytes(length)
    return new BinaryReader(bytes, this._littleEndian)
  }
}
