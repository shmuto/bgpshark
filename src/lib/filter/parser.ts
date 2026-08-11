import type {
  BgpPacket,
  BgpOpenMessage,
  BgpPrefix,
  BgpUpdateMessage,
  AsPathAttribute,
  CommunitiesAttribute,
  ExtendedCommunitiesAttribute,
  LargeCommunitiesAttribute,
  NextHopAttribute,
  OriginAttribute,
  MpReachNlriAttribute,
  MpUnreachNlriAttribute,
} from '../bgp/types'
import type { EvpnRoute } from '../bgp/evpn'
import type { ExtendedCommunity } from '../bgp/extended-communities'
import { formatExtendedCommunity } from '../bgp/extended-communities'
import { contains, formatPrefix, parseBgpPrefix, parsePrefix } from '../net/prefix'

// =============================================================================
// Token Types
// =============================================================================

export type Token =
  | { type: 'field'; value: string }
  | { type: 'operator'; value: Operator }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'and' }
  | { type: 'or' }
  | { type: 'not' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' }
  | { type: 'eof' }

// Ordered comparisons only exist for integer fields — see NUMERIC_FIELDS.
export type OrderedOperator = '<' | '<=' | '>' | '>='
export type MatchOperator = '=' | '!=' | 'contains' | 'not contains'
export type Operator = MatchOperator | OrderedOperator

export function isOrderedOperator(operator: Operator): operator is OrderedOperator {
  return operator === '<' || operator === '<=' || operator === '>' || operator === '>='
}

// =============================================================================
// AST Types
// =============================================================================

export type Expression = AndExpression | OrExpression | NotExpression | Comparison

export interface AndExpression {
  type: 'and'
  left: Expression
  right: Expression
}

export interface OrExpression {
  type: 'or'
  left: Expression
  right: Expression
}

export interface NotExpression {
  type: 'not'
  expr: Expression
}

export interface Comparison {
  type: 'comparison'
  field: string
  operator: Operator
  value: FilterValue
}

export type FilterValue = string | number | number[] | string[]

// =============================================================================
// Filter Fields Configuration
// =============================================================================

export const FILTER_FIELDS = {
  // Packet-level fields (SQL: packets table)
  type: {
    description: 'Message type',
    values: ['OPEN', 'UPDATE', 'NOTIFICATION', 'KEEPALIVE', 'ROUTE_REFRESH'],
    valueType: 'string' as const,
  },
  src_ip: {
    description: 'Source IP (packets.src_ip)',
    values: [] as string[],
    valueType: 'string' as const,
  },
  dst_ip: {
    description: 'Destination IP (packets.dst_ip)',
    values: [] as string[],
    valueType: 'string' as const,
  },
  src_port: {
    description: 'TCP source port — one side of a session; both: src_port = 179 or dst_port = 179',
    values: [] as string[],
    valueType: 'number' as const,
  },
  dst_port: {
    description: 'TCP destination port — pairs with src_port to separate colliding sessions',
    values: [] as string[],
    valueType: 'number' as const,
  },
  frame: {
    description: 'Frame number (the # column) — ranges with < <= > >=, e.g. frame >= 100',
    values: [] as string[],
    valueType: 'number' as const,
  },

  // Message-level fields (SQL: messages table)
  router_id: {
    description: 'Router ID (messages.router_id)',
    values: [] as string[],
    valueType: 'string' as const,
  },
  src_as: {
    description: 'Source AS (from OPEN message)',
    values: [] as string[],
    valueType: 'number' as const,
  },
  asn: {
    description: 'AS in AS_PATH (as_path.asn)',
    values: [] as string[],
    valueType: 'number' as const,
  },

  // Path attributes (SQL: path_attributes table)
  origin: {
    description: 'Origin (path_attributes.origin_value)',
    values: ['IGP', 'EGP', 'INCOMPLETE'],
    valueType: 'string' as const,
  },
  next_hop: {
    description: 'Next Hop (path_attributes.next_hop)',
    values: [] as string[],
    valueType: 'string' as const,
  },

  // Prefixes (SQL: nlri, withdrawn tables)
  prefix: {
    description: 'NLRI prefix (nlri.prefix)',
    values: [] as string[],
    valueType: 'string' as const,
  },
  withdrawn: {
    description: 'Withdrawn prefix (withdrawn.prefix)',
    values: [] as string[],
    valueType: 'string' as const,
  },

  // Communities (SQL: communities table)
  community: {
    description: 'Community (communities.formatted)',
    values: [] as string[],
    valueType: 'string' as const,
  },

  // Extended communities (SQL: extended_communities table)
  rt: {
    description: 'Route Target, e.g. rt = 65001:100 — what decides which VRF a route lands in',
    values: [] as string[],
    valueType: 'string' as const,
  },
  ext_community: {
    description: 'Extended community as displayed, e.g. ext_community contains "MAC Mobility"',
    values: [] as string[],
    valueType: 'string' as const,
  },

  // EVPN routes (SQL: nlri, withdrawn tables)
  mac: {
    description: 'MAC in an EVPN route — follows one host, announced or withdrawn',
    values: [] as string[],
    valueType: 'string' as const,
  },
  vni: {
    description: 'VNI carried by an EVPN route — narrows a capture to one bridge domain',
    values: [] as string[],
    valueType: 'number' as const,
  },
  rd: {
    description: 'Route Distinguisher of an EVPN route, e.g. rd = 10.0.0.1:100',
    values: [] as string[],
    valueType: 'string' as const,
  },
  evpn_type: {
    description: 'EVPN route type: 1 A-D, 2 MAC/IP, 3 IMET, 4 Ethernet Segment, 5 IP Prefix',
    values: [] as string[],
    valueType: 'number' as const,
  },

  // Capabilities (SQL: capabilities table)
  capability: {
    description: 'Capability (capabilities.name)',
    values: [] as string[],
    valueType: 'string' as const,
  },
} as const

// Aliases for backwards compatibility (old name -> canonical name)
export const FIELD_ALIASES: Record<string, string> = {
  src: 'src_ip',
  dst: 'dst_ip',
  'router-id': 'router_id',
  my_as: 'src_as', // backwards compat
  as: 'src_as',
  aspath: 'asn',
  nexthop: 'next_hop',
  nlri: 'prefix',
  'large-community': 'community', // Same handling as community
  'route-target': 'rt',
  route_target: 'rt',
  'ext-community': 'ext_community',
  extcommunity: 'ext_community',
  'evpn-type': 'evpn_type',
  evpn: 'evpn_type',
}

export type FilterFieldName = keyof typeof FILTER_FIELDS

// All valid field names (canonical + aliases)
const FIELD_NAMES = [...Object.keys(FILTER_FIELDS), ...Object.keys(FIELD_ALIASES)]

// Normalize field name (resolve alias to canonical name)
export function normalizeFieldName(field: string): string {
  return FIELD_ALIASES[field] || field
}

// Fields whose values are plain integers. Only these accept < <= > >=; ordering
// text would have to invent a collation that neither evaluator could agree on.
const NUMERIC_FIELDS = new Set(
  Object.entries(FILTER_FIELDS)
    .filter(([, def]) => def.valueType === 'number')
    .map(([name]) => name)
)

export function isNumericField(field: string): boolean {
  return NUMERIC_FIELDS.has(normalizeFieldName(field))
}

// =============================================================================
// Tokenizer
// =============================================================================

export class Tokenizer {
  private input: string
  private pos: number = 0
  private tokens: Token[] = []

  constructor(input: string) {
    this.input = input
  }

  tokenize(): Token[] {
    while (this.pos < this.input.length) {
      this.skipWhitespace()
      if (this.pos >= this.input.length) break

      const char = this.input[this.pos]

      if (char === '(') {
        this.tokens.push({ type: 'lparen' })
        this.pos++
      } else if (char === ')') {
        this.tokens.push({ type: 'rparen' })
        this.pos++
      } else if (char === ',') {
        this.tokens.push({ type: 'comma' })
        this.pos++
      } else if (char === '=' || (char === '!' && this.peek(1) === '=')) {
        if (char === '!') {
          this.tokens.push({ type: 'operator', value: '!=' })
          this.pos += 2
        } else {
          this.tokens.push({ type: 'operator', value: '=' })
          this.pos++
        }
      } else if (char === '<' || char === '>') {
        const operator = (this.peek(1) === '=' ? `${char}=` : char) as Operator
        this.tokens.push({ type: 'operator', value: operator })
        this.pos += operator.length
      } else if (char === '"' || char === "'") {
        this.tokens.push({ type: 'string', value: this.readQuoted() })
      } else if (this.isDigit(char)) {
        // Could be a number, IP address, or prefix (e.g., 192.168.1.1 or 10.0.0.0/8)
        const value = this.readNumberOrIp()
        if (typeof value === 'number') {
          this.tokens.push({ type: 'number', value })
        } else {
          this.tokens.push({ type: 'string', value })
        }
      } else if (this.isWordChar(char)) {
        this.readWord()
      } else {
        // Unknown character, skip
        this.pos++
      }
    }

    this.tokens.push({ type: 'eof' })
    return this.tokens
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
      this.pos++
    }
  }

  private peek(offset: number = 0): string {
    return this.input[this.pos + offset] || ''
  }

  private isDigit(char: string): boolean {
    return /[0-9]/.test(char)
  }

  private isWordChar(char: string): boolean {
    return /[\w\-.:/]/.test(char)
  }

  private readQuoted(): string {
    const quote = this.input[this.pos]
    this.pos++ // skip opening quote
    let value = ''
    while (this.pos < this.input.length && this.input[this.pos] !== quote) {
      if (this.input[this.pos] === '\\' && this.pos + 1 < this.input.length) {
        this.pos++
        value += this.input[this.pos]
      } else {
        value += this.input[this.pos]
      }
      this.pos++
    }
    this.pos++ // skip closing quote
    return value
  }

  private readNumberOrIp(): number | string {
    let str = ''
    let hasDot = false
    let hasSlash = false
    let hasColon = false

    // Read digits, dots, colons (IPv6), and slashes (prefix notation)
    while (this.pos < this.input.length) {
      const char = this.input[this.pos]
      if (this.isDigit(char)) {
        str += char
        this.pos++
      } else if (char === '.') {
        hasDot = true
        str += char
        this.pos++
      } else if (char === '/') {
        hasSlash = true
        str += char
        this.pos++
      } else if (char === ':') {
        hasColon = true
        str += char
        this.pos++
      } else if (hasColon && /[a-fA-F]/.test(char)) {
        // IPv6 hex digits
        str += char
        this.pos++
      } else {
        break
      }
    }

    // If it contains dots, colons, or slashes, treat as string (IP address or prefix)
    if (hasDot || hasSlash || hasColon) {
      return str
    }

    // Pure number
    return parseInt(str, 10)
  }

  private readWord(): void {
    let word = ''
    while (this.pos < this.input.length && this.isWordChar(this.input[this.pos])) {
      word += this.input[this.pos]
      this.pos++
    }

    const lower = word.toLowerCase()

    if (lower === 'and') {
      this.tokens.push({ type: 'and' })
    } else if (lower === 'or') {
      this.tokens.push({ type: 'or' })
    } else if (lower === 'not') {
      // Check if followed by 'contains'
      this.skipWhitespace()
      const savedPos = this.pos
      let nextWord = ''
      while (this.pos < this.input.length && this.isWordChar(this.input[this.pos])) {
        nextWord += this.input[this.pos]
        this.pos++
      }
      if (nextWord.toLowerCase() === 'contains') {
        this.tokens.push({ type: 'operator', value: 'not contains' })
      } else {
        // Revert and push 'not' as logical operator
        this.pos = savedPos
        this.tokens.push({ type: 'not' })
      }
    } else if (lower === 'contains') {
      this.tokens.push({ type: 'operator', value: 'contains' })
    } else if (FIELD_NAMES.includes(lower)) {
      this.tokens.push({ type: 'field', value: lower })
    } else {
      // Treat as string value
      this.tokens.push({ type: 'string', value: word })
    }
  }
}

