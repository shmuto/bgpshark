/**
 * The shape the builder screen edits, and its translation to and from a
 * `Scenario`.
 *
 * A `Scenario` is the right thing to build a capture from and the wrong thing
 * to put in front of a form: its messages are full specifications, so an
 * advertisement is an UPDATE carrying an ORIGIN, an AS_PATH, a NEXT_HOP and a
 * list of prefixes, and asking someone to fill that in field by field is asking
 * them to do the encoder's job. The editor model is the same session described
 * the way an operator would say it out loud — "announce these prefixes with
 * this AS path" — and everything derived from that is filled in on the way out.
 *
 * Conversion runs both ways so a preset can be opened and then edited. Messages
 * the editor has no form for survive as `raw`: they are still built, still
 * shown, and simply not editable here, which is better than refusing to open
 * the scenario at all.
 */
import type { BgpMessageSpec, PathAttributeSpec } from '../../lib/build'
import type { Scenario, ScenarioStep, Side } from '../../lib/build'

export type MessageEditor =
  | {
      kind: 'announce'
      prefixes: string
      nextHop: string
      asPath: string
      origin: 'IGP' | 'EGP' | 'INCOMPLETE'
      med: string
      communities: string
    }
  | { kind: 'withdraw'; prefixes: string }
  | { kind: 'end-of-rib' }
  | { kind: 'notification'; errorCode: string; errorSubcode: string }
  | { kind: 'route-refresh'; afi: string; safi: string }
  /** A message with no form here — from a preset, and preserved verbatim. */
  | { kind: 'raw'; label: string; message: BgpMessageSpec }

export type EditorStep = { id: string; gap?: number } & (
  | { kind: 'handshake' }
  | { kind: 'open'; from: Side }
  | { kind: 'keepalive'; from: Side }
  | { kind: 'send'; from: Side; messages: MessageEditor[] }
  | { kind: 'close'; from: Side }
  | { kind: 'reset'; from: Side }
  | { kind: 'delay'; gap: number }
)

export type EditorStepKind = EditorStep['kind']

let nextId = 0
export function stepId(): string {
  nextId += 1
  return `step-${nextId}`
}

// ---------------------------------------------------------------------------
// Editor → Scenario
// ---------------------------------------------------------------------------

/** Split a comma, space or newline separated list, dropping the empties. */
export function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function toNumbers(text: string): number[] {
  return splitList(text).map((item) => {
    const value = Number(item)
    if (!Number.isFinite(value) || value < 0) throw new Error(`Not a number: "${item}"`)
    return value
  })
}

function toMessage(editor: MessageEditor): BgpMessageSpec {
  switch (editor.kind) {
    case 'announce': {
      const asNumbers = toNumbers(editor.asPath)

      const attributes: PathAttributeSpec[] = [
        { type: 'ORIGIN', value: editor.origin },
        // An empty AS path is a zero-length attribute with no segments at all,
        // which is what a route originated inside the AS carries. A segment
        // holding no AS numbers would be a different thing, and an invalid one.
        {
          type: 'AS_PATH',
          segments: asNumbers.length > 0 ? [{ type: 'AS_SEQUENCE', asNumbers }] : [],
        },
        { type: 'NEXT_HOP', address: editor.nextHop },
      ]

      if (editor.med.trim()) {
        attributes.push({ type: 'MULTI_EXIT_DISC', value: Number(editor.med) })
      }
      if (editor.communities.trim()) {
        attributes.push({ type: 'COMMUNITIES', communities: splitList(editor.communities) })
      }

      return { type: 'UPDATE', pathAttributes: attributes, nlri: splitList(editor.prefixes) }
    }

    case 'withdraw':
      return { type: 'UPDATE', withdrawnRoutes: splitList(editor.prefixes) }

    case 'end-of-rib':
      return { type: 'UPDATE' }

    case 'notification':
      return {
        type: 'NOTIFICATION',
        errorCode: Number(editor.errorCode) || 0,
        errorSubcode: Number(editor.errorSubcode) || 0,
      }

    case 'route-refresh':
      return { type: 'ROUTE_REFRESH', afi: Number(editor.afi) || 1, safi: Number(editor.safi) || 1 }

    case 'raw':
      return editor.message
  }
}

