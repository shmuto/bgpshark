/**
 * The capture CLI's contract is "whatever a capture file exports, you get a
 * pcap", so these check each accepted export shape, and that a file written by
 * `--new` actually builds — a starter that does not run would be worse than
 * none.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ROUTER_A, ROUTER_B, buildScenario, establish } from '../../src/lib/build'
import { resolveExport, sharedConnections, starterFile } from '../../testlab/pcap'

const REPO = resolve(import.meta.dir, '../..')

const SCRIPT = resolve(import.meta.dir, '../../testlab/pcap.ts')
const work = mkdtempSync(join(tmpdir(), 'bgpshark-pcap-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const scenario = { a: ROUTER_A, b: ROUTER_B, steps: establish() }

function run(...args: string[]) {
  const result = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd: work })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

const frameCount = (resolved: Awaited<ReturnType<typeof resolveExport>>) =>
  resolved.kind === 'parts' ? resolved.parts.reduce((n, part) => n + part.capture.frames.length, 0) : -1

describe('resolveExport', () => {
  test('builds a Scenario', async () => {
    expect(frameCount(await resolveExport(scenario, 'x'))).toBe(7)
  })

  test('builds a PacketList', async () => {
    const list = { packets: [{ protocol: 'icmp', src: '10.0.0.1', dst: '10.0.0.2' }] }
    expect(frameCount(await resolveExport(list, 'x'))).toBe(1)
  })

  test('passes the builder to a function export', async () => {
    const resolved = await resolveExport(
      async (kit: { establish: typeof establish }) => ({ ...scenario, steps: kit.establish() }),
      'x'
    )
    expect(frameCount(resolved)).toBe(7)
  })

  test('keeps an array as named parts, and raw bytes as they are', async () => {
    const resolved = await resolveExport([scenario, buildScenario(scenario)], 'x')
    expect(resolved.kind === 'parts' && resolved.parts.map((part) => part.name)).toEqual(['x[0]', 'x[1]'])

    const bytes = new Uint8Array([1, 2, 3])
    expect(await resolveExport(bytes, 'x')).toEqual({ kind: 'bytes', bytes })
  })

  test('names the source when the export is wrong', async () => {
    await expect(resolveExport({ nope: true }, 'case.ts')).rejects.toThrow(/^case\.ts:/)
    await expect(resolveExport([scenario, new Uint8Array(3)], 'case.ts')).rejects.toThrow(
      /case\.ts\[1\]: raw pcap bytes cannot be merged/
    )
  })
})

describe('sharedConnections', () => {
  test('flags parts that would collapse into one TCP connection', () => {
    const one = { name: 'p', capture: buildScenario(scenario) }
    const same = { name: 'q', capture: buildScenario(scenario) }
    const other = { name: 'r', capture: buildScenario({ ...scenario, a: { ...ROUTER_A, port: 52000 } }) }
    expect(sharedConnections([one, same])).toHaveLength(1)
    expect(sharedConnections([one, other])).toEqual([])
  })
})

describe('bun run pcap', () => {
  test('writes a preset and reads it back', () => {
    const out = join(work, 'preset.pcap')
    const result = run('established', '-o', out, '--dump')
    expect(result.code).toBe(0)
    expect(existsSync(out)).toBe(true)
    expect(result.stdout).toMatch(/OPEN as=65001/)
    expect(result.stdout).toMatch(/UPDATE \(End-of-RIB\)/)
  })

  test('builds the file --new writes', () => {
    const file = join(work, 'starter.ts')
    expect(run('--new', file).code).toBe(0)
    // Outside the repository, so the builder is imported by absolute path.
    expect(readFileSync(file, 'utf8')).toContain(`from '${resolve(import.meta.dir, '../../src/lib/build')}'`)

    const result = run(file, '-o', join(work, 'starter.pcap'))
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/10 frames, 8 BGP messages/)
  })

  test('accepts a JSON scenario', () => {
    const file = join(work, 'case.json')
    writeFileSync(file, JSON.stringify(scenario))
    const result = run(file, '-o', join(work, 'json.pcap'))
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/7 frames/)
  })

  test('reads an existing capture as a source', () => {
    const result = run(join(REPO, 'public', 'sample.pcapng'), '-o', join(work, 'sample.pcap'))
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/119 frames/)
  })

  test('load() reads a capture beside the capture file, wherever it is run from', () => {
    writeFileSync(join(work, 'beside.pcap'), buildScenario(scenario).bytes)
    const file = join(work, 'edit.ts')
    writeFileSync(
      file,
      `export default ({ load, dropFrames, buildPackets, mergeCaptures }) => [
        dropFrames(load('beside.pcap'), [1]),
        buildPackets({ packets: [{ protocol: 'udp', src: '10.9.9.9', dst: '10.9.9.8', srcPort: 1, dstPort: 2 }] }),
      ]\n`
    )
    const result = Bun.spawnSync(['bun', SCRIPT, file, '-o', join(work, 'edit.pcap'), '--dump'], { cwd: REPO })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toMatch(/7 frames/)
    expect(result.stdout.toString()).toMatch(/10\.9\.9\.9:1 → 10\.9\.9\.8:2\s+UDP/)
  })

  test('writes raw bytes as they are, damage and all', () => {
    const file = join(work, 'damaged.ts')
    writeFileSync(
      file,
      `export default ({ buildScenario, establish, patchRecord, ROUTER_A, ROUTER_B }) =>
        patchRecord(buildScenario({ a: ROUTER_A, b: ROUTER_B, steps: establish() }).bytes, 3, { capturedLength: 9999 })\n`
    )
    const result = run(file, '-o', join(work, 'damaged.pcap'))
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/2 frames/)
    expect(result.stderr).toMatch(/file appears truncated/)
  })

  test('imports the builder relatively from inside the repository', () => {
    expect(starterFile(join(REPO, 'testlab', 'out', 'x.ts'))).toContain(`from '../../src/lib/build'`)
  })

  test('fails on a source it cannot find', () => {
    const result = run('no-such-preset')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/neither a preset id nor an existing file/)
  })
})