// =============================================================================
// Recursive Descent Parser
// =============================================================================

export interface ParseError {
  message: string
  position: number
}

export class Parser {
  private tokens: Token[]
  private pos: number = 0
  private errors: ParseError[] = []

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  parse(): Expression | null {
    if (this.current().type === 'eof') {
      return null
    }
    const expr = this.parseOr()

    // Check for unconsumed tokens (except eof)
    if (this.current().type !== 'eof') {
      this.addError(`Unexpected token: ${this.tokenToString(this.current())}`)
    }

    return expr
  }

  getErrors(): ParseError[] {
    return this.errors
  }

  private addError(message: string): void {
    this.errors.push({ message, position: this.pos })
  }

  private tokenToString(token: Token): string {
    switch (token.type) {
      case 'field':
      case 'string':
        return `"${token.value}"`
      case 'number':
        return String(token.value)
      case 'operator':
        return token.value
      case 'and':
        return 'and'
      case 'or':
        return 'or'
      case 'not':
        return 'not'
      case 'lparen':
        return '('
      case 'rparen':
        return ')'
      case 'comma':
        return ','
      case 'eof':
        return 'end of input'
    }
  }

  private current(): Token {
    return this.tokens[this.pos] || { type: 'eof' }
  }

  private advance(): Token {
    const token = this.current()
    this.pos++
    return token
  }

