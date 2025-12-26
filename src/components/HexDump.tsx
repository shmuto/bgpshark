interface HexDumpProps {
  data: Uint8Array
  bytesPerLine?: number
}

export function HexDump({ data, bytesPerLine = 16 }: HexDumpProps) {
  const lines: string[] = []

  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const chunk = data.slice(offset, offset + bytesPerLine)

    // Offset
    const offsetStr = offset.toString(16).padStart(4, '0')

    // Hex bytes
    const hexParts: string[] = []
    for (let i = 0; i < bytesPerLine; i++) {
      if (i < chunk.length) {
        hexParts.push(chunk[i].toString(16).padStart(2, '0'))
      } else {
        hexParts.push('  ')
      }
    }
    // Split into two groups of 8
    const hexStr =
      hexParts.slice(0, 8).join(' ') + '  ' + hexParts.slice(8).join(' ')

    // ASCII representation
    const asciiStr = Array.from(chunk)
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'))
      .join('')
      .padEnd(bytesPerLine, ' ')

    lines.push(`${offsetStr}: ${hexStr}  |${asciiStr}|`)
  }

  return (
    <pre className="bg-gray-900 text-gray-100 text-xs font-mono p-3 rounded-lg overflow-x-auto">
      {lines.join('\n')}
    </pre>
  )
}
