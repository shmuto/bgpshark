/**
 * Build a capture instead of going to find one.
 *
 * The analysis screens all start from a pcap someone already has. That is the
 * hard part of reproducing a problem, testing a change or showing somebody what
 * a failure mode looks like — you need a router, a lab and a session that
 * misbehaves on cue. This screen describes the session instead, and writes the
 * capture the description implies.
 *
 * The preview is not a rendering of the scenario: it is the built file read
 * back through the same parsers the rest of the app uses. What you see here is
 * therefore what the analyzer will see, and if the encoder produced something
 * the parser rejects, the preview is where it shows up.
 */
import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { ScenarioEditor } from '../components/builder/ScenarioEditor'
import {
  toEditorSteps,
  toScenarioSteps,
  type EditorStep,
} from '../components/builder/editor-model'
import { PRESETS, buildScenario, type BuiltCapture, type Scenario } from '../lib/build'
import { parsePcap } from '../lib/pcap/parser'
import { parseBgpFromPackets } from '../lib/bgp/parser'
import { countUpdatePrefixes, endOfRibMarker } from '../lib/bgp/update'
import { formatDelta } from '../lib/format-time'
import type { BgpPacket } from '../lib/bgp/types'
import type { GenericPacket } from '../lib/pcap/types'

interface Preview {
  packets: GenericPacket[]
  bgpByFrame: Map<number, BgpPacket>
  bgpMessageCount: number
  warnings: string[]
  errors: string[]
}

type BuildResult =
  | { ok: true; capture: BuiltCapture; preview: Preview }
  | { ok: false; error: string }

