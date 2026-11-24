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

describe('resolveExport', () => {
  test('builds a Scenario', async () => {
    const resolved = await resolveExport(scenario, 'x')
    expect(resolved.kind).toBe('capture')
  })

  test('passes the builder to a function export', async () => {
    const resolved = await resolveExport(
      async (kit: { establish: typeof establish }) => ({ ...scenario, steps: kit.establish() }),
      'x'
    )
    expect(resolved.kind === 'capture' && resolved.capture.frames.length).toBe(7)
  })

  test('merges an array, and keeps raw bytes as they are', async () => {
    const merged = await resolveExport([scenario, buildScenario(scenario)], 'x')
    expect(merged.kind === 'capture' && merged.capture.frames.length).toBe(14)

    const bytes = new Uint8Array([1, 2, 3])
    expect(await resolveExport(bytes, 'x')).toEqual({ kind: 'bytes', bytes })
  })

  test('names the source when the export is wrong', async () => {
    await expect(resolveExport({ nope: true }, 'case.ts')).rejects.toThrow(/^case\.ts:/)
    await expect(resolveExport([scenario, new Uint8Array(3)], 'case.ts')).rejects.toThrow(
      /case\.ts: raw pcap bytes cannot be merged/
    )
  })
})

describe('sharedConnections', () => {
  test('flags sources that would collapse into one TCP connection', () => {
    const one = buildScenario(scenario)
    const other = buildScenario({ ...scenario, a: { ...ROUTER_A, port: 52000 } })
    expect(sharedConnections([one, buildScenario(scenario)], ['p', 'q'])).toHaveLength(1)
    expect(sharedConnections([one, other], ['p', 'q'])).toEqual([])
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

  test('imports the builder relatively from inside the repository', () => {
    expect(starterFile(join(REPO, 'testlab', 'out', 'x.ts'))).toContain(`from '../../src/lib/build'`)
  })

  test('fails on a source it cannot find', () => {
    const result = run('no-such-preset')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/neither a preset id nor an existing file/)
  })
})