export function toScenarioSteps(steps: EditorStep[]): ScenarioStep[] {
  return steps.map((step): ScenarioStep => {
    switch (step.kind) {
      case 'handshake':
        return { kind: 'handshake', gap: step.gap }
      case 'open':
        return { kind: 'open', from: step.from, gap: step.gap }
      case 'keepalive':
        return { kind: 'keepalive', from: step.from, gap: step.gap }
      case 'send':
        return { kind: 'send', from: step.from, messages: step.messages.map(toMessage), gap: step.gap }
      case 'close':
        return { kind: 'close', from: step.from, gap: step.gap }
      case 'reset':
        return { kind: 'reset', from: step.from, gap: step.gap }
      case 'delay':
        return { kind: 'delay', gap: step.gap }
    }
  })
}

// ---------------------------------------------------------------------------
// Scenario → editor
// ---------------------------------------------------------------------------

function attributeOf<T extends PathAttributeSpec['type']>(
  attributes: PathAttributeSpec[] | undefined,
  type: T
): Extract<PathAttributeSpec, { type: T }> | undefined {
  return attributes?.find((attribute) => attribute.type === type) as
    | Extract<PathAttributeSpec, { type: T }>
    | undefined
}

function prefixText(prefixes: ReadonlyArray<string | { prefix: string }> | undefined): string {
  return (prefixes ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.prefix)).join(', ')
}

/**
 * Recognise the messages the editor has forms for. Anything else — an MP_REACH
 * advertisement, an UPDATE with attributes no form covers — becomes `raw` with
 * a label describing it, rather than being flattened into a shape that would
 * quietly change what the scenario builds.
 */
function toMessageEditor(message: BgpMessageSpec): MessageEditor {
  if (message.type === 'NOTIFICATION') {
    return {
      kind: 'notification',
      errorCode: String(message.errorCode),
      errorSubcode: String(message.errorSubcode),
    }
  }

  if (message.type === 'ROUTE_REFRESH') {
    return { kind: 'route-refresh', afi: String(message.afi), safi: String(message.safi) }
  }

  if (message.type !== 'UPDATE') {
    return { kind: 'raw', label: message.type, message }
  }

  const hasAttributes = (message.pathAttributes?.length ?? 0) > 0
  const hasNlri = (message.nlri?.length ?? 0) > 0
  const hasWithdrawn = (message.withdrawnRoutes?.length ?? 0) > 0

  if (!hasAttributes && !hasNlri && !hasWithdrawn) {
    return { kind: 'end-of-rib' }
  }

  if (!hasAttributes && hasWithdrawn && !hasNlri) {
    return { kind: 'withdraw', prefixes: prefixText(message.withdrawnRoutes) }
  }

  const nextHop = attributeOf(message.pathAttributes, 'NEXT_HOP')
  const asPath = attributeOf(message.pathAttributes, 'AS_PATH')
  const known = new Set(['ORIGIN', 'AS_PATH', 'NEXT_HOP', 'MULTI_EXIT_DISC', 'COMMUNITIES'])
  const editable =
    hasNlri &&
    !hasWithdrawn &&
    nextHop !== undefined &&
    (message.pathAttributes ?? []).every((attribute) => known.has(attribute.type))

  if (!editable) {
    return { kind: 'raw', label: describeUpdate(message), message }
  }

  return {
    kind: 'announce',
    prefixes: prefixText(message.nlri),
    nextHop: nextHop.address,
    asPath: (asPath?.segments ?? []).flatMap((segment) => segment.asNumbers).join(' '),
    origin: attributeOf(message.pathAttributes, 'ORIGIN')?.value ?? 'IGP',
    med: String(attributeOf(message.pathAttributes, 'MULTI_EXIT_DISC')?.value ?? ''),
    communities: (attributeOf(message.pathAttributes, 'COMMUNITIES')?.communities ?? []).join(' '),
  }
}

