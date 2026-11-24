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
 *   bun run pcap real.pcapng --dump      # an existing capture, listed (and copied)
 *   bun run pcap --list                  # preset ids
 *
 * The listing is read back through the app's own parsers, not the builder's
 * idea of what it wrote, so a capture that does not decode as intended shows
 * up here rather than after it has been loaded into the browser.
 *
 * A capture file's default export may be any of:
 *
 * - a `Scenario`, a `PacketList` (traffic that is not a session), or a
 *   `BuiltCapture` — from the builders, `readCapture`, or any of the edits in
 *   `src/lib/build/edit.ts`
 * - an array of those, merged in time order
 * - raw pcap bytes, written as they are — for a file damaged with `patchRecord`
 * - a function, optionally async, returning any of the above. It is passed the
 *   builder module plus `load(path)`, which reads an existing capture relative
 *   to the capture file, so a file outside the repository needs no imports.
 *
 * A `.json` file holding a `Scenario` or an array of them works too, and a
 * `.pcap` / `.pcapng` / `.cap` source is read in as it is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as build from '../src/lib/build'
import {
  PRESETS,
  buildPackets,
  buildScenario,
  mergeCaptures,
  presetById,
  readCapture,
  type BuiltCapture,
  type PacketList,
} from '../src/lib/build'
import { Afi, Safi } from '../src/lib/bgp/constants'
import { parseBgpFromPackets } from '../src/lib/bgp/parser'
import type { BgpMessage } from '../src/lib/bgp/types'
import { isPcapng, parsePcapng } from '../src/lib/pcap/pcapng-parser'
import { parsePcap } from '../src/lib/pcap/parser'
import type { PcapParseResult, TcpFlags } from '../src/lib/pcap/types'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Gitignored, like `testlab/scenarios/`: the description is what is worth keeping. */
const DEFAULT_OUT_DIR = join(REPO_ROOT, 'testlab', 'out')

const CAPTURE_EXTENSIONS = new Set(['.pcap', '.pcapng', '.cap'])

/**
 * What a capture file is handed when its default export is a function: the
 * builder, and `load`, which reads a capture relative to the file asking —
 * so `load('real.pcap')` means the one beside it, wherever it was run from.
 */
export function buildKit(baseDir: string) {
  return {
    ...build,
    Afi,
    Safi,
    load: (path: string) => readCapture(readFileSync(resolve(baseDir, path))),
  }
}

const USAGE = `Usage:
  bun run pcap <source>... [-o <out.pcap>] [--dump]
  bun run pcap --new <file.ts>
  bun run pcap --list

<source> is a preset id (see --list), a .ts/.js/.json capture file, or an
existing .pcap/.pcapng/.cap. Several sources are merged in time order.

  -o, --out <path>  where to write (default: testlab/out/<name>.pcap)
  --dump            list every frame as the app decodes it
  --new <file>      write a starter capture file and exit
  --list            list the preset ids and exit`

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** A part of the output, named so that a warning can say where it came from. */
export interface Part {
  name: string
  capture: BuiltCapture
}

/** A source resolved to something writable: parts to merge, or opaque bytes. */
type Resolved = { kind: 'parts'; parts: Part[] } | { kind: 'bytes'; bytes: Uint8Array }

function has(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && key in value
}

/**
 * Whatever a capture file exported, as the parts it is made of.
 *
 * Kept as parts rather than merged on the spot so that two sessions on one
 * TCP connection are caught whether they came from two files or one array.
 * `where` names the source in errors, because the usual mistake — exporting
 * the wrong thing, or nothing — is only fixable if you know which file did it.
 */
export async function resolveExport(
  value: unknown,
  where: string,
  kit: ReturnType<typeof buildKit> = buildKit(process.cwd())
): Promise<Resolved> {
  if (typeof value === 'function') return resolveExport(await value(kit), where, kit)
  if (value instanceof Uint8Array) return { kind: 'bytes', bytes: value }

  const one = (capture: BuiltCapture): Resolved => ({ kind: 'parts', parts: [{ name: where, capture }] })
  if (has(value, 'frames') && has(value, 'senders')) return one(value as BuiltCapture)
  if (has(value, 'steps')) return one(buildScenario(value as build.Scenario))
  if (has(value, 'packets')) return one(buildPackets(value as PacketList))

  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error(`${where}: exported an empty array`)
    const resolved = await Promise.all(value.map((item, i) => resolveExport(item, `${where}[${i}]`, kit)))
    return { kind: 'parts', parts: resolved.flatMap((part, i) => partsOf(part, `${where}[${i}]`)) }
  }

  throw new Error(
    `${where}: the default export must be a Scenario, a PacketList, a BuiltCapture, an array ` +
      `of those, pcap bytes, or a function returning one of those`
  )
}

