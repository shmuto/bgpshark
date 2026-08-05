import type { Scenario, ScenarioPeer, Side } from '../../lib/build'
import { LinkLayerType } from '../../lib/pcap/types'
import {
  MESSAGE_LABELS,
  STEP_LABELS,
  newMessage,
  newStep,
  type EditorStep,
  type EditorStepKind,
  type MessageEditor,
} from './editor-model'

const CONTROL =
  'rounded border border-hair-strong bg-surface px-2 py-1 text-xs text-body focus:border-accent focus:outline-none'

interface ScenarioEditorProps {
  scenario: Scenario
  steps: EditorStep[]
  onScenarioChange: (scenario: Scenario) => void
  onStepsChange: (steps: EditorStep[]) => void
}

export function ScenarioEditor({
  scenario,
  steps,
  onScenarioChange,
  onStepsChange,
}: ScenarioEditorProps) {
  const updatePeer = (side: Side, changes: Partial<ScenarioPeer>) => {
    onScenarioChange({ ...scenario, [side]: { ...scenario[side], ...changes } })
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionHeading>Peers</SectionHeading>
        <div className="grid gap-3 sm:grid-cols-2">
          <PeerFields side="a" peer={scenario.a} onChange={(c) => updatePeer('a', c)} />
          <PeerFields side="b" peer={scenario.b} onChange={(c) => updatePeer('b', c)} />
        </div>
      </section>

      <section>
        <SectionHeading>Capture</SectionHeading>
        <CaptureFields scenario={scenario} onChange={onScenarioChange} />
      </section>

      <section>
        <SectionHeading>Sequence</SectionHeading>
        <StepList scenario={scenario} steps={steps} onChange={onStepsChange} />
      </section>
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-dim">{children}</h2>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted" title={hint}>
        {label}
      </span>
      {children}
    </label>
  )
}

