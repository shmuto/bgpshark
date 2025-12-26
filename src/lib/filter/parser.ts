import type { BgpPacket, BgpOpenMessage } from '../bgp/types'

export type FilterToken =
  | { type: 'field'; value: string }
  | { type: 'operator'; value: '=' | '!=' | 'contains' }
  | { type: 'value'; value: string }
  | { type: 'logical'; value: 'and' | 'or' }
  | { type: 'lparen' }
  | { type: 'rparen' }

export interface FilterExpression {
  field: string
  operator: '=' | '!=' | 'contains'
  value: string
}

export interface ParsedQuery {
  expressions: FilterExpression[]
  logic: 'and' | 'or'
}

// Supported fields and their possible values
export const FILTER_FIELDS = {
  type: {
    description: 'Message type',
    values: ['OPEN', 'UPDATE', 'NOTIFICATION', 'KEEPALIVE', 'ROUTE_REFRESH'],
  },
  src: {
    description: 'Source IP address',
    values: [] as string[], // Dynamic
  },
  dst: {
    description: 'Destination IP address',
    values: [] as string[], // Dynamic
  },
  'router-id': {
    description: 'BGP Router ID (OPEN messages)',
    values: [] as string[], // Dynamic
  },
  capability: {
    description: 'BGP Capability (OPEN messages)',
    values: [] as string[], // Dynamic
  },
  as: {
    description: 'AS Number (OPEN messages)',
    values: [] as string[], // Dynamic
  },
} as const

export type FilterFieldName = keyof typeof FILTER_FIELDS

export function tokenize(query: string): FilterToken[] {
  const tokens: FilterToken[] = []
  let i = 0

  const skipWhitespace = () => {
    while (i < query.length && /\s/.test(query[i])) i++
  }

  const readWord = (): string => {
    let word = ''
    while (i < query.length && /[\w\-.]/.test(query[i])) {
      word += query[i]
      i++
    }
    return word
  }

  const readQuoted = (): string => {
    const quote = query[i]
    i++ // skip opening quote
    let value = ''
    while (i < query.length && query[i] !== quote) {
      if (query[i] === '\\' && i + 1 < query.length) {
        i++
        value += query[i]
      } else {
        value += query[i]
      }
      i++
    }
    i++ // skip closing quote
    return value
  }

  while (i < query.length) {
    skipWhitespace()
    if (i >= query.length) break

    const char = query[i]

    if (char === '(') {
      tokens.push({ type: 'lparen' })
      i++
    } else if (char === ')') {
      tokens.push({ type: 'rparen' })
      i++
    } else if (char === '=' || (char === '!' && query[i + 1] === '=')) {
      if (char === '!') {
        tokens.push({ type: 'operator', value: '!=' })
        i += 2
      } else {
        tokens.push({ type: 'operator', value: '=' })
        i++
      }
    } else if (char === '"' || char === "'") {
      tokens.push({ type: 'value', value: readQuoted() })
    } else {
      const word = readWord()

      if (!word) {
        // Unknown character, skip it to avoid infinite loop
        i++
        continue
      }

      const lower = word.toLowerCase()

      if (lower === 'and' || lower === 'or') {
        tokens.push({ type: 'logical', value: lower as 'and' | 'or' })
      } else if (lower === 'contains') {
        tokens.push({ type: 'operator', value: 'contains' })
      } else if (Object.keys(FILTER_FIELDS).includes(lower)) {
        tokens.push({ type: 'field', value: lower })
      } else {
        tokens.push({ type: 'value', value: word })
      }
    }
  }

  return tokens
}

export function parseQuery(query: string): ParsedQuery {
  const tokens = tokenize(query)
  const expressions: FilterExpression[] = []
  let logic: 'and' | 'or' = 'and'

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]

    if (token.type === 'field') {
      const field = token.value

      // Expect operator next
      const opToken = tokens[i + 1]
      if (!opToken || opToken.type !== 'operator') {
        continue
      }

      // Expect value after operator
      const valToken = tokens[i + 2]
      if (!valToken || valToken.type !== 'value') {
        continue
      }

      expressions.push({
        field,
        operator: opToken.value,
        value: valToken.value,
      })

      // Skip the operator and value tokens
      i += 2
    } else if (token.type === 'logical') {
      logic = token.value
    }
    // Other token types are skipped automatically by the for loop
  }

  return { expressions, logic }
}

export function matchPacket(packet: BgpPacket, query: ParsedQuery): boolean {
  if (query.expressions.length === 0) return true

  const results = query.expressions.map((expr) => matchExpression(packet, expr))

  if (query.logic === 'and') {
    return results.every((r) => r)
  } else {
    return results.some((r) => r)
  }
}