function describeUpdate(message: Extract<BgpMessageSpec, { type: 'UPDATE' }>): string {
  const mpReach = attributeOf(message.pathAttributes, 'MP_REACH_NLRI')
  if (mpReach) return `UPDATE — MP_REACH ${mpReach.nlri.length} prefix(es)`

  const mpUnreach = attributeOf(message.pathAttributes, 'MP_UNREACH_NLRI')
  if (mpUnreach) return `UPDATE — MP_UNREACH ${mpUnreach.withdrawnRoutes.length} prefix(es)`

  return 'UPDATE'
}

export function toEditorSteps(steps: ScenarioStep[]): EditorStep[] {
  return steps.map((step): EditorStep => {
    const id = stepId()

    switch (step.kind) {
      case 'handshake':
        return { id, kind: 'handshake', gap: step.gap }
      case 'open':
        return { id, kind: 'open', from: step.from, gap: step.gap }
      case 'keepalive':
        return { id, kind: 'keepalive', from: step.from, gap: step.gap }
      case 'send':
        return { id, kind: 'send', from: step.from, gap: step.gap, messages: step.messages.map(toMessageEditor) }
      case 'close':
        return { id, kind: 'close', from: step.from, gap: step.gap }
      case 'reset':
        return { id, kind: 'reset', from: step.from, gap: step.gap }
      case 'delay':
        return { id, kind: 'delay', gap: step.gap }
    }
  })
}

// ---------------------------------------------------------------------------
// Defaults for newly added rows
// ---------------------------------------------------------------------------

export function newMessage(kind: MessageEditor['kind'], nextHop: string, as: number): MessageEditor {
  switch (kind) {
    case 'announce':
      return {
        kind: 'announce',
        prefixes: '10.1.0.0/24',
        nextHop,
        asPath: String(as),
        origin: 'IGP',
        med: '',
        communities: '',
      }
    case 'withdraw':
      return { kind: 'withdraw', prefixes: '10.1.0.0/24' }
    case 'end-of-rib':
      return { kind: 'end-of-rib' }
    case 'notification':
      return { kind: 'notification', errorCode: '6', errorSubcode: '2' }
    case 'route-refresh':
      return { kind: 'route-refresh', afi: '1', safi: '1' }
    case 'raw':
      return { kind: 'raw', label: 'KEEPALIVE', message: { type: 'KEEPALIVE' } }
  }
}

export function newStep(kind: EditorStepKind, scenario: Scenario): EditorStep {
  const id = stepId()

  switch (kind) {
    case 'handshake':
      return { id, kind: 'handshake' }
    case 'open':
      return { id, kind: 'open', from: 'a' }
    case 'keepalive':
      return { id, kind: 'keepalive', from: 'a' }
    case 'send':
      return { id, kind: 'send', from: 'a', messages: [newMessage('announce', scenario.a.ip, scenario.a.as)] }
    case 'close':
      return { id, kind: 'close', from: 'a' }
    case 'reset':
      return { id, kind: 'reset', from: 'b' }
    case 'delay':
      return { id, kind: 'delay', gap: 30_000 }
  }
}

export const STEP_LABELS: Record<EditorStepKind, string> = {
  handshake: 'TCP handshake',
  open: 'OPEN',
  keepalive: 'KEEPALIVE',
  send: 'Send messages',
  close: 'TCP close (FIN)',
  reset: 'TCP reset (RST)',
  delay: 'Wait',
}

export const MESSAGE_LABELS: Record<MessageEditor['kind'], string> = {
  announce: 'Announce routes',
  withdraw: 'Withdraw routes',
  'end-of-rib': 'End-of-RIB',
  notification: 'NOTIFICATION',
  'route-refresh': 'ROUTE-REFRESH',
  raw: 'Other',
}
