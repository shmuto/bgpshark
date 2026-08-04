/**
 * Convert filter expression to SQL WHERE clause
 */
import type { Expression, Comparison, Operator, FilterValue } from '../filter/parser'
import { normalizeFieldName } from '../filter/parser'
import { bitKey, parsePrefix } from '../net/prefix'

/**
 * Convert a filter expression to SQL WHERE clause
 */
export function expressionToSql(expr: Expression | null): string {
  if (expr === null) return '1=1'

  switch (expr.type) {
    case 'and':
      return `(${expressionToSql(expr.left)} AND ${expressionToSql(expr.right)})`
    case 'or':
      return `(${expressionToSql(expr.left)} OR ${expressionToSql(expr.right)})`
    case 'not':
      return `NOT (${expressionToSql(expr.expr)})`
    case 'comparison':
      return comparisonToSql(expr)
  }
}

/**
 * Convert a single comparison to SQL
 */
function comparisonToSql(expr: Comparison): string {
  const { operator, value } = expr
  // Normalize field name to handle both old and new names
  const field = normalizeFieldName(expr.field)

  switch (field) {
    case 'type':
      return messageFieldSql('type', operator, value)

    case 'src_ip':
      return ipFieldSql('src_ip', operator, value)

    case 'dst_ip':
      return ipFieldSql('dst_ip', operator, value)

    case 'router_id':
      return messageFieldSql('router_id', operator, value, "type = 'OPEN'")

    case 'capability':
      return capabilitySql(operator, value)

    case 'src_as':
      return numericMessageFieldSql('my_as', operator, value, "type = 'OPEN'")

    case 'asn':
      return asPathSql(operator, value)

    case 'origin':
      return pathAttrSql('origin_value', operator, value)

    case 'next_hop':
      return nextHopSql(operator, value)

    case 'community':
      // Handle both standard and large communities
      return `(${communitySql(operator, value)} OR ${largeCommunitySql(operator, value)})`

    case 'prefix':
      return prefixSql('nlri', operator, value)

    case 'withdrawn':
      return prefixSql('withdrawn', operator, value)

    default:
      return '1=0' // Unknown field, match nothing
  }
}

/**
 * SQL for message-level fields
 */
function messageFieldSql(column: string, operator: Operator, value: FilterValue, extraCondition?: string): string {
  const strValue = escapeString(String(value))
  const condition = extraCondition ? `${extraCondition} AND ` : ''

  switch (operator) {
    case '=':
      return `EXISTS (SELECT 1 FROM messages m WHERE m.frame_index = p.frame_index AND ${condition}LOWER(m.${column}) = LOWER('${strValue}'))`
    case '!=':
      return `NOT EXISTS (SELECT 1 FROM messages m WHERE m.frame_index = p.frame_index AND ${condition}LOWER(m.${column}) = LOWER('${strValue}'))`
    case 'contains':
      return `EXISTS (SELECT 1 FROM messages m WHERE m.frame_index = p.frame_index AND ${condition}LOWER(m.${column}) LIKE LOWER('%${strValue}%'))`
    case 'not contains':
      return `NOT EXISTS (SELECT 1 FROM messages m WHERE m.frame_index = p.frame_index AND ${condition}LOWER(m.${column}) LIKE LOWER('%${strValue}%'))`
  }
}

/**
 * SQL for integer message-level columns (e.g. my_as).
 * Compares numerically when possible, and casts explicitly for substring matching
 * so the column type never has to be inferred.
 */