function matchExpression(packet: BgpPacket, expr: FilterExpression): boolean {
  const { field, operator, value } = expr
  const valueLower = value.toLowerCase()

  let fieldValue: string | string[] | undefined

  switch (field) {
    case 'type':
      fieldValue = packet.message.type
      break
    case 'src':
      fieldValue = packet.srcIp
      break
    case 'dst':
      fieldValue = packet.dstIp
      break
    case 'router-id':
      if (packet.message.type === 'OPEN') {
        fieldValue = (packet.message as BgpOpenMessage).bgpIdentifier
      }
      break
    case 'capability':
      if (packet.message.type === 'OPEN') {
        fieldValue = (packet.message as BgpOpenMessage).capabilities.map((c) => c.name)
      }
      break
    case 'as':
      if (packet.message.type === 'OPEN') {
        const openMsg = packet.message as BgpOpenMessage
        fieldValue = String(openMsg.fourByteAs ?? openMsg.myAs)
      }
      break
    default:
      return false
  }

  if (fieldValue === undefined) return false

  // Handle array values (capabilities)
  if (Array.isArray(fieldValue)) {
    const fieldValuesLower = fieldValue.map((v) => v.toLowerCase())
    switch (operator) {
      case '=':
        return fieldValuesLower.includes(valueLower)
      case '!=':
        return !fieldValuesLower.includes(valueLower)
      case 'contains':
        return fieldValuesLower.some((v) => v.includes(valueLower))
    }
  }

  // Handle string values
  const fieldValueLower = fieldValue.toLowerCase()
  switch (operator) {
    case '=':
      return fieldValueLower === valueLower
    case '!=':
      return fieldValueLower !== valueLower
    case 'contains':
      return fieldValueLower.includes(valueLower)
  }
}

// Get autocomplete suggestions based on current input
export interface Suggestion {
  text: string
  description: string
  insertText: string
}

export function getSuggestions(
  query: string,
  cursorPosition: number,
  packets: BgpPacket[]
): Suggestion[] {
  const beforeCursor = query.slice(0, cursorPosition)
  const tokens = tokenize(beforeCursor)
  const lastToken = tokens[tokens.length - 1]
  const secondLastToken = tokens[tokens.length - 2]
  const thirdLastToken = tokens[tokens.length - 3]

  // Check if cursor is after whitespace (not in the middle of a token)
  const endsWithSpace = beforeCursor.length > 0 && /\s$/.test(beforeCursor)

  // Extract dynamic values from packets
  const dynamicValues = extractDynamicValues(packets)

  // Case 1: After complete expression with space (e.g., "type=UPDATE |") - suggest logical operators
  if (endsWithSpace && lastToken?.type === 'value' && secondLastToken?.type === 'operator') {
    return [
      { text: 'and', description: 'AND condition', insertText: 'and ' },
      { text: 'or', description: 'OR condition', insertText: 'or ' },
    ]
  }

  // Case 2: Right after operator (e.g., "type=|") - suggest all values
  if (lastToken?.type === 'operator' && secondLastToken?.type === 'field') {
    const field = secondLastToken.value as FilterFieldName
    const values = getFieldValues(field, dynamicValues)

    return values.slice(0, 10).map((v) => ({
      text: v,
      description: `${field} = ${v}`,
      insertText: v.includes(' ') ? `"${v}"` : v,
    }))
  }

  // Case 3: Typing value after operator (e.g., "type=up|") - filter values
  if (lastToken?.type === 'value' && secondLastToken?.type === 'operator' && thirdLastToken?.type === 'field') {
    const field = thirdLastToken.value as FilterFieldName
    const values = getFieldValues(field, dynamicValues)
    const currentValue = lastToken.value.toLowerCase()

    const filtered = values.filter((v) => v.toLowerCase().includes(currentValue))

    if (filtered.length > 0) {
      return filtered.slice(0, 10).map((v) => ({
        text: v,
        description: `${field} = ${v}`,
        insertText: v.includes(' ') ? `"${v}"` : v,
      }))
    }

    // No matching values - no suggestions (user is typing a custom value)
    return []
  }

  // Case 4: After field (e.g., "type|") - suggest operators
  if (lastToken?.type === 'field') {
    return [
      { text: '=', description: 'Equals', insertText: '=' },
      { text: '!=', description: 'Not equals', insertText: '!=' },
      { text: 'contains', description: 'Contains substring', insertText: 'contains ' },
    ]
  }

  // Case 5: After logical operator (e.g., "type=OPEN and |") - suggest fields
  if (lastToken?.type === 'logical') {
    return Object.entries(FILTER_FIELDS).map(([key, info]) => ({
      text: key,
      description: info.description,
      insertText: key,
    }))
  }

  // Default: Suggest fields (start of query or partial field name)
  const currentWord = lastToken?.type === 'value' ? lastToken.value.toLowerCase() : ''

  return Object.entries(FILTER_FIELDS)
    .filter(([key]) => key.toLowerCase().includes(currentWord))
    .map(([key, info]) => ({
      text: key,
      description: info.description,
      insertText: key,
    }))
}

function extractDynamicValues(packets: BgpPacket[]): Record<string, Set<string>> {
  const values: Record<string, Set<string>> = {
    src: new Set(),
    dst: new Set(),
    'router-id': new Set(),
    capability: new Set(),
    as: new Set(),
  }

  for (const packet of packets) {
    values.src.add(packet.srcIp)
    values.dst.add(packet.dstIp)

    if (packet.message.type === 'OPEN') {
      const openMsg = packet.message as BgpOpenMessage
      values['router-id'].add(openMsg.bgpIdentifier)
      values.as.add(String(openMsg.fourByteAs ?? openMsg.myAs))
      for (const cap of openMsg.capabilities) {
        values.capability.add(cap.name)
      }
    }
  }

  return values
}

function getFieldValues(field: FilterFieldName, dynamicValues: Record<string, Set<string>>): string[] {
  if (field === 'type') {
    return FILTER_FIELDS.type.values as unknown as string[]
  }

  const values = dynamicValues[field]
  return values ? Array.from(values).sort() : []
}