  private parseOr(): Expression {
    let left = this.parseAnd()

    while (this.current().type === 'or') {
      this.advance() // consume 'or'
      const right = this.parseAnd()
      left = { type: 'or', left, right }
    }

    return left
  }

  private parseAnd(): Expression {
    let left = this.parseUnary()

    while (this.current().type === 'and') {
      this.advance() // consume 'and'
      const right = this.parseUnary()
      left = { type: 'and', left, right }
    }

    return left
  }

  private parseUnary(): Expression {
    if (this.current().type === 'not') {
      this.advance() // consume 'not'
      const expr = this.parseUnary()
      return { type: 'not', expr }
    }

    return this.parsePrimary()
  }

  private parsePrimary(): Expression {
    // Handle parentheses
    if (this.current().type === 'lparen') {
      this.advance() // consume '('
      const expr = this.parseOr()
      if (this.current().type === 'rparen') {
        this.advance() // consume ')'
      }
      return expr
    }

    // Handle comparison: field operator value
    return this.parseComparison()
  }

  private parseComparison(): Comparison {
    const fieldToken = this.advance()
    if (fieldToken.type !== 'field') {
      this.addError(`Expected field name, got ${this.tokenToString(fieldToken)}`)
      return { type: 'comparison', field: '', operator: '=', value: '' }
    }

    const field = fieldToken.value

    const opToken = this.advance()
    if (opToken.type !== 'operator') {
      this.addError(`Expected operator after "${field}", got ${this.tokenToString(opToken)}`)
      return { type: 'comparison', field, operator: '=', value: '' }
    }

    const operator = opToken.value

    const value = this.parseValue()

    if (value === '') {
      this.addError(`Expected value after "${field} ${operator}"`)
    } else if (isOrderedOperator(operator)) {
      // Both evaluators can only order integers, so the combination is rejected
      // here rather than silently matching nothing.
      if (!isNumericField(field)) {
        this.addError(
          `Operator "${operator}" is only valid for numeric fields (${[...NUMERIC_FIELDS].join(', ')}), got "${field}"`
        )
      } else if (typeof coerceNumericValue(value) !== 'number') {
        this.addError(`Expected a number after "${field} ${operator}"`)
      }
    }

    return { type: 'comparison', field, operator, value }
  }

