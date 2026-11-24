/**
 * Turn a described capture into a pcap file, and show what the app will read
 * out of it.
 *
 * Checking a fix against a particular capture used to mean a throwaway script:
 * import the builder, describe the session, call `buildScenario`, write the
 * bytes somewhere, open them in the app to see whether they came out as meant.
 * Only the description was ever specific to the case. This is everything else,
 * so the throwaway part shrinks to a file that exports what it wants built:
 *
 *   bun run pcap --new /tmp/x.ts         # start a capture file
 *   bun run pcap /tmp/x.ts --dump        # build it and list what was decoded
 *   bun run pcap established flap        # presets, merged into one file
 *   bun run pcap --list                  # preset ids
 *
 * The listing is read back through the app's own parsers, not the builder's
 * idea of what it wrote, so a capture that does not decode as intended shows
 * up here rather than after it has been loaded into the browser.
 *
 * A capture file's default export may be any of:
 *
 * - a `Scenario`, or an array of them (built and merged in time order)
 * - a `BuiltCapture`, e.g. from `mergeCaptures` or `keepSide`
 * - raw pcap bytes, for captures the builder cannot express
 * - a function, optionally async, returning any of the above. It is passed the
 *   builder module, so a file outside the repository needs no import paths.
 *
 * A `.json` file holding a `Scenario` or an array of them works too.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as build from '../src/lib/build'
import { PRESETS, buildScenario, mergeCaptures, presetById, type BuiltCapture } from '../src/lib/build'
import { Afi, Safi } from '../src/lib/bgp/constants'
import { parseBgpFromPackets } from '../src/lib/bgp/parser'
import type { BgpMessage } from '../src/lib/bgp/types'
import { isPcapng, parsePcapng } from '../src/lib/pcap/pcapng-parser'
import { parsePcap } from '../src/lib/pcap/parser'
import type { PcapParseResult, TcpFlags } from '../src/lib/pcap/types'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Gitignored, like `testlab/scenarios/`: the description is what is worth keeping. */
const DEFAULT_OUT_DIR = join(REPO_ROOT, 'testlab', 'out')

/** What a capture file is handed when its default export is a function. */
export const BUILD_KIT = { ...build, Afi, Safi }

const USAGE = `Usage:
  bun run pcap <source>... [-o <out.pcap>] [--dump]
  bun run pcap --new <file.ts>
  bun run pcap --list

<source> is a preset id (see --list) or a .ts/.js/.json capture file.
Several sources are merged into one capture in time order.

  -o, --out <path>  where to write (default: testlab/out/<name>.pcap)
  --dump            list every frame as the app decodes it
  --new <file>      write a starter capture file and exit
  --list            list the preset ids and exit`

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** A source resolved to something writable: frames we can merge, or opaque bytes. */
type Resolved = { kind: 'capture'; capture: BuiltCapture } | { kind: 'bytes'; bytes: Uint8Array }

function isScenario(value: unknown): value is build.Scenario {
  return typeof value === 'object' && value !== null && Array.isArray((value as build.Scenario).steps)
}

function isBuiltCapture(value: unknown): value is BuiltCapture {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as BuiltCapture).frames) &&
    Array.isArray((value as BuiltCapture).senders)
  )
}

/**
 * Whatever a capture file exported, as one capture.
 *
 * `where` names the source in errors, because the usual mistake — exporting
 * the wrong thing, or nothing — is only fixable if you know which file did it.
 */
export async function resolveExport(value: unknown, where: string): Promise<Resolved> {
  if (typeof value === 'function') return resolveExport(await value(BUILD_KIT), where)
  if (value instanceof Uint8Array) return { kind: 'bytes', bytes: value }
  if (isBuiltCapture(value)) return { kind: 'capture', capture: value }
  if (isScenario(value)) return { kind: 'capture', capture: buildScenario(value) }

  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error(`${where}: exported an empty array`)
    const parts = await Promise.all(value.map((item, i) => resolveExport(item, `${where}[${i}]`)))
    return { kind: 'capture', capture: mergeCaptures(parts.map((part) => captureOf(part, where))) }
  }

  throw new Error(
    `${where}: the default export must be a Scenario, an array of them, a BuiltCapture, ` +
      `pcap bytes, or a function returning one of those`
  )
}

/**
 * Raw bytes have no record of who sent which frame and may not even be a
 * classic pcap, so they cannot be merged — only written as they are.
 */
function captureOf(resolved: Resolved, where: string): BuiltCapture {
  if (resolved.kind === 'capture') return resolved.capture
  throw new Error(`${where}: raw pcap bytes cannot be merged with other sources; build it on its own`)
}

