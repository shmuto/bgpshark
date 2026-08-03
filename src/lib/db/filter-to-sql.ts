/**
 * Convert filter expression to SQL WHERE clause
 */
import type { Expression, Comparison, Operator, FilterValue } from '../filter/parser'
import { normalizeFieldName } from '../filter/parser'

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

  // Check if it's a prefix (e.g., 10.0.0.0/8)
  if (strValue.includes('/')) {
    // Prefix match - use LIKE for simplicity (DuckDB has inet type but we store as VARCHAR)
    const [network, prefixLen] = strValue.split('/')
    const octets = network.split('.')
    const maskBits = parseInt(prefixLen, 10)

    // Calculate how many full octets to match
    const fullOctets = Math.floor(maskBits / 8)
    const matchPrefix = escapeString(octets.slice(0, fullOctets).join('.'))

    switch (operator) {
      case '=':
      case 'contains':
        return `p.${column} LIKE '${matchPrefix}%'`
      case '!=':
      case 'not contains':
        return `p.${column} NOT LIKE '${matchPrefix}%'`
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
 */
function prefixSql(table: 'nlri' | 'withdrawn', operator: Operator, value: FilterValue): string {
  const strValue = String(value)

  // Handle prefix/length format (e.g., "10.0.0.0/8")
  if (strValue.includes('/')) {
    const escaped = escapeString(strValue)
    const escapedNetwork = escapeString(strValue.split('/')[0])
    switch (operator) {
      case '=':
        return `EXISTS (
          SELECT 1 FROM ${table} t
          JOIN messages m ON t.message_id = m.id
          WHERE m.frame_index = p.frame_index
          AND t.prefix || '/' || t.prefix_length = '${escaped}'
        )`
      case '!=':
        return `NOT EXISTS (
          SELECT 1 FROM ${table} t
          JOIN messages m ON t.message_id = m.id
          WHERE m.frame_index = p.frame_index
          AND t.prefix || '/' || t.prefix_length = '${escaped}'
        )`
      case 'contains':
        // Match if query is contained in or contains the prefix
        return `EXISTS (
          SELECT 1 FROM ${table} t
          JOIN messages m ON t.message_id = m.id
          WHERE m.frame_index = p.frame_index
          AND (t.prefix || '/' || t.prefix_length LIKE '%${escaped}%'
               OR t.prefix LIKE '${escapedNetwork}%')
        )`
      case 'not contains':
        return `NOT EXISTS (
          SELECT 1 FROM ${table} t
          JOIN messages m ON t.message_id = m.id
          WHERE m.frame_index = p.frame_index
          AND (t.prefix || '/' || t.prefix_length LIKE '%${escaped}%'
               OR t.prefix LIKE '${escapedNetwork}%')
        )`
    }
  }

  // Just IP address without length
  const escaped = escapeString(strValue)
  switch (operator) {
    case '=':
    case 'contains':
      return `EXISTS (
        SELECT 1 FROM ${table} t
        JOIN messages m ON t.message_id = m.id
        WHERE m.frame_index = p.frame_index AND t.prefix LIKE '${escaped}%'
      )`
    case '!=':
    case 'not contains':
      return `NOT EXISTS (
        SELECT 1 FROM ${table} t
        JOIN messages m ON t.message_id = m.id
        WHERE m.frame_index = p.frame_index AND t.prefix LIKE '${escaped}%'
      )`
  }
}

/**
 * Escape string for SQL
 */
function escapeString(str: string): string {
  return str.replace(/'/g, "''")
}