  private parseValue(): FilterValue {
    const values: (string | number)[] = []

    // Read first value
    const firstValue = this.parseSingleValue()
    if (firstValue !== null) {
      values.push(firstValue)
    }

    // Check for comma-separated values
    while (this.current().type === 'comma') {
      this.advance() // consume ','
      const nextValue = this.parseSingleValue()
      if (nextValue !== null) {
        values.push(nextValue)
      }
    }

    if (values.length === 0) {
      return ''
    }

    if (values.length === 1) {
      return values[0]
    }

    // Multiple values - return as array
    if (typeof values[0] === 'number') {
      return values as number[]
    }
    return values as string[]
  }

  private parseSingleValue(): string | number | null {
    const token = this.current()
    if (token.type === 'string') {
      this.advance()
      return token.value
    }
    if (token.type === 'number') {
      this.advance()
      return token.value
    }
    return null
  }
}

// =============================================================================
// Expression Evaluator
// =============================================================================

export function evaluate(expr: Expression | null, packet: BgpPacket): boolean {
  if (expr === null) return true

  switch (expr.type) {
    case 'and':
      return evaluate(expr.left, packet) && evaluate(expr.right, packet)
    case 'or':
      return evaluate(expr.left, packet) || evaluate(expr.right, packet)
    case 'not':
      return !evaluate(expr.expr, packet)
    case 'comparison':
      return evaluateComparison(expr, packet)
  }
}

function evaluateComparison(expr: Comparison, packet: BgpPacket): boolean {
  const { operator, value } = expr
  // Normalize field name to handle aliases
  const field = normalizeFieldName(expr.field)

  if (isOrderedOperator(operator)) {
    return evaluateOrderedComparison(field, operator, value, packet)
  }

  switch (field) {
    case 'type':
      // Match if any message matches the type
      return packet.messages.some((msg) => matchString(msg.type, operator, value))

    case 'src_ip':
      return matchIpAddress(packet.srcIp, operator, value)

    case 'dst_ip':
      return matchIpAddress(packet.dstIp, operator, value)

    case 'src_port':
      return matchNumber(packet.srcPort, operator, value)

    case 'dst_port':
      return matchNumber(packet.dstPort, operator, value)

    case 'frame':
      return matchNumber(packet.frameIndex, operator, value)

    case 'router_id':
      for (const msg of packet.messages) {
        if (msg.type !== 'OPEN') continue
        if (matchString((msg as BgpOpenMessage).bgpIdentifier, operator, value)) return true
      }
      return false

    case 'capability':
      for (const msg of packet.messages) {
        if (msg.type !== 'OPEN') continue
        const caps = (msg as BgpOpenMessage).capabilities.map((c) => c.name)
        if (matchStringArray(caps, operator, value)) return true
      }
      return false

    case 'src_as':
      for (const msg of packet.messages) {
        if (msg.type !== 'OPEN') continue
        const openMsg = msg as BgpOpenMessage
        const asNum = openMsg.fourByteAs ?? openMsg.myAs
        if (matchNumber(asNum, operator, value)) return true
      }
      return false

    case 'asn':
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const aspath = getAsPath(msg as BgpUpdateMessage)
        if (matchNumberArray(aspath, operator, value)) return true
      }
      return false

    case 'origin':
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const origin = getOrigin(msg as BgpUpdateMessage)
        if (origin && matchString(origin, operator, value)) return true
      }
      return false

    case 'next_hop':
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const nexthop = getNextHop(msg as BgpUpdateMessage)
        if (nexthop && matchString(nexthop, operator, value)) return true
      }
      return false

    case 'community':
      // Handle both standard and large communities
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const communities = getCommunities(msg as BgpUpdateMessage)
        const largeCommunities = getLargeCommunities(msg as BgpUpdateMessage)
        if (matchStringArray([...communities, ...largeCommunities], operator, value)) return true
      }
      return false

    case 'rt':
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const targets = getExtendedCommunities(msg as BgpUpdateMessage)
          .filter((c) => c.kind === 'Route Target')
          .map((c) => c.value)
        if (matchStringArray(targets, operator, value)) return true
      }
      return false

    case 'ext_community':
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const formatted = getExtendedCommunities(msg as BgpUpdateMessage).map(
          formatExtendedCommunity
        )
        if (matchStringArray(formatted, operator, value)) return true
      }
      return false

    // The EVPN fields look at announced and withdrawn routes alike: following a
    // MAC through a move means seeing the withdrawal as much as the new route.
    case 'mac':
      for (const route of evpnRoutes(packet)) {
        if (route.macAddress && matchString(route.macAddress, operator, value)) return true
      }
      return false

    case 'rd':
      for (const route of evpnRoutes(packet)) {
        if (matchString(route.rd, operator, value)) return true
      }
      return false

    case 'vni':
      for (const route of evpnRoutes(packet)) {
        if (route.label !== undefined && matchNumber(route.label, operator, value)) return true
        if (route.label2 !== undefined && matchNumber(route.label2, operator, value)) return true
      }
      return false

    case 'evpn_type':
      for (const route of evpnRoutes(packet)) {
        if (matchNumber(route.routeType, operator, value)) return true
      }
      return false

    case 'prefix':
      // Match both announced (NLRI) and withdrawn prefixes
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const update = msg as BgpUpdateMessage
        const nlriPrefixes = getNlriPrefixes(update)
        const withdrawnPrefixes = getWithdrawnPrefixes(update)
        const allPrefixes = [...nlriPrefixes, ...withdrawnPrefixes]
        if (matchPrefixes(allPrefixes, operator, value)) return true
      }
      return false

    case 'withdrawn':
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const withdrawnPrefixes = getWithdrawnPrefixes(msg as BgpUpdateMessage)
        if (matchPrefixes(withdrawnPrefixes, operator, value)) return true
      }
      return false

    default:
      return false
  }
}