async function loadSource(source: string): Promise<Resolved> {
  const preset = presetById(source)
  if (preset) return { kind: 'capture', capture: buildScenario(preset.build()) }

  const path = resolve(source)
  if (!existsSync(path)) {
    throw new Error(`"${source}" is neither a preset id nor an existing file (bun run pcap --list)`)
  }

  if (extname(path) === '.json') {
    return resolveExport(JSON.parse(readFileSync(path, 'utf8')), source)
  }

  const module = await import(pathToFileURL(path).href)
  if (!('default' in module)) throw new Error(`${source}: has no default export`)
  return resolveExport(module.default, source)
}

function nameOf(source: string): string {
  return presetById(source) ? source : basename(source, extname(source))
}

/** A path as the user would want to read it: short when it is nearby. */
function display(path: string): string {
  const rel = relative(process.cwd(), resolve(path))
  return rel === '' || rel.startsWith('..') ? resolve(path) : rel
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function readBack(bytes: Uint8Array) {
  const buffer = toArrayBuffer(bytes)
  const pcap: PcapParseResult = isPcapng(buffer) ? parsePcapng(buffer) : parsePcap(buffer)
  const bgp = parseBgpFromPackets(pcap.packets)
  return { pcap, bgp }
}

function flagText(flags: TcpFlags | undefined): string {
  if (!flags) return ''
  const names: Array<[keyof TcpFlags, string]> = [
    ['syn', 'SYN'],
    ['fin', 'FIN'],
    ['rst', 'RST'],
    ['psh', 'PSH'],
    ['ack', 'ACK'],
  ]
  return names.filter(([key]) => flags[key]).map(([, name]) => name).join(',')
}

function listed(prefixes: Array<{ prefix: string; length: number; pathId?: number }>): string {
  const shown = prefixes.slice(0, 3).map((p) => {
    const text = p.prefix.includes('/') ? p.prefix : `${p.prefix}/${p.length}`
    return p.pathId === undefined ? text : `${text}#${p.pathId}`
  })
  return prefixes.length > 3 ? `${shown.join(' ')} …(${prefixes.length})` : shown.join(' ')
}

/** One message, in the few words that tell it apart from its neighbours. */
export function describeMessage(message: BgpMessage): string {
  switch (message.type) {
    case 'OPEN':
      return `OPEN as=${message.fourByteAs ?? message.myAs} hold=${message.holdTime} id=${message.bgpIdentifier}`
    case 'UPDATE': {
      const reach = [...message.nlri]
      const unreach = [...message.withdrawnRoutes]
      for (const { parsed } of message.pathAttributes) {
        if (parsed?.type === 'MP_REACH_NLRI') reach.push(...parsed.nlri)
        if (parsed?.type === 'MP_UNREACH_NLRI') unreach.push(...parsed.withdrawnRoutes)
      }
      if (reach.length === 0 && unreach.length === 0) return 'UPDATE (End-of-RIB)'
      const parts = ['UPDATE']
      if (reach.length) parts.push(`+${listed(reach)}`)
      if (unreach.length) parts.push(`-${listed(unreach)}`)
      return parts.join(' ')
    }
    case 'NOTIFICATION':
      return `NOTIFICATION ${message.errorCode}/${message.errorSubcode} ${message.errorCodeName} / ${message.errorSubcodeName}`
    case 'KEEPALIVE':
      return 'KEEPALIVE'
    case 'ROUTE_REFRESH':
      return 'ROUTE_REFRESH'
  }
}

function dump(pcap: PcapParseResult, bgp: ReturnType<typeof parseBgpFromPackets>): string[] {
  const messagesByFrame = new Map(bgp.packets.map((packet) => [packet.frameIndex, packet.messages]))
  const start = pcap.allPackets[0]?.timestamp.getTime() ?? 0

  return pcap.allPackets.map((packet) => {
    const elapsed = ((packet.timestamp.getTime() - start) / 1000).toFixed(3).padStart(9)
    const from = `${packet.srcIp}:${packet.srcPort ?? ''}`
    const to = `${packet.dstIp}:${packet.dstPort ?? ''}`
    const messages = messagesByFrame.get(packet.frameIndex)?.map(describeMessage).join(' | ')
    const what = messages ?? (packet.payloadLength > 0 ? `${packet.payloadLength} bytes` : '')
    return [
      String(packet.frameIndex).padStart(4),
      elapsed,
      `${from} → ${to}`.padEnd(40),
      flagText(packet.tcpFlags).padEnd(11),
      what,
    ]
      .join('  ')
      .trimEnd()
  })
}

function connections(bytes: Uint8Array): Set<string> {
  const { pcap } = readBack(bytes)
  return new Set(
    pcap.allPackets.map((p) =>
      [`${p.srcIp}:${p.srcPort}`, `${p.dstIp}:${p.dstPort}`].sort().join(' <-> ')
    )
  )
}

/**
 * Sources that reuse one TCP connection. Merged, their frames interleave into
 * a single connection whose sequence numbers make no sense — every preset uses
 * the same two routers, so this is the easy mistake to make with this tool.
 */
export function sharedConnections(parts: BuiltCapture[], names: string[]): string[] {
  const seen = new Map<string, string>()
  const found: string[] = []
  parts.forEach((part, i) => {
    for (const key of connections(part.bytes)) {
      const earlier = seen.get(key)
      if (earlier !== undefined && earlier !== names[i]) {
        found.push(
          `${earlier} and ${names[i]} both use ${key}; they will read as one session. ` +
            `Give one of them different addresses or ports.`
        )
      } else seen.set(key, names[i])
    }
  })
  return found
}

// ---------------------------------------------------------------------------
// --new
// ---------------------------------------------------------------------------

/**
 * A starter file that imports the builder by a path that works from wherever
 * it was written, so the types are there whether it lives in the repository
 * or in a scratch directory.
 */
export function starterFile(target: string): string {
  const libDir = join(REPO_ROOT, 'src', 'lib', 'build')
  // Relative inside the repository, where the file might be committed; absolute
  // outside it, where a chain of ../ would only be harder to read.
  let lib = relative(dirname(resolve(target)), libDir)
  if (lib.startsWith('..') && !resolve(target).startsWith(REPO_ROOT + '/')) lib = libDir
  else if (!lib.startsWith('.')) lib = `./${lib}`

  return `/**
 * Build with:  bun run pcap ${display(target)} --dump
 */
import { ROUTER_A as A, ROUTER_B as B, announce, establish, END_OF_RIB, type Scenario } from '${lib}'

export default {
  a: A,
  b: B,
  gap: 200,
  steps: [
    ...establish(),
    {
      kind: 'send',
      from: 'a',
      messages: [announce(['10.1.0.0/24'], { nextHop: A.ip, asPath: [A.as] }), END_OF_RIB],
    },
    { kind: 'delay', gap: 30_000 },
    { kind: 'keepalive', from: 'a' },
    { kind: 'keepalive', from: 'b' },
  ],
} satisfies Scenario
`
}

// ---------------------------------------------------------------------------

interface Options {
  sources: string[]
  out?: string
  dump: boolean
  list: boolean
  newFile?: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = { sources: [], dump: false, list: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '-o' || arg === '--out') options.out = value()
    else if (arg === '--dump') options.dump = true
    else if (arg === '--list') options.list = true
    else if (arg === '--new') options.newFile = value()
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`)
    else options.sources.push(arg)
  }
  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.list) {
    for (const preset of PRESETS) console.log(`${preset.id.padEnd(20)} ${preset.description}`)
    return
  }

  if (options.newFile) {
    if (existsSync(options.newFile)) throw new Error(`${options.newFile} already exists`)
    mkdirSync(dirname(resolve(options.newFile)), { recursive: true })
    writeFileSync(options.newFile, starterFile(options.newFile))
    console.log(`wrote ${options.newFile}`)
    return
  }

  if (options.sources.length === 0) {
    console.error(USAGE)
    process.exit(1)
  }

  const resolved = await Promise.all(options.sources.map(loadSource))
  let bytes: Uint8Array
  let warnings: string[] = []
  let clashes: string[] = []
  if (resolved.length === 1 && resolved[0].kind === 'bytes') {
    bytes = resolved[0].bytes
  } else {
    const parts = resolved.map((part, i) => captureOf(part, options.sources[i]))
    const capture = mergeCaptures(parts)
    bytes = capture.bytes
    warnings = capture.warnings
    clashes = sharedConnections(parts, options.sources)
  }

  const out = resolve(options.out ?? join(DEFAULT_OUT_DIR, `${options.sources.map(nameOf).join('+')}.pcap`))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, bytes)

  const { pcap, bgp } = readBack(bytes)
  const messageCount = bgp.packets.reduce((sum, packet) => sum + packet.messages.length, 0)
  console.log(
    `wrote ${display(out)}  ` +
      `(${pcap.allPackets.length} frames, ${messageCount} BGP messages)`
  )

  if (options.dump) for (const line of dump(pcap, bgp)) console.log(line)

  // Not fatal: a capture built to be malformed is a legitimate thing to want.
  const problems = [
    ...warnings.map((text) => `builder: ${text}`),
    ...clashes.map((text) => `merge: ${text}`),
    ...pcap.errors.map((text) => `pcap error: ${text}`),
    ...pcap.warnings.map((text) => `pcap: ${text}`),
    ...bgp.warnings.map((text) => `bgp: ${text}`),
    ...bgp.packets.flatMap((packet) =>
      packet.parseWarnings.map((text) => `bgp frame ${packet.frameIndex}: ${text}`)
    ),
  ]
  for (const problem of problems) console.warn(`warning: ${problem}`)
}

// Only when run as a script, so the tests can import the pieces above.
if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
