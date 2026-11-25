/**
 * The in-memory pipeline a capture goes through, stage by stage, outside the
 * browser: how long each stage takes and how much heap it leaves behind.
 *
 *   bun build testlab/measure-pipeline.ts --target=node --outfile=/tmp/pipeline.mjs
 *   node --expose-gc --max-old-space-size=8192 /tmp/pipeline.mjs testlab/out/large/U-300mb.pcap
 *   node --expose-gc --cpu-prof --cpu-prof-dir=/tmp/prof /tmp/pipeline.mjs <capture>
 *   node --expose-gc /tmp/pipeline.mjs <capture> --snapshot /tmp/u.heapsnapshot   # then --summarize it
 *   node /tmp/pipeline.mjs --summarize /tmp/u.heapsnapshot
 *
 * Node, because a Node CPU profile and heap snapshot of the same V8 are far
 * easier to take and read than the browser's, and the stages here are plain
 * functions: parsing the file, decoding BGP, the route statistics, the
 * findings, the filter box's value suggestions, one filter pass. What it
 * cannot show is the page itself — React, the DuckDB load — which
 * `measure-large.ts` measures in Chromium.
 *
 * Every stage's result is kept alive to the end, as the app keeps it, so the
 * heap after a stage is what the app holds once it has run. The raw TCP
 * packets are let go after decoding, as `useBgpAnalyzer` lets them go.
 */
import { readFileSync } from 'node:fs'
import { writeHeapSnapshot } from 'node:v8'
import { isPcapng, parsePcapng } from '../src/lib/pcap/pcapng-parser'
import { parsePcap } from '../src/lib/pcap/parser'
import { parseBgpFromPackets } from '../src/lib/bgp/parser'
import { prefixStatsFor } from '../src/lib/bgp/prefix-stats'
import { alertsFor } from '../src/components/dashboard/alerts'
import { filterValuesForAsync } from '../src/lib/filter/parser'
import { filterPacketsWork, parseQuery } from '../src/lib/filter'
import { runToEnd } from '../src/lib/sliced'

declare const gc: (() => void) | undefined

function heap(): number {
  gc?.()
  gc?.()
  return process.memoryUsage().heapUsed
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`
}

async function measure(path: string, snapshot?: string): Promise<void> {
  const keep: unknown[] = []
  let before = heap()
  const stage = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
    const t0 = performance.now()
    const result = await work()
    const ms = performance.now() - t0
    keep.push(result)
    const after = heap()
    console.log(`${name.padEnd(12)} ${(ms / 1000).toFixed(2).padStart(6)}s  +${mb(after - before).padStart(6)}  heap ${mb(after)}`)
    before = after
    return result
  }

  const buffer = await stage('read', () => {
    const bytes = readFileSync(path)
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    return buffer
  })
  let pcap: ReturnType<typeof parsePcap> | null = await stage('parse', () =>
    isPcapng(buffer) ? parsePcapng(buffer) : parsePcap(buffer)
  )
  const allPackets = pcap.allPackets
  const bgp = await stage('decode', () => parseBgpFromPackets(pcap!.packets))
  // The raw packets are garbage once decoded; the app holds only the frames.
  keep.splice(keep.indexOf(pcap), 1)
  pcap = null
  await stage('drop raw', () => null)
  const packets = bgp.packets
  console.log(`  ${packets.length} BGP packets, ${allPackets.length} frames`)
  const stats = await stage('routes', () => prefixStatsFor(packets))
  console.log(`  ${stats.length} routes`)
  await stage('findings', () => alertsFor(packets, allPackets, 'en'))
  await stage('suggest', () => filterValuesForAsync(packets))
  await stage('filter', () => runToEnd(filterPacketsWork(packets, parseQuery('prefix = 20.0.0.0/8'))))
  if (snapshot) {
    writeHeapSnapshot(snapshot)
    console.log(`heap snapshot → ${snapshot}`)
  }
  void keep.length
}

/**
 * Self size per constructor (or string, array, …) in a heap snapshot, largest
 * first. Enough to see which objects a capture's heap is made of without
 * opening DevTools on a snapshot of several gigabytes.
 */
function summarize(path: string): void {
  const snapshot = JSON.parse(readFileSync(path, 'utf8'))
  const meta = snapshot.snapshot.meta
  const fields: string[] = meta.node_fields
  const types: string[] = meta.node_types[0]
  const nodes: number[] = snapshot.nodes
  const strings: string[] = snapshot.strings
  const width = fields.length
  const typeAt = fields.indexOf('type')
  const nameAt = fields.indexOf('name')
  const sizeAt = fields.indexOf('self_size')
  const totals = new Map<string, { count: number; size: number }>()
  let all = 0
  for (let i = 0; i < nodes.length; i += width) {
    const type = types[nodes[i + typeAt]]
    const name = type === 'object' || type === 'closure' ? strings[nodes[i + nameAt]] : `(${type})`
    const size = nodes[i + sizeAt]
    all += size
    const entry = totals.get(name) ?? { count: 0, size: 0 }
    entry.count++
    entry.size += size
    totals.set(name, entry)
  }
  const rows = [...totals].sort((a, b) => b[1].size - a[1].size).slice(0, 40)
  console.log(`total ${mb(all)}`)
  for (const [name, { count, size }] of rows) {
    console.log(`${mb(size).padStart(8)}  ${String(count).padStart(10)}  ${(size / count).toFixed(0).padStart(5)}B  ${name.slice(0, 80)}`)
  }
}

const args = process.argv.slice(2)
const summarizeAt = args.indexOf('--summarize')
if (summarizeAt >= 0) {
  summarize(args[summarizeAt + 1])
} else {
  const snapshotAt = args.indexOf('--snapshot')
  const snapshot = snapshotAt >= 0 ? args.splice(snapshotAt, 2)[1] : undefined
  await measure(args[0], snapshot)
}
