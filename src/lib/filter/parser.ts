import type {
  BgpPacket,
  BgpOpenMessage,
  BgpUpdateMessage,
  AsPathAttribute,
  CommunitiesAttribute,
  LargeCommunitiesAttribute,
  NextHopAttribute,
  OriginAttribute,
  MpReachNlriAttribute,
  MpUnreachNlriAttribute,
} from '../bgp/types'

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

export type Operator = '=' | '!=' | 'contains' | 'not contains'

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
}

export type FilterFieldName = keyof typeof FILTER_FIELDS

// All valid field names (canonical + aliases)
const FIELD_NAMES = [...Object.keys(FILTER_FIELDS), ...Object.keys(FIELD_ALIASES)]

// Normalize field name (resolve alias to canonical name)
export function normalizeFieldName(field: string): string {
  return FIELD_ALIASES[field] || field
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
    return /[\w\-.:\/]/.test(char)
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

  switch (field) {
    case 'type':
      // Match if any message matches the type
      return packet.messages.some((msg) => matchString(msg.type, operator, value))

    case 'src_ip':
      return matchString(packet.srcIp, operator, value)

    case 'dst_ip':
      return matchString(packet.dstIp, operator, value)

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

    case 'prefix':
      // Match both announced (NLRI) and withdrawn prefixes
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const update = msg as BgpUpdateMessage
        const nlriPrefixes = getNlriPrefixes(update)
        const withdrawnPrefixes = getWithdrawnPrefixes(update)
        const allPrefixes = [...nlriPrefixes, ...withdrawnPrefixes]
        if (matchStringArray(allPrefixes, operator, value)) return true
      }
      return false

    case 'withdrawn':
      for (const msg of packet.messages) {
        if (msg.type !== 'UPDATE') continue
        const withdrawnPrefixes = getWithdrawnPrefixes(msg as BgpUpdateMessage)
        if (matchStringArray(withdrawnPrefixes, operator, value)) return true
      }
      return false

    default:
      return false
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

function getNlriPrefixes(msg: BgpUpdateMessage): string[] {
  const prefixes: string[] = []
  // IPv4 NLRI
  for (const p of msg.nlri) {
    prefixes.push(`${p.prefix}/${p.length}`)
  }
  // MP_REACH_NLRI for IPv6
  const mpAttr = msg.pathAttributes.find((a) => a.parsed?.type === 'MP_REACH_NLRI')
  if (mpAttr?.parsed && mpAttr.parsed.type === 'MP_REACH_NLRI') {
    for (const p of (mpAttr.parsed as MpReachNlriAttribute).nlri) {
      prefixes.push(`${p.prefix}/${p.length}`)
    }
  }
  return prefixes
}

function getWithdrawnPrefixes(msg: BgpUpdateMessage): string[] {
  const prefixes: string[] = []
  // IPv4 Withdrawn
  for (const p of msg.withdrawnRoutes) {
    prefixes.push(`${p.prefix}/${p.length}`)
  }
  // MP_UNREACH_NLRI for IPv6
  const mpAttr = msg.pathAttributes.find((a) => a.parsed?.type === 'MP_UNREACH_NLRI')
  if (mpAttr?.parsed && mpAttr.parsed.type === 'MP_UNREACH_NLRI') {
    for (const p of (mpAttr.parsed as MpUnreachNlriAttribute).withdrawnRoutes) {
      prefixes.push(`${p.prefix}/${p.length}`)
    }
  }
  return prefixes
}

// =============================================================================
// Matching functions
// =============================================================================

function matchString(fieldValue: string, operator: Operator, queryValue: FilterValue): boolean {
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

function matchNumber(fieldValue: number, operator: Operator, queryValue: FilterValue): boolean {
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

function matchNumberArray(fieldValues: number[], operator: Operator, queryValue: FilterValue): boolean {
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

function matchStringArray(fieldValues: string[], operator: Operator, queryValue: FilterValue): boolean {
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
    return [
      { text: '=', description: 'Equals', insertText: '=' },
      { text: '!=', description: 'Not equals', insertText: '!=' },
      { text: 'contains', description: 'Contains', insertText: 'contains ' },
    ]
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
    prefix: new Set(),
    withdrawn: new Set(),
  }

  for (const packet of packets) {
    values.src_ip.add(packet.srcIp)
    values.dst_ip.add(packet.dstIp)

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
        for (const p of getNlriPrefixes(updateMsg)) {
          values.prefix.add(p)
        }
        for (const p of updateMsg.withdrawnRoutes) {
          values.withdrawn.add(`${p.prefix}/${p.length}`)
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