/**
 * Raw bytes have no record of who sent which frame and may not even be a
 * readable pcap, so they cannot be merged — only written as they are.
 */
function partsOf(resolved: Resolved, where: string): Part[] {
  if (resolved.kind === 'parts') return resolved.parts
  throw new Error(`${where}: raw pcap bytes cannot be merged with other sources; build it on its own`)
}

async function loadSource(source: string): Promise<Resolved> {
  const preset = presetById(source)
  if (preset) return { kind: 'parts', parts: [{ name: source, capture: buildScenario(preset.build()) }] }

  const path = resolve(source)
  if (!existsSync(path)) {
    throw new Error(`"${source}" is neither a preset id nor an existing file (bun run pcap --list)`)
  }

  const extension = extname(path).toLowerCase()
  if (CAPTURE_EXTENSIONS.has(extension)) {
    return { kind: 'parts', parts: [{ name: source, capture: readCapture(readFileSync(path)) }] }
  }
  if (extension === '.json') {
    return resolveExport(JSON.parse(readFileSync(path, 'utf8')), source)
  }

  const module = await import(pathToFileURL(path).href)
  if (!('default' in module)) throw new Error(`${source}: has no default export`)
  return resolveExport(module.default, source, buildKit(dirname(path)))
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
    // EVPN routes come formatted ("[2] 00:0c:…"), with no length to add.
    const text = p.prefix.includes('/') || p.prefix.startsWith('[') ? p.prefix : `${p.prefix}/${p.length}`
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
    const endpoint = (ip: string, port: number | undefined) =>
      port === undefined ? ip : ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`
    const from = endpoint(packet.srcIp, packet.srcPort)
    const to = endpoint(packet.dstIp, packet.dstPort)
    // TCP shows its flags; anything else says what it is in the same column.
    const kind =
      packet.protocol === 'TCP'
        ? flagText(packet.tcpFlags)
        : packet.protocol === 'OTHER'
          ? `IP/${packet.protocolNumber}`
          : packet.protocol
    const messages = messagesByFrame.get(packet.frameIndex)?.map(describeMessage).join(' | ')
    const what = messages ?? (packet.payloadLength > 0 ? `${packet.payloadLength} bytes` : '')
    return [
      String(packet.frameIndex).padStart(4),
      elapsed,
      `${from} → ${to}`.padEnd(40),
      kind.padEnd(11),
      what,
    ]
      .join('  ')
      .trimEnd()
  })
}

function connections(bytes: Uint8Array): Set<string> {
  const { pcap } = readBack(bytes)
  return new Set(
    pcap.allPackets
      .filter((p) => p.protocol === 'TCP')
      .map((p) => [`${p.srcIp}:${p.srcPort}`, `${p.dstIp}:${p.dstPort}`].sort().join(' <-> '))
  )
}

/**
 * Sources that reuse one TCP connection. Merged, their frames interleave into
 * a single connection whose sequence numbers make no sense — every preset uses
 * the same two routers, so this is the easy mistake to make with this tool.
 */
export function sharedConnections(parts: Part[]): string[] {
  const seen = new Map<string, string>()
  const found: string[] = []
  for (const { name, capture } of parts) {
    for (const key of connections(capture.bytes)) {
      const earlier = seen.get(key)
      if (earlier !== undefined) {
        found.push(
          `${earlier} and ${name} both use ${key}; they will read as one session. ` +
            `Give one of them different addresses or ports.`
        )
      } else seen.set(key, name)
    }
  }
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
  let written: number | undefined
  if (resolved.length === 1 && resolved[0].kind === 'bytes') {
    bytes = resolved[0].bytes
  } else {
    const parts = resolved.flatMap((part, i) => partsOf(part, options.sources[i]))
    const capture = mergeCaptures(parts.map((part) => part.capture))
    bytes = capture.bytes
    written = capture.frames.length
    warnings = capture.warnings
    clashes = sharedConnections(parts)
  }

  const out = resolve(options.out ?? join(DEFAULT_OUT_DIR, `${options.sources.map(nameOf).join('+')}.pcap`))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, bytes)

  const { pcap, bgp } = readBack(bytes)
  const messageCount = bgp.packets.reduce((sum, packet) => sum + packet.messages.length, 0)
  // The app lists IP frames only, so a capture with ARP or LLDP in it has more
  // frames than it shows; say both rather than let the count look wrong.
  const seen = pcap.allPackets.length
  const frames = written === undefined || written === seen ? `${seen} frames` : `${written} frames, ${seen} shown by the app`
  console.log(`wrote ${display(out)}  (${frames}, ${messageCount} BGP messages)`)

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