function numericMessageFieldSql(
  column: string,
  operator: Operator,
  value: FilterValue,
  extraCondition?: string
): string {
  const condition = extraCondition ? `${extraCondition} AND ` : ''
  const numeric = coerceNumericValue(value)
  const exists = (predicate: string) =>
    `EXISTS (SELECT 1 FROM messages m WHERE m.frame_index = p.frame_index AND ${condition}${predicate})`

  if (typeof numeric === 'number') {
    switch (operator) {
      case '=':
      case 'contains':
        return exists(`m.${column} = ${numeric}`)
      case '!=':
      case 'not contains':
        return `NOT ${exists(`m.${column} = ${numeric}`)}`
    }
  }

  // Non-numeric input: fall back to text matching on the casted column
  const strValue = escapeString(String(value))
  switch (operator) {
    case '=':
      return exists(`CAST(m.${column} AS VARCHAR) = '${strValue}'`)
    case '!=':
      return `NOT ${exists(`CAST(m.${column} AS VARCHAR) = '${strValue}'`)}`
    case 'contains':
      return exists(`CAST(m.${column} AS VARCHAR) LIKE '%${strValue}%'`)
    case 'not contains':
      return `NOT ${exists(`CAST(m.${column} AS VARCHAR) LIKE '%${strValue}%'`)}`
  }
}

/**
 * Numeric fields accept quoted values, e.g. `asn = "65001"` from the value dropdown.
 * Convert those to real numbers so numeric comparison applies; leave anything else as is.
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

/**
 * SQL for IP address fields (supports prefix matching)
 */
function ipFieldSql(column: string, operator: Operator, value: FilterValue): string {
  const strValue = String(value)
  const query = parsePrefix(strValue)

  // A CIDR asks whether the address falls inside it. This used to be a LIKE on
  // whole octets, which rounded the mask down to a byte boundary — /12 matched
  // all of /8 — and could not express IPv6 at all. The precomputed bit key
  // answers both exactly.
  if (query?.hasMask) {
    const key = bitKey(query)
    switch (operator) {
      case '=':
      case 'contains':
        return `p.${column}_bits LIKE '${key}%'`
      case '!=':
      case 'not contains':
        return `(p.${column}_bits IS NULL OR p.${column}_bits NOT LIKE '${key}%')`
    }
  }

  // Exact IP match
  const escaped = escapeString(strValue)
  switch (operator) {
    case '=':
      return `p.${column} = '${escaped}'`
    case '!=':
      return `p.${column} != '${escaped}'`
    case 'contains':
      return `p.${column} LIKE '%${escaped}%'`
    case 'not contains':
      return `p.${column} NOT LIKE '%${escaped}%'`
  }
}

/**
 * SQL for capability search
 */
function capabilitySql(operator: Operator, value: FilterValue): string {
  const strValue = escapeString(String(value))

  switch (operator) {
    case '=':
      return `EXISTS (
        SELECT 1 FROM capabilities c
        JOIN messages m ON c.message_id = m.id
        WHERE m.frame_index = p.frame_index AND LOWER(c.name) = LOWER('${strValue}')
      )`
    case '!=':
      return `NOT EXISTS (
        SELECT 1 FROM capabilities c
        JOIN messages m ON c.message_id = m.id
        WHERE m.frame_index = p.frame_index AND LOWER(c.name) = LOWER('${strValue}')
      )`
    case 'contains':
      return `EXISTS (
        SELECT 1 FROM capabilities c
        JOIN messages m ON c.message_id = m.id
        WHERE m.frame_index = p.frame_index AND LOWER(c.name) LIKE LOWER('%${strValue}%')
      )`
    case 'not contains':
      return `NOT EXISTS (
        SELECT 1 FROM capabilities c
        JOIN messages m ON c.message_id = m.id
        WHERE m.frame_index = p.frame_index AND LOWER(c.name) LIKE LOWER('%${strValue}%')
      )`
  }
}

/**
 * SQL for AS_PATH search
 */
