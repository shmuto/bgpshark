import { describe, test, expect } from 'bun:test'
import { createBatches } from '../../../src/lib/db/load-batches'
import { describeSchema } from '../../../src/lib/db/schema'

/**
 * The loader appends each chunk to its table straight from Arrow, which binds
 * columns by position. So the columns `createBatches` writes must be the
 * schema's, in the schema's order: one out of place would put its values into
 * its neighbour's column without an error. The loader checks the live tables
 * too; this catches it before anything runs.
 */
describe('load batches', () => {
  test('every table is written with the schema’s columns, in the schema’s order', () => {
    const schema = new Map(describeSchema().map((table) => [table.name, table.columns.map((c) => c.name)]))
    const batches = Object.values(createBatches())
    expect(batches.map((b) => b.name).sort()).toEqual([...schema.keys()].sort())
    for (const batch of batches) {
      expect({ table: batch.name, columns: Object.keys(batch.columns) }).toEqual({
        table: batch.name,
        columns: schema.get(batch.name)!,
      })
    }
  })
})
