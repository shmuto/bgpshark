import { describe, expect, test } from 'bun:test'
import { SCHEMA_SQL, DROP_TABLES_SQL, splitSqlStatements } from '../../../src/lib/db/schema'

/**
 * DuckDB WASM takes one statement per call, so the schema script is cut up
 * before it is run. Splitting on every `;` looks right until a semicolon turns
 * up inside a comment — then a CREATE TABLE is severed mid-column and what the
 * app reports is "Failed to initialize DuckDB", with every table after the cut
 * missing and every filter quietly returning nothing.
 */
describe('splitting a script into statements', () => {
  test('a semicolon inside a line comment is not a boundary', () => {
    const statements = splitSqlStatements(`
      -- what this holds; and what it does not
      CREATE TABLE t (a INTEGER);
    `)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('CREATE TABLE t')
  })

  test('a semicolon inside a block comment is not either', () => {
    const statements = splitSqlStatements('/* one; two */ CREATE TABLE t (a INTEGER);')
    expect(statements).toHaveLength(1)
  })

  test('a semicolon inside a string literal is not a boundary', () => {
    const statements = splitSqlStatements(`INSERT INTO t VALUES ('a;b');`)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain("'a;b'")
  })

  test("an escaped quote does not end the literal early", () => {
    const statements = splitSqlStatements(`INSERT INTO t VALUES ('it''s; fine');`)
    expect(statements).toHaveLength(1)
  })

  test('trailing comments are dropped rather than run as a statement', () => {
    // An empty parse is a syntax error of its own, so a comment-only tail
    // must not be handed on.
    expect(splitSqlStatements('CREATE TABLE t (a INTEGER);\n-- done\n')).toHaveLength(1)
  })

  test('ordinary statements still split', () => {
    expect(splitSqlStatements('CREATE TABLE a (x INTEGER); CREATE TABLE b (y INTEGER);')).toHaveLength(2)
  })
})

describe('the schema survives being split', () => {
  const statements = splitSqlStatements(SCHEMA_SQL)

  test('every statement is a whole one', () => {
    // A severed CREATE TABLE leaves its parentheses unbalanced, which is the
    // shape of the failure without needing a database to find it.
    for (const statement of statements) {
      const body = statement.replace(/--[^\n]*/g, '')
      const opened = (body.match(/\(/g) ?? []).length
      const closed = (body.match(/\)/g) ?? []).length
      expect({ statement, opened, closed }).toMatchObject({ opened: closed })
      expect(statement.trim()).toMatch(/^(--|\/\*|CREATE)/)
    }
  })

  test('every table the loader writes to is created', () => {
    const created = statements.flatMap(
      (statement) => statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] ?? []
    )
    expect(created).toEqual(
      expect.arrayContaining([
        'packets',
        'messages',
        'capabilities',
        'path_attributes',
        'as_path',
        'nlri',
        'withdrawn',
        'communities',
        'large_communities',
        'extended_communities',
      ])
    )
  })

  test('every table created is dropped again on reset', () => {
    // A table left behind keeps the previous capture's rows, and the next
    // capture then reads as both of them at once.
    const created = statements.flatMap(
      (statement) => statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] ?? []
    )
    const dropped = splitSqlStatements(DROP_TABLES_SQL).flatMap(
      (statement) => statement.match(/DROP TABLE IF EXISTS (\w+)/)?.[1] ?? []
    )
    expect(dropped.slice().sort()).toEqual(created.slice().sort())
  })
})