function asPathSql(operator: Operator, value: FilterValue): string {
  // A quoted numeric value ("65001") is equivalent to the bare number
  value = coerceNumericValue(value)

  // Single AS number
  if (typeof value === 'number') {
    switch (operator) {
      case '=':
      case 'contains':
        return `EXISTS (
          SELECT 1 FROM as_path ap
          JOIN messages m ON ap.message_id = m.id
          WHERE m.frame_index = p.frame_index AND ap.asn = ${value}
        )`
      case '!=':
      case 'not contains':
        return `NOT EXISTS (
          SELECT 1 FROM as_path ap
          JOIN messages m ON ap.message_id = m.id
          WHERE m.frame_index = p.frame_index AND ap.asn = ${value}
        )`
    }
  }

  // Array of AS numbers - check for subsequence
  if (Array.isArray(value)) {
    const asNumbers = value as number[]
    if (asNumbers.length === 0) return '1=1'

    // For exact sequence match or contains, we need to check consecutive ASNs
    const conditions = asNumbers.map((asn, idx) => `ap${idx}.asn = ${asn}`).join(' AND ')
    const joins = asNumbers
      .map(
        (_, idx) => `
      JOIN as_path ap${idx} ON ap${idx}.message_id = m.id
        AND ap${idx}.segment_index = ap0.segment_index
        AND ap${idx}.as_index = ap0.as_index + ${idx}
    `
      )
      .slice(1)
      .join('')

    switch (operator) {
      case '=':
      case 'contains':
        return `EXISTS (
          SELECT 1 FROM as_path ap0
          JOIN messages m ON ap0.message_id = m.id
          ${joins}
          WHERE m.frame_index = p.frame_index AND ${conditions}
        )`
      case '!=':
      case 'not contains':
        return `NOT EXISTS (
          SELECT 1 FROM as_path ap0
          JOIN messages m ON ap0.message_id = m.id
          ${joins}
          WHERE m.frame_index = p.frame_index AND ${conditions}
        )`
    }
  }

  return '1=0'
}

/**
 * SQL for path attribute fields
 */
function pathAttrSql(column: string, operator: Operator, value: FilterValue): string {
  const strValue = escapeString(String(value))

  switch (operator) {
    case '=':
      return `EXISTS (
        SELECT 1 FROM path_attributes pa
        JOIN messages m ON pa.message_id = m.id
        WHERE m.frame_index = p.frame_index AND LOWER(pa.${column}) = LOWER('${strValue}')
      )`
    case '!=':
      return `NOT EXISTS (
        SELECT 1 FROM path_attributes pa
        JOIN messages m ON pa.message_id = m.id
        WHERE m.frame_index = p.frame_index AND LOWER(pa.${column}) = LOWER('${strValue}')
      )`
    case 'contains':
      return `EXISTS (
        SELECT 1 FROM path_attributes pa
        JOIN messages m ON pa.message_id = m.id
        WHERE m.frame_index = p.frame_index AND LOWER(pa.${column}) LIKE LOWER('%${strValue}%')
      )`
    case 'not contains':
      return `NOT EXISTS (
        SELECT 1 FROM path_attributes pa
        JOIN messages m ON pa.message_id = m.id
        WHERE m.frame_index = p.frame_index AND LOWER(pa.${column}) LIKE LOWER('%${strValue}%')
      )`
  }
}

/**
 * SQL for next hop (both NEXT_HOP attribute and MP_REACH_NLRI)
 */
function nextHopSql(operator: Operator, value: FilterValue): string {
  const strValue = escapeString(String(value))

  // Check both path_attributes.next_hop and path_attributes for MP_REACH_NLRI
  // For simplicity, we only check next_hop column
  switch (operator) {
    case '=':
      return `EXISTS (
        SELECT 1 FROM path_attributes pa
        JOIN messages m ON pa.message_id = m.id
        WHERE m.frame_index = p.frame_index AND pa.next_hop = '${strValue}'
      )`
    case '!=':
      return `NOT EXISTS (
        SELECT 1 FROM path_attributes pa
        JOIN messages m ON pa.message_id = m.id
        WHERE m.frame_index = p.frame_index AND pa.next_hop = '${strValue}'
      )`
    case 'contains':
      return `EXISTS (
        SELECT 1 FROM path_attributes pa
        JOIN messages m ON pa.message_id = m.id
        WHERE m.frame_index = p.frame_index AND pa.next_hop LIKE '%${strValue}%'
      )`
    case 'not contains':
      return `NOT EXISTS (
        SELECT 1 FROM path_attributes pa
        JOIN messages m ON pa.message_id = m.id
        WHERE m.frame_index = p.frame_index AND pa.next_hop LIKE '%${strValue}%'
      )`
  }
}

