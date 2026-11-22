import { describe, expect, test } from 'bun:test'
import { appendCondition, formatCondition } from '../../../src/lib/filter/compose'
import { parseQuery } from '../../../src/lib/filter/parser'

describe('building a filter from a value', () => {
  test('values are quoted only when they have to be', () => {
    expect(formatCondition('src_ip', '=', '10.0.13.1')).toBe('src_ip = 10.0.13.1')
    expect(formatCondition('ext_community', 'contains', 'MAC Mobility')).toBe('ext_community contains "MAC Mobility"')
    expect(parseQuery(formatCondition('community', '=', 'a"b')).errors).toHaveLength(0)
  })

  test('an empty query becomes the condition', () => {
    expect(appendCondition('  ', 'type = UPDATE')).toBe('type = UPDATE')
  })

  test('a condition narrows the whole query, or included', () => {
    expect(appendCondition('type = UPDATE', 'asn = 65001')).toBe('type = UPDATE and asn = 65001')
    expect(appendCondition('ip = 1.1.1.1 or ip = 2.2.2.2', 'type = OPEN')).toBe(
      '(ip = 1.1.1.1 or ip = 2.2.2.2) and type = OPEN'
    )
  })
})