/**
 * Evaluates `<`, `<=`, `>`, `>=`, which only apply to the integer fields.
 *
 * Kept apart from the equality path so the field-by-field matchers keep their
 * four-operator shape, and so the SQL compiler has a single mirror to follow.
 */
function evaluateOrderedComparison(
  field: string,
  operator: OrderedOperator,
  value: FilterValue,
  packet: BgpPacket
): boolean {
  const query = coerceNumericValue(value)
  if (typeof query !== 'number') return false

  switch (field) {
    case 'src_port':
      return compareOrdered(packet.srcPort, operator, query)

    case 'dst_port':
      return compareOrdered(packet.dstPort, operator, query)

    case 'frame':
      return compareOrdered(packet.frameIndex, operator, query)

    case 'src_as':
      for (const msg of packet.messages) {
        if (msg.type !== 'OPEN') continue
        const openMsg = msg as BgpOpenMessage
        const asNum = openMsg.fourByteAs ?? openMsg.myAs
        if (compareOrdered(asNum, operator, query)) return true
      }
      return false

    case 'asn':
      // Any AS in the path satisfying the comparison selects the packet, the
      // same question the EXISTS subquery asks in SQL.
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const aspath = getAsPath(msg as BgpUpdateMessage)
        if (aspath.some((asNum) => compareOrdered(asNum, operator, query))) return true
      }
      return false

    case 'vni':
      for (const route of evpnRoutes(packet)) {
        if (route.label !== undefined && compareOrdered(route.label, operator, query)) return true
        if (route.label2 !== undefined && compareOrdered(route.label2, operator, query)) return true
      }
      return false

    case 'evpn_type':
      for (const route of evpnRoutes(packet)) {
        if (compareOrdered(route.routeType, operator, query)) return true
      }
      return false

    default:
      return false
  }
}

function compareOrdered(fieldValue: number, operator: OrderedOperator, query: number): boolean {
  switch (operator) {
    case '<':
      return fieldValue < query
    case '<=':
      return fieldValue <= query
    case '>':
      return fieldValue > query
    case '>=':
      return fieldValue >= query
  }
}

// =============================================================================
// Helper functions for extracting BGP attributes
// =============================================================================

function getAsPath(msg: BgpUpdateMessage): number[] {
  const attr = msg.pathAttributes.find((a) => a.parsed?.type === 'AS_PATH')
  if (!attr?.parsed || attr.parsed.type !== 'AS_PATH') return []
  const asPathAttr = attr.parsed as AsPathAttribute
  // Flatten all segments into a single array
  return asPathAttr.segments.flatMap((seg) => seg.asNumbers)
}

function getOrigin(msg: BgpUpdateMessage): string | null {
  const attr = msg.pathAttributes.find((a) => a.parsed?.type === 'ORIGIN')
  if (!attr?.parsed || attr.parsed.type !== 'ORIGIN') return null
  return (attr.parsed as OriginAttribute).value
}

function getNextHop(msg: BgpUpdateMessage): string | null {
  // Check NEXT_HOP attribute first
  const nhAttr = msg.pathAttributes.find((a) => a.parsed?.type === 'NEXT_HOP')
  if (nhAttr?.parsed && nhAttr.parsed.type === 'NEXT_HOP') {
    return (nhAttr.parsed as NextHopAttribute).address
  }
  // Check MP_REACH_NLRI for IPv6
  const mpAttr = msg.pathAttributes.find((a) => a.parsed?.type === 'MP_REACH_NLRI')
  if (mpAttr?.parsed && mpAttr.parsed.type === 'MP_REACH_NLRI') {
    return (mpAttr.parsed as MpReachNlriAttribute).nextHop
  }
  return null
}

function getCommunities(msg: BgpUpdateMessage): string[] {
  const attr = msg.pathAttributes.find((a) => a.parsed?.type === 'COMMUNITIES')
  if (!attr?.parsed || attr.parsed.type !== 'COMMUNITIES') return []
  return (attr.parsed as CommunitiesAttribute).communities
}

function getLargeCommunities(msg: BgpUpdateMessage): string[] {
  const attr = msg.pathAttributes.find((a) => a.parsed?.type === 'LARGE_COMMUNITIES')
  if (!attr?.parsed || attr.parsed.type !== 'LARGE_COMMUNITIES') return []
  return (attr.parsed as LargeCommunitiesAttribute).communities.map(
    (c) => `${c.globalAdmin}:${c.localData1}:${c.localData2}`
  )
}

function getExtendedCommunities(msg: BgpUpdateMessage): ExtendedCommunity[] {
  const attr = msg.pathAttributes.find((a) => a.parsed?.type === 'EXTENDED_COMMUNITIES')
  if (!attr?.parsed || attr.parsed.type !== 'EXTENDED_COMMUNITIES') return []
  return (attr.parsed as ExtendedCommunitiesAttribute).communities
}