/**
 * SQL for community search
 */
function communitySql(operator: Operator, value: FilterValue): string {
  const strValue = escapeString(String(value))

  switch (operator) {
    case '=':
      return `EXISTS (
        SELECT 1 FROM communities c
        JOIN messages m ON c.message_id = m.id
        WHERE m.frame_index = p.frame_index AND c.formatted = '${strValue}'
      )`
    case '!=':
      return `NOT EXISTS (
        SELECT 1 FROM communities c
        JOIN messages m ON c.message_id = m.id
        WHERE m.frame_index = p.frame_index AND c.formatted = '${strValue}'
      )`
    case 'contains':
      return `EXISTS (
        SELECT 1 FROM communities c
        JOIN messages m ON c.message_id = m.id
        WHERE m.frame_index = p.frame_index AND c.formatted LIKE '%${strValue}%'
      )`
    case 'not contains':
      return `NOT EXISTS (
        SELECT 1 FROM communities c
        JOIN messages m ON c.message_id = m.id
        WHERE m.frame_index = p.frame_index AND c.formatted LIKE '%${strValue}%'
      )`
  }
}

/**
 * SQL for large community search
 */
function largeCommunitySql(operator: Operator, value: FilterValue): string {
  const strValue = escapeString(String(value))

  switch (operator) {
    case '=':
      return `EXISTS (
        SELECT 1 FROM large_communities lc
        JOIN messages m ON lc.message_id = m.id
        WHERE m.frame_index = p.frame_index AND lc.formatted = '${strValue}'
      )`
    case '!=':
      return `NOT EXISTS (
        SELECT 1 FROM large_communities lc
        JOIN messages m ON lc.message_id = m.id
        WHERE m.frame_index = p.frame_index AND lc.formatted = '${strValue}'
      )`
    case 'contains':
      return `EXISTS (
        SELECT 1 FROM large_communities lc
        JOIN messages m ON lc.message_id = m.id
        WHERE m.frame_index = p.frame_index AND lc.formatted LIKE '%${strValue}%'
      )`
    case 'not contains':
      return `NOT EXISTS (
        SELECT 1 FROM large_communities lc
        JOIN messages m ON lc.message_id = m.id
        WHERE m.frame_index = p.frame_index AND lc.formatted LIKE '%${strValue}%'
      )`
  }
}

/**
 * SQL for prefix search (nlri or withdrawn)
 *
 * The routes an expression selects are the same ones the route analysis screen
 * shows for the same text, because both ask `lib/net/prefix` the question:
 * `10.0.0.0/8` selects the routes inside it, and a bare address selects the
 * routes that cover it.
 */
function prefixSql(table: 'nlri' | 'withdrawn', operator: Operator, value: FilterValue): string {
  const strValue = String(value)
  const query = parsePrefix(strValue)

  let condition: string
  if (query?.hasMask) {
    // A mask asks for everything inside it.
    condition = `t.prefix_bits LIKE '${bitKey(query)}%'`
  } else if (query) {
    // A bare address asks which announcements cover it, so the comparison runs
    // the other way: the route's bits have to be a prefix of the address's.
    condition = `'${bitKey(query)}' LIKE t.prefix_bits || '%'`
  } else {
    // Not an address — a half-typed one, say. Fall back to searching the text.
    condition = `t.prefix || '/' || t.prefix_length LIKE '%${escapeString(strValue)}%'`
  }

  const exists = `EXISTS (
    SELECT 1 FROM ${table} t
    JOIN messages m ON t.message_id = m.id
    WHERE m.frame_index = p.frame_index
    AND ${condition}
  )`

  switch (operator) {
    case '=':
    case 'contains':
      return exists
    case '!=':
    case 'not contains':
      return `NOT ${exists}`
  }
}

/**
 * Escape string for SQL
 */
function escapeString(str: string): string {
  return str.replace(/'/g, "''")
}
