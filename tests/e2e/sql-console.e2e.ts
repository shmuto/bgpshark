import { test, expect } from '@playwright/test'
import { loadSample, runSql } from './helpers'

test.beforeEach(async ({ page }) => {
  await loadSample(page)
  await page.getByRole('link', { name: 'SQL', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'SQL Console' })).toBeVisible()
})

test.describe('SQL console', () => {
  test('a failed query is an error, not an empty result', async ({ page }) => {
    // This is the regression that matters: executeRawSql returns its error
    // rather than throwing, and a page that only checks the catch branch shows
    // "0 rows" — which reads as "nothing matched" for what is really a typo.
    const body = await runSql(page, 'select * from does_not_exist')

    expect(body).toContain('Error:')
    expect(body).not.toContain('Query returned no results')
  })

  test('an unknown column is an error too', async ({ page }) => {
    expect(await runSql(page, 'select typo_column from packets')).toContain('Error:')
  })

  test('a failed query is not recorded as one that worked', async ({ page }) => {
    await runSql(page, 'select * from does_not_exist')
    const history = page.getByText('📋 Query History')
    await expect(history).toBeHidden()
  })

  test('a working query still returns rows', async ({ page }) => {
    const body = await runSql(
      page,
      'select type, count(*) as n from messages group by type order by n desc'
    )
    expect(body).toMatch(/Results \(4 rows\)/)
    expect(body).not.toContain('Error:')
  })

  test('the address bits the filter relies on are populated', async ({ page }) => {
    const body = await runSql(page, "select prefix, prefix_bits from nlri where prefix = '10.0.12.0'")
    // 10.0.12.0/24 -> 00001010 00000000 00001100
    expect(body).toContain('4:000010100000000000001100')
  })

  test('packets carry their address bits', async ({ page }) => {
    const body = await runSql(page, 'select count(*) as n from packets where src_ip_bits is null')
    expect(body).toContain('Results (1 rows)')
    expect(body).not.toContain('Error:')
  })
})