/**
 * Every EVPN route in the packet, announced and withdrawn together.
 *
 * A MAC move is a withdrawal from one leaf and an advertisement from another,
 * so a filter that only saw announcements would show half of it.
 */
function evpnRoutes(packet: BgpPacket): EvpnRoute[] {
  const routes: EvpnRoute[] = []
  for (const msg of packet.messages) {
    if (msg.type !== 'UPDATE') continue
    const update = msg as BgpUpdateMessage
    for (const prefix of [...getNlriPrefixes(update), ...getWithdrawnPrefixes(update)]) {
      if (prefix.evpn) routes.push(prefix.evpn)
    }
  }
  return routes
}

function getNlriPrefixes(msg: BgpUpdateMessage): BgpPrefix[] {
  const prefixes: BgpPrefix[] = [...msg.nlri]
  // MP_REACH_NLRI for IPv6
  const mpAttr = msg.pathAttributes.find((a) => a.parsed?.type === 'MP_REACH_NLRI')
  if (mpAttr?.parsed && mpAttr.parsed.type === 'MP_REACH_NLRI') {
    prefixes.push(...(mpAttr.parsed as MpReachNlriAttribute).nlri)
  }
  return prefixes
}

function getWithdrawnPrefixes(msg: BgpUpdateMessage): BgpPrefix[] {
  const prefixes: BgpPrefix[] = [...msg.withdrawnRoutes]
  // MP_UNREACH_NLRI for IPv6
  const mpAttr = msg.pathAttributes.find((a) => a.parsed?.type === 'MP_UNREACH_NLRI')
  if (mpAttr?.parsed && mpAttr.parsed.type === 'MP_UNREACH_NLRI') {
    prefixes.push(...(mpAttr.parsed as MpUnreachNlriAttribute).withdrawnRoutes)
  }
  return prefixes
}

// =============================================================================
// Matching functions
// =============================================================================

/**
 * Matches an IP address field, honouring CIDR on the right-hand side.
 *
 * `src_ip = 10.0.0.0/8` asks whether the address falls inside that block, which
 * is what the same expression means once it reaches DuckDB. A plain address is
 * still a plain string comparison.
 */
function matchIpAddress(fieldValue: string, operator: MatchOperator, queryValue: FilterValue): boolean {
  const query = parsePrefix(String(queryValue))
  if (!query?.hasMask) return matchString(fieldValue, operator, queryValue)

  const address = parsePrefix(fieldValue)
  const inside = address !== null && contains(query, address)
  return operator === '=' || operator === 'contains' ? inside : !inside
}

/**
 * Matches announced or withdrawn routes against a prefix search.
 *
 * Same question the route analysis screen asks: a query with a mask selects the
 * routes inside it, a bare address selects the routes that cover it. Text that
 * is not an address at all stays a substring search over `prefix/length`.
 */
function matchPrefixes(prefixes: BgpPrefix[], operator: MatchOperator, queryValue: FilterValue): boolean {
  const query = parsePrefix(String(queryValue))
  if (!query) {
    return matchStringArray(prefixes.map(formatPrefix), operator, queryValue)
  }

  const hit = prefixes.some((prefix) => {
    const route = parseBgpPrefix(prefix)
    if (!route) return false
    return query.hasMask ? contains(query, route) : contains(route, query)
  })
  return operator === '=' || operator === 'contains' ? hit : !hit
}

function matchString(fieldValue: string, operator: MatchOperator, queryValue: FilterValue): boolean {
  const queryStr = String(queryValue).toLowerCase()
  const fieldLower = fieldValue.toLowerCase()

  switch (operator) {
    case '=':
      return fieldLower === queryStr
    case '!=':
      return fieldLower !== queryStr
    case 'contains':
      return fieldLower.includes(queryStr)
    case 'not contains':
      return !fieldLower.includes(queryStr)
  }
}

function matchNumber(fieldValue: number, operator: MatchOperator, queryValue: FilterValue): boolean {
  if (typeof queryValue === 'number') {
    switch (operator) {
      case '=':
        return fieldValue === queryValue
      case '!=':
        return fieldValue !== queryValue
      case 'contains':
      case 'not contains':
        // contains doesn't make sense for single number comparison
        return operator === 'contains' ? fieldValue === queryValue : fieldValue !== queryValue
    }
  }

  // String comparison
  const queryStr = String(queryValue)
  const fieldStr = String(fieldValue)
  switch (operator) {
    case '=':
      return fieldStr === queryStr
    case '!=':
      return fieldStr !== queryStr
    case 'contains':
      return fieldStr.includes(queryStr)
    case 'not contains':
      return !fieldStr.includes(queryStr)
  }
}

function matchNumberArray(fieldValues: number[], operator: MatchOperator, queryValue: FilterValue): boolean {
  // A quoted numeric value ("65001") is equivalent to the bare number
  queryValue = coerceNumericValue(queryValue)

  // Query is a single number
  if (typeof queryValue === 'number') {
    switch (operator) {
      case '=':
        // Exact match: array contains exactly this number only? Or array equals [queryValue]?
        // For aspath, "=" with single value means the path contains this AS
        return fieldValues.includes(queryValue)
      case '!=':
        return !fieldValues.includes(queryValue)
      case 'contains':
        return fieldValues.includes(queryValue)
      case 'not contains':
        return !fieldValues.includes(queryValue)
    }
  }

  // Query is an array of numbers - check for subsequence match
  if (Array.isArray(queryValue) && queryValue.every((v) => typeof v === 'number')) {
    const queryNums = queryValue as number[]
    switch (operator) {
      case '=':
        // Exact sequence match
        return arraysEqual(fieldValues, queryNums)
      case '!=':
        return !arraysEqual(fieldValues, queryNums)
      case 'contains':
        // Contains as subsequence
        return containsSubsequence(fieldValues, queryNums)
      case 'not contains':
        return !containsSubsequence(fieldValues, queryNums)
    }
  }

  return false
}