function PeerFields({
  side,
  peer,
  onChange,
}: {
  side: Side
  peer: ScenarioPeer
  onChange: (changes: Partial<ScenarioPeer>) => void
}) {
  return (
    <div className="rounded border border-hair bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <SideBadge side={side} />
        <span className="text-xs text-muted">
          {side === 'a' ? 'connects' : 'listens on 179'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="IP address">
          <input
            type="text"
            className={`${CONTROL} font-mono`}
            value={peer.ip}
            onChange={(e) => onChange({ ip: e.target.value })}
          />
        </Field>
        <Field label="AS number">
          <input
            type="text"
            inputMode="numeric"
            className={`${CONTROL} font-mono`}
            value={peer.as}
            onChange={(e) => onChange({ as: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="Router ID">
          <input
            type="text"
            className={`${CONTROL} font-mono`}
            value={peer.routerId}
            onChange={(e) => onChange({ routerId: e.target.value })}
          />
        </Field>
        <Field label="Hold time (s)">
          <input
            type="text"
            inputMode="numeric"
            className={`${CONTROL} font-mono`}
            value={peer.holdTime ?? 90}
            onChange={(e) => onChange({ holdTime: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="TCP port" hint="Set both peers' ports to separate two sessions between one pair of addresses">
          <input
            type="text"
            inputMode="numeric"
            className={`${CONTROL} font-mono`}
            value={peer.port ?? (side === 'a' ? 51000 : 179)}
            onChange={(e) => onChange({ port: Number(e.target.value) || 0 })}
          />
        </Field>
      </div>
    </div>
  )
}

function CaptureFields({
  scenario,
  onChange,
}: {
  scenario: Scenario
  onChange: (scenario: Scenario) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded border border-hair bg-surface p-3 sm:grid-cols-4">
      <Field label="Link type">
        <select
          className={CONTROL}
          value={scenario.linkType ?? LinkLayerType.ETHERNET}
          onChange={(e) => onChange({ ...scenario, linkType: Number(e.target.value) })}
        >
          <option value={LinkLayerType.ETHERNET}>Ethernet</option>
          <option value={LinkLayerType.SLL}>Linux SLL</option>
        </select>
      </Field>

      <Field label="VLAN IDs" hint="Outermost first. Two of them make a QinQ capture.">
        <input
          type="text"
          className={`${CONTROL} font-mono`}
          placeholder="none"
          value={(scenario.vlanIds ?? []).join(' ')}
          onChange={(e) => {
            const ids = e.target.value
              .split(/[\s,]+/)
              .filter(Boolean)
              .map(Number)
              .filter((n) => Number.isFinite(n))
            onChange({ ...scenario, vlanIds: ids.length > 0 ? ids : undefined })
          }}
        />
      </Field>

      <Field label="MTU" hint="Lower it to split BGP messages across TCP segments">
        <input
          type="text"
          inputMode="numeric"
          className={`${CONTROL} font-mono`}
          value={scenario.mtu ?? 1500}
          onChange={(e) => onChange({ ...scenario, mtu: Number(e.target.value) || 1500 })}
        />
      </Field>

      <Field label="Default gap (ms)">
        <input
          type="text"
          inputMode="numeric"
          className={`${CONTROL} font-mono`}
          value={scenario.gap ?? 100}
          onChange={(e) => onChange({ ...scenario, gap: Number(e.target.value) || 0 })}
        />
      </Field>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function StepList({
  scenario,
  steps,
  onChange,
}: {
  scenario: Scenario
  steps: EditorStep[]
  onChange: (steps: EditorStep[]) => void
}) {
  const replace = (index: number, step: EditorStep) => {
    onChange(steps.map((existing, i) => (i === index ? step : existing)))
  }

  const remove = (index: number) => {
    onChange(steps.filter((_, i) => i !== index))
  }

  const move = (index: number, by: number) => {
    const target = index + by
    if (target < 0 || target >= steps.length) return
    const reordered = [...steps]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    onChange(reordered)
  }

  return (
    <div className="flex flex-col gap-2">
      {steps.length === 0 && (
        <p className="rounded border border-dashed border-hair px-3 py-6 text-center text-xs text-dim">
          No steps yet. Add a TCP handshake to start a session.
        </p>
      )}

      {steps.map((step, index) => (
        <StepCard
          key={step.id}
          scenario={scenario}
          step={step}
          onChange={(next) => replace(index, next)}
          onRemove={() => remove(index)}
          onMoveUp={index > 0 ? () => move(index, -1) : undefined}
          onMoveDown={index < steps.length - 1 ? () => move(index, 1) : undefined}
        />
      ))}

      <AddStep onAdd={(kind) => onChange([...steps, newStep(kind, scenario)])} />
    </div>
  )
}

function AddStep({ onAdd }: { onAdd: (kind: EditorStepKind) => void }) {
  const kinds = Object.keys(STEP_LABELS) as EditorStepKind[]

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-[11px] text-dim">Add:</span>
      {kinds.map((kind) => (
        <button
          key={kind}
          type="button"
          onClick={() => onAdd(kind)}
          className="rounded border border-hair px-2 py-1 text-[11px] text-muted transition-colors hover:border-hair-strong hover:text-strong"
        >
          + {STEP_LABELS[kind]}
        </button>
      ))}
    </div>
  )
}

function StepCard({
  scenario,
  step,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  scenario: Scenario
  step: EditorStep
  onChange: (step: EditorStep) => void
  onRemove: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  const hasSide = step.kind !== 'handshake' && step.kind !== 'delay'

  return (
    <div className="rounded border border-hair bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-xs font-medium text-strong">{STEP_LABELS[step.kind]}</span>

        {hasSide && (
          <select
            className={CONTROL}
            value={step.from}
            onChange={(e) => onChange({ ...step, from: e.target.value as Side })}
            aria-label="Sent by"
          >
            <option value="a">from A ({scenario.a.ip})</option>
            <option value="b">from B ({scenario.b.ip})</option>
          </select>
        )}

        <label className="flex items-center gap-1 text-[11px] text-dim">
          {step.kind === 'delay' ? 'for' : 'after'}
          <input
            type="text"
            inputMode="numeric"
            className={`${CONTROL} w-20 font-mono`}
            value={step.kind === 'delay' ? step.gap : (step.gap ?? '')}
            placeholder={String(scenario.gap ?? 100)}
            onChange={(e) => {
              const value = e.target.value.trim()
              const gap = value === '' ? undefined : Number(value)
              if (gap !== undefined && !Number.isFinite(gap)) return
              onChange(
                step.kind === 'delay'
                  ? { ...step, gap: gap ?? 0 }
                  : ({ ...step, gap } as EditorStep)
              )
            }}
          />
          ms
        </label>

        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Move up" onClick={onMoveUp}>
            ↑
          </IconButton>
          <IconButton label="Move down" onClick={onMoveDown}>
            ↓
          </IconButton>
          <IconButton label="Remove step" onClick={onRemove}>
            ✕
          </IconButton>
        </div>
      </div>

      {step.kind === 'send' && (
        <MessageList
          scenario={scenario}
          step={step}
          onChange={(messages) => onChange({ ...step, messages })}
        />
      )}
    </div>
  )
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={!onClick}
      className="rounded px-1.5 py-0.5 text-xs text-dim transition-colors hover:bg-surface-sunken hover:text-strong disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  )
}

function MessageList({
  scenario,
  step,
  onChange,
}: {
  scenario: Scenario
  step: Extract<EditorStep, { kind: 'send' }>
  onChange: (messages: MessageEditor[]) => void
}) {
  const peer = scenario[step.from]
  const kinds = (Object.keys(MESSAGE_LABELS) as MessageEditor['kind'][]).filter((k) => k !== 'raw')

  return (
    <div className="border-t border-hair bg-surface-sunken px-3 py-2">
      <p className="mb-2 text-[11px] text-dim">
        Sent as one write — messages that fit share a TCP segment.
      </p>

      <div className="flex flex-col gap-2">
        {step.messages.map((message, index) => (
          <MessageRow
            key={index}
            message={message}
            onChange={(next) => onChange(step.messages.map((m, i) => (i === index ? next : m)))}
            onRemove={() => onChange(step.messages.filter((_, i) => i !== index))}
          />
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-dim">Add:</span>
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => onChange([...step.messages, newMessage(kind, peer.ip, peer.as)])}
            className="rounded border border-hair px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-hair-strong hover:text-strong"
          >
            + {MESSAGE_LABELS[kind]}
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageRow({
  message,
  onChange,
  onRemove,
}: {
  message: MessageEditor
  onChange: (message: MessageEditor) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded border border-hair bg-surface p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-medium text-strong">
          {message.kind === 'raw' ? message.label : MESSAGE_LABELS[message.kind]}
        </span>
        <div className="ml-auto">
          <IconButton label="Remove message" onClick={onRemove}>
            ✕
          </IconButton>
        </div>
      </div>

      {message.kind === 'announce' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Prefixes">
              <textarea
                rows={2}
                className={`${CONTROL} font-mono`}
                value={message.prefixes}
                onChange={(e) => onChange({ ...message, prefixes: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Next hop">
            <input
              type="text"
              className={`${CONTROL} font-mono`}
              value={message.nextHop}
              onChange={(e) => onChange({ ...message, nextHop: e.target.value })}
            />
          </Field>
          <Field label="AS path" hint="Left to right, nearest AS first">
            <input
              type="text"
              className={`${CONTROL} font-mono`}
              value={message.asPath}
              onChange={(e) => onChange({ ...message, asPath: e.target.value })}
            />
          </Field>
          <Field label="Origin">
            <select
              className={CONTROL}
              value={message.origin}
              onChange={(e) =>
                onChange({ ...message, origin: e.target.value as 'IGP' | 'EGP' | 'INCOMPLETE' })
              }
            >
              <option value="IGP">IGP</option>
              <option value="EGP">EGP</option>
              <option value="INCOMPLETE">INCOMPLETE</option>
            </select>
          </Field>
          <Field label="MED">
            <input
              type="text"
              inputMode="numeric"
              className={`${CONTROL} font-mono`}
              placeholder="none"
              value={message.med}
              onChange={(e) => onChange({ ...message, med: e.target.value })}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Communities" hint="65000:100, NO_EXPORT, …">
              <input
                type="text"
                className={`${CONTROL} font-mono`}
                placeholder="none"
                value={message.communities}
                onChange={(e) => onChange({ ...message, communities: e.target.value })}
              />
            </Field>
          </div>
        </div>
      )}

      {message.kind === 'withdraw' && (
        <Field label="Prefixes">
          <textarea
            rows={2}
            className={`${CONTROL} font-mono`}
            value={message.prefixes}
            onChange={(e) => onChange({ ...message, prefixes: e.target.value })}
          />
        </Field>
      )}

      {message.kind === 'end-of-rib' && (
        <p className="text-[11px] text-dim">
          An empty UPDATE — the marker that the initial advertisement is complete (RFC 4724).
        </p>
      )}

      {message.kind === 'notification' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Error code">
            <input
              type="text"
              inputMode="numeric"
              className={`${CONTROL} font-mono`}
              value={message.errorCode}
              onChange={(e) => onChange({ ...message, errorCode: e.target.value })}
            />
          </Field>
          <Field label="Subcode">
            <input
              type="text"
              inputMode="numeric"
              className={`${CONTROL} font-mono`}
              value={message.errorSubcode}
              onChange={(e) => onChange({ ...message, errorSubcode: e.target.value })}
            />
          </Field>
        </div>
      )}

      {message.kind === 'route-refresh' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="AFI">
            <input
              type="text"
              inputMode="numeric"
              className={`${CONTROL} font-mono`}
              value={message.afi}
              onChange={(e) => onChange({ ...message, afi: e.target.value })}
            />
          </Field>
          <Field label="SAFI">
            <input
              type="text"
              inputMode="numeric"
              className={`${CONTROL} font-mono`}
              value={message.safi}
              onChange={(e) => onChange({ ...message, safi: e.target.value })}
            />
          </Field>
        </div>
      )}

      {message.kind === 'raw' && (
        <p className="text-[11px] text-dim">
          Built as specified. This message has no form here, so it is kept as it was.
        </p>
      )}
    </div>
  )
}

function SideBadge({ side }: { side: Side }) {
  return (
    <span className="rounded bg-accent-subtle px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-accent">
      Peer {side}
    </span>
  )
}