export function BuilderPage() {
  const { loadFile } = useApp()
  const navigate = useNavigate()

  const [presetId, setPresetId] = useState(PRESETS[0].id)
  const [scenario, setScenario] = useState<Scenario>(() => PRESETS[0].build())
  const [steps, setSteps] = useState<EditorStep[]>(() => toEditorSteps(PRESETS[0].build().steps))
  const [loading, setLoading] = useState(false)

  const applyPreset = useCallback((id: string) => {
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) return

    const built = preset.build()
    setPresetId(id)
    setScenario(built)
    setSteps(toEditorSteps(built.steps))
  }, [])

  const result = useMemo<BuildResult>(() => {
    try {
      const capture = buildScenario({ ...scenario, steps: toScenarioSteps(steps) })
      return { ok: true, capture, preview: decode(capture) }
    } catch (e) {
      // Half-typed input reaches here constantly — an address mid-edit, an
      // empty AS path. Showing the message beats an error boundary.
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }, [scenario, steps])

  const fileName = `${(scenario.name ?? 'scenario').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pcap`

  const download = useCallback(() => {
    if (!result.ok) return

    const blob = new Blob([result.capture.bytes], { type: 'application/vnd.tcpdump.pcap' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
  }, [result, fileName])

  const openInAnalyzer = useCallback(async () => {
    if (!result.ok) return

    setLoading(true)
    try {
      await loadFile(new File([result.capture.bytes], fileName, { type: 'application/vnd.tcpdump.pcap' }))
      navigate('/messages')
    } finally {
      setLoading(false)
    }
  }, [result, fileName, loadFile, navigate])

  const frameCount = result.ok ? result.capture.frames.length : 0
  const byteCount = result.ok ? result.capture.bytes.length : 0

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-canvas lg:flex-row">
      {/* Editor */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-hair p-4 lg:border-r">
        <div className="mb-4">
          <h1 className="text-sm font-semibold text-strong">Build a capture</h1>
          <p className="mt-1 text-xs text-muted">
            Describe a BGP session and get a pcap of it. Start from a scenario below, then change
            the addresses, AS numbers and routes to match the one you are working on.
          </p>
        </div>

        <div className="mb-5">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-dim">
            Scenario
          </label>
          <select
            className="w-full rounded border border-hair-strong bg-surface px-2 py-1.5 text-xs text-body focus:border-accent focus:outline-none"
            value={presetId}
            onChange={(e) => applyPreset(e.target.value)}
          >
            {PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-dim">
            {PRESETS.find((p) => p.id === presetId)?.description}
          </p>
        </div>

        <ScenarioEditor
          scenario={scenario}
          steps={steps}
          onScenarioChange={setScenario}
          onStepsChange={setSteps}
        />
      </div>

      {/* Preview */}
      <div className="flex min-h-0 flex-1 flex-col lg:max-w-[46%]">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hair bg-surface px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-dim">Preview</span>
          {result.ok && (
            <span className="font-mono text-[11px] text-muted">
              {frameCount} frames · {formatBytes(byteCount)} ·{' '}
              {result.preview.bgpMessageCount} BGP messages
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={download}
              disabled={!result.ok || frameCount === 0}
              className="rounded border border-hair px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-hair-strong hover:text-strong disabled:pointer-events-none disabled:opacity-40"
            >
              Download .pcap
            </button>
            <button
              type="button"
              onClick={openInAnalyzer}
              disabled={!result.ok || frameCount === 0 || loading}
              className="rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
            >
              {loading ? 'Loading…' : 'Open in analyzer'}
            </button>
          </div>
        </div>

        {!result.ok ? (
          <div className="m-4 rounded border border-critical/40 bg-critical-subtle px-3 py-2 text-xs text-critical">
            {result.error}
          </div>
        ) : (
          <>
            {(result.preview.errors.length > 0 || result.preview.warnings.length > 0) && (
              <div className="m-4 mb-0 rounded border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-body">
                <p className="mb-1 font-medium text-warning">
                  The built file did not read back cleanly
                </p>
                <ul className="list-disc pl-4">
                  {[...result.preview.errors, ...result.preview.warnings].slice(0, 5).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <FramePreview preview={result.preview} />
          </>
        )}
      </div>
    </div>
  )
}

function FramePreview({ preview }: { preview: Preview }) {
  const start = preview.packets[0]?.timestamp.getTime() ?? 0

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-surface-sunken">
          <tr className="border-b border-hair text-left text-[11px] uppercase tracking-wide text-dim">
            <th className="px-3 py-1.5 font-medium">#</th>
            <th className="px-3 py-1.5 font-medium">Time</th>
            <th className="px-3 py-1.5 font-medium">Source</th>
            <th className="px-3 py-1.5 font-medium">Destination</th>
            <th className="px-3 py-1.5 font-medium">Len</th>
            <th className="px-3 py-1.5 font-medium">Info</th>
          </tr>
        </thead>
        <tbody>
          {preview.packets.map((packet) => {
            const bgp = preview.bgpByFrame.get(packet.frameIndex)

            return (
              <tr key={packet.frameIndex} className="border-b border-hair/60 hover:bg-surface-sunken">
                <td className="px-3 py-1 font-mono text-dim">{packet.frameIndex}</td>
                <td className="px-3 py-1 font-mono text-muted">
                  {formatDelta(packet.timestamp.getTime() - start)}
                </td>
                <td className="px-3 py-1 font-mono text-muted">
                  {packet.srcIp}:{packet.srcPort}
                </td>
                <td className="px-3 py-1 font-mono text-muted">
                  {packet.dstIp}:{packet.dstPort}
                </td>
                <td className="px-3 py-1 font-mono text-dim">{packet.capturedLength}</td>
                <td className="px-3 py-1 text-body">
                  {bgp ? <BgpInfo packet={bgp} /> : <span className="text-dim">{tcpFlags(packet)}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const TYPE_COLORS: Record<string, string> = {
  OPEN: 'text-bgp-open',
  UPDATE: 'text-bgp-update',
  NOTIFICATION: 'text-bgp-notification',
  KEEPALIVE: 'text-bgp-keepalive',
  ROUTE_REFRESH: 'text-bgp-route-refresh',
}

function BgpInfo({ packet }: { packet: BgpPacket }) {
  return (
    <span className="flex flex-wrap gap-x-2">
      {packet.messages.map((message, index) => (
        <span key={index} className={TYPE_COLORS[message.type] ?? 'text-body'}>
          {message.type === 'UPDATE' ? describeUpdate(message) : message.type}
        </span>
      ))}
    </span>
  )
}

function describeUpdate(message: Extract<BgpPacket['messages'][number], { type: 'UPDATE' }>): string {
  const eor = endOfRibMarker(message)
  if (eor) return `UPDATE (End-of-RIB ${eor})`

  const { announced, withdrawn } = countUpdatePrefixes(message)
  const parts: string[] = []
  if (announced > 0) parts.push(`${announced} announced`)
  if (withdrawn > 0) parts.push(`${withdrawn} withdrawn`)
  return `UPDATE${parts.length ? ` (${parts.join(', ')})` : ''}`
}

function tcpFlags(packet: GenericPacket): string {
  const flags = packet.tcpFlags
  if (!flags) return packet.protocol

  const set = [
    flags.syn && 'SYN',
    flags.fin && 'FIN',
    flags.rst && 'RST',
    flags.psh && 'PSH',
    flags.ack && 'ACK',
  ].filter(Boolean)

  return `TCP [${set.join(', ')}]`
}

/** Read the built file back the way the analyzer would. */
function decode(capture: BuiltCapture): Preview {
  const buffer = capture.bytes.buffer.slice(
    capture.bytes.byteOffset,
    capture.bytes.byteOffset + capture.bytes.byteLength
  ) as ArrayBuffer

  const pcap = parsePcap(buffer)
  const bgp = parseBgpFromPackets(pcap.packets)

  return {
    packets: pcap.allPackets,
    bgpByFrame: new Map(bgp.packets.map((packet) => [packet.frameIndex, packet])),
    bgpMessageCount: bgp.packets.reduce((total, packet) => total + packet.messages.length, 0),
    warnings: [...pcap.warnings, ...bgp.warnings, ...capture.warnings],
    errors: pcap.errors,
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