/**
 * Numeric fields accept quoted values, e.g. `asn = "65001"` from the value dropdown.
 * Convert those to real numbers so numeric matching applies; leave anything else as is.
 */
function coerceNumericValue(value: FilterValue): FilterValue {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  if (Array.isArray(value)) {
    const coerced = value.map((v) =>
      typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v
    )
    if (coerced.every((v) => typeof v === 'number')) return coerced as number[]
  }
  return value
}

function matchStringArray(fieldValues: string[], operator: MatchOperator, queryValue: FilterValue): boolean {
  const queryStr = String(queryValue).toLowerCase()
  const fieldLower = fieldValues.map((v) => v.toLowerCase())

  switch (operator) {
    case '=':
      return fieldLower.includes(queryStr)
    case '!=':
      return !fieldLower.includes(queryStr)
    case 'contains':
      return fieldLower.some((v) => v.includes(queryStr))
    case 'not contains':
      return !fieldLower.some((v) => v.includes(queryStr))
  }
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function containsSubsequence(arr: number[], sub: number[]): boolean {
  if (sub.length === 0) return true
  if (sub.length > arr.length) return false

  for (let i = 0; i <= arr.length - sub.length; i++) {
    let match = true
    for (let j = 0; j < sub.length; j++) {
      if (arr[i + j] !== sub[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

// =============================================================================
// Public API (backwards compatible)
// =============================================================================

export interface ParsedQuery {
  expression: Expression | null
  errors: ParseError[]
}

export function parseQuery(query: string): ParsedQuery {
  const tokenizer = new Tokenizer(query)
  const tokens = tokenizer.tokenize()
  const parser = new Parser(tokens)
  const expression = parser.parse()
  const errors = parser.getErrors()
  return { expression, errors }
}

export function matchPacket(packet: BgpPacket, query: ParsedQuery): boolean {
  return evaluate(query.expression, packet)
}

// Legacy tokenize function for autocomplete
export function tokenize(query: string): Token[] {
  const tokenizer = new Tokenizer(query)
  return tokenizer.tokenize()
}

// =============================================================================
// Autocomplete
// =============================================================================

export interface Suggestion {
  text: string
  description: string
  insertText: string
}

export function getSuggestions(query: string, cursorPosition: number, packets: BgpPacket[]): Suggestion[] {
  const beforeCursor = query.slice(0, cursorPosition)
  const tokens = tokenize(beforeCursor).filter((t) => t.type !== 'eof')
  const lastToken = tokens[tokens.length - 1]
  const secondLastToken = tokens[tokens.length - 2]
  const thirdLastToken = tokens[tokens.length - 3]

  const endsWithSpace = beforeCursor.length > 0 && /\s$/.test(beforeCursor)
  const dynamicValues = extractDynamicValues(packets)

  // After complete expression - suggest logical operators
  if (
    endsWithSpace &&
    (lastToken?.type === 'string' || lastToken?.type === 'number') &&
    secondLastToken?.type === 'operator'
  ) {
    return [
      { text: 'and', description: 'AND condition', insertText: 'and ' },
      { text: 'or', description: 'OR condition', insertText: 'or ' },
    ]
  }

  // After operator with space - suggest values
  if (endsWithSpace && lastToken?.type === 'operator' && secondLastToken?.type === 'field') {
    const field = normalizeFieldName(secondLastToken.value) as FilterFieldName
    const values = getFieldValues(field, dynamicValues)

    return values.slice(0, 15).map((v) => ({
      text: v,
      description: field,
      insertText: v.includes(' ') ? `"${v}"` : v,
    }))
  }

  // After operator (no space yet) - suggest values
  if (lastToken?.type === 'operator' && secondLastToken?.type === 'field') {
    const field = normalizeFieldName(secondLastToken.value) as FilterFieldName
    const values = getFieldValues(field, dynamicValues)

    return values.slice(0, 15).map((v) => ({
      text: v,
      description: field,
      insertText: v.includes(' ') ? `"${v}"` : v,
    }))
  }

  // Typing value after operator - filter values
  if (
    (lastToken?.type === 'string' || lastToken?.type === 'number') &&
    secondLastToken?.type === 'operator' &&
    thirdLastToken?.type === 'field'
  ) {
    const field = normalizeFieldName(thirdLastToken.value) as FilterFieldName
    const values = getFieldValues(field, dynamicValues)
    const currentValue = String(lastToken.type === 'string' ? lastToken.value : lastToken.value).toLowerCase()

    const filtered = values.filter((v) => v.toLowerCase().includes(currentValue))

    if (filtered.length > 0) {
      return filtered.slice(0, 15).map((v) => ({
        text: v,
        description: field,
        insertText: v.includes(' ') ? `"${v}"` : v,
      }))
    }
    return []
  }

  // After field - suggest operators
  if (lastToken?.type === 'field') {
    const suggestions: Suggestion[] = [
      { text: '=', description: 'Equals', insertText: '=' },
      { text: '!=', description: 'Not equals', insertText: '!=' },
    ]
    if (isNumericField(lastToken.value)) {
      suggestions.push(
        { text: '<', description: 'Less than', insertText: '<' },
        { text: '<=', description: 'Less than or equal', insertText: '<=' },
        { text: '>', description: 'Greater than', insertText: '>' },
        { text: '>=', description: 'Greater than or equal', insertText: '>=' }
      )
    }
    suggestions.push({ text: 'contains', description: 'Contains', insertText: 'contains ' })
    return suggestions
  }

  // After logical operator with space - suggest fields
  if (endsWithSpace && (lastToken?.type === 'and' || lastToken?.type === 'or')) {
    return getFieldSuggestions('')
  }

  // After logical operator (no space) - suggest fields
  if (lastToken?.type === 'and' || lastToken?.type === 'or') {
    return getFieldSuggestions('')
  }

  // Typing something - filter fields
  if (lastToken?.type === 'string') {
    const currentWord = lastToken.value.toLowerCase()
    return getFieldSuggestions(currentWord)
  }

  // Empty or start - show all fields
  return getFieldSuggestions('')
}

// Get field suggestions, including common examples
function getFieldSuggestions(filter: string): Suggestion[] {
  const suggestions: Suggestion[] = []

  // Add canonical field names with examples
  for (const [key, info] of Object.entries(FILTER_FIELDS)) {
    if (!filter || key.toLowerCase().includes(filter)) {
      const examples = info.values.length > 0
        ? info.values.slice(0, 3).join(', ')
        : ''
      suggestions.push({
        text: key,
        description: examples || info.description,
        insertText: key,
      })
    }
  }

  // Add common aliases
  const aliasDescriptions: Record<string, string> = {
    src: 'Source IP (alias for src_ip)',
    dst: 'Destination IP (alias for dst_ip)',
    as: 'Source AS (alias for src_as)',
    aspath: 'AS in path (alias for asn)',
    nexthop: 'Next hop (alias for next_hop)',
    nlri: 'NLRI prefix (alias for prefix)',
  }

  for (const [alias, desc] of Object.entries(aliasDescriptions)) {
    if (!filter || alias.toLowerCase().includes(filter)) {
      suggestions.push({
        text: alias,
        description: desc,
        insertText: alias,
      })
    }
  }

  return suggestions
}

function extractDynamicValues(packets: BgpPacket[]): Record<string, Set<string>> {
  // Use canonical field names
  const values: Record<string, Set<string>> = {
    src_ip: new Set(),
    dst_ip: new Set(),
    router_id: new Set(),
    capability: new Set(),
    src_as: new Set(),
    asn: new Set(),
    origin: new Set(),
    next_hop: new Set(),
    community: new Set(),
    rt: new Set(),
    ext_community: new Set(),
    mac: new Set(),
    vni: new Set(),
    rd: new Set(),
    evpn_type: new Set(),
    prefix: new Set(),
    withdrawn: new Set(),
  }

  for (const packet of packets) {
    values.src_ip.add(packet.srcIp)
    values.dst_ip.add(packet.dstIp)

    for (const route of evpnRoutes(packet)) {
      if (route.macAddress) values.mac.add(route.macAddress)
      if (route.rd) values.rd.add(route.rd)
      if (route.label !== undefined) values.vni.add(String(route.label))
      values.evpn_type.add(String(route.routeType))
    }

    for (const msg of packet.messages) {
      if (msg.type === 'OPEN') {
        const openMsg = msg as BgpOpenMessage
        values.router_id.add(openMsg.bgpIdentifier)
        values.src_as.add(String(openMsg.fourByteAs ?? openMsg.myAs))
        for (const cap of openMsg.capabilities) {
          values.capability.add(cap.name)
        }
      }

      if (msg.type === 'UPDATE') {
        const updateMsg = msg as BgpUpdateMessage
        const aspath = getAsPath(updateMsg)
        for (const asNum of aspath) {
          values.asn.add(String(asNum))
        }
        const origin = getOrigin(updateMsg)
        if (origin) values.origin.add(origin)
        const nexthop = getNextHop(updateMsg)
        if (nexthop) values.next_hop.add(nexthop)
        for (const c of getCommunities(updateMsg)) {
          values.community.add(c)
        }
        for (const c of getLargeCommunities(updateMsg)) {
          values.community.add(c) // Merge large communities into community
        }
        for (const c of getExtendedCommunities(updateMsg)) {
          values.ext_community.add(formatExtendedCommunity(c))
          if (c.kind === 'Route Target') values.rt.add(c.value)
        }
        for (const p of getNlriPrefixes(updateMsg)) {
          values.prefix.add(formatPrefix(p))
        }
        for (const p of updateMsg.withdrawnRoutes) {
          values.withdrawn.add(formatPrefix(p))
        }
      }
    }
  }

  return values
}

function getFieldValues(field: FilterFieldName, dynamicValues: Record<string, Set<string>>): string[] {
  const fieldDef = FILTER_FIELDS[field]
  if (fieldDef.values.length > 0) {
    return fieldDef.values as unknown as string[]
  }

  const values = dynamicValues[field]
  return values ? Array.from(values).sort() : []
}
