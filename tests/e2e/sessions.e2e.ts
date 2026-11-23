import { test, expect } from '@playwright/test'
import { loadSample, openSessionsTab } from './helpers'

/**
 * The Sessions tab: every session in a table, or — once one is chosen in the
 * workspace — that session's OPEN comparison and events on the first screen.
 */
test.describe('the sessions tab', () => {
  test.beforeEach(async ({ page }) => {
    await loadSample(page)
    await openSessionsTab(page)
  })

  test('lists every session with its state and worst finding', async ({ page }) => {
    const rows = page.getByRole('main').locator('tbody tr')
    await expect(rows).toHaveCount(3)
    await expect(rows.first()).toContainText('Established')
    await expect(rows.first()).toContainText('Critical')
  })

  test('choosing a row opens the OPEN comparison on the first screen', async ({ page }) => {
    await openSessionsTab(page, '10.0.13.3')

    await expect(page.getByTestId('session-scope')).toHaveText('10.0.13.1 ↔ 10.0.13.3')
    await expect(page.getByRole('heading', { name: '10.0.13.1 ↔ 10.0.13.3' })).toBeVisible()
    await expect(page.getByText('OPEN comparison', { exact: true })).toBeInViewport()

    // Clearing the scope goes back to the table.
    await page.getByRole('button', { name: 'Show all sessions' }).click()
    await expect(page.getByRole('main').locator('tbody tr')).toHaveCount(3)
  })

  test('prefix counts are what was on the wire, per direction, without an estimate', async ({ page }) => {
    await openSessionsTab(page, '10.0.13.3')
    await expect(page.getByText('Prefixes from 10.0.13.1')).toBeVisible()
    await expect(page.getByText('Prefixes from 10.0.13.3')).toBeVisible()
    await expect(page.getByText('Est. Prefixes')).toHaveCount(0)
  })

  test('an event opens its packet in Messages', async ({ page }) => {
    await openSessionsTab(page, '1.1.1.1')
    await page.getByRole('main').getByRole('button', { name: /NOTIFICATION.*Hard Reset/ }).click()

    await page.waitForURL('**/messages**')
    await expect(page.getByText(/^Packet #12$/)).toBeVisible()
  })

  test('the events list can widen to every message', async ({ page }) => {
    await openSessionsTab(page, '1.1.1.1')
    await expect(page.getByRole('heading', { name: 'Events (7)' })).toBeVisible()
    await page.getByRole('button', { name: /^All \(\d+\)$/ }).click()
    await expect(page.getByRole('heading', { name: 'Events (23)' })).toBeVisible()
  })
})

test('an old Neighbors link opens the session it named', async ({ page }) => {
  await loadSample(page)
  await page.goto('./neighbors?router=1.1.1.1&peer=10.0.13.3', { waitUntil: 'networkidle' })
  await expect(page).toHaveURL(/\/sessions$/)
  await expect(page.getByTestId('session-scope')).toHaveText('10.0.13.1 ↔ 10.0.13.3')
})
