import { test, expect } from '@playwright/test'

/**
 * Japanese UI localization & language switcher.
 *
 * Covers initial locale auto-detection from the browser, switching via the
 * header toggle across every screen (including alerts, NOTIFICATION hints,
 * capability diff, route analysis, SQL console, builder, and manual sync),
 * persistence across reloads, and layout stability in Japanese.
 */
test.describe('Japanese browser auto-detection', () => {
  test.use({ locale: 'ja-JP' })

  test('starts in Japanese automatically when browser language is ja-JP', async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })

    expect(await page.locator('html').getAttribute('lang')).toBe('ja')
    await expect(page).toHaveTitle('BGP パケットアナライザー')
    await expect(page.getByText('pcap ファイルをここにドロップ')).toBeVisible()
    await expect(page.getByRole('button', { name: /sample\.pcapng で試す/ })).toBeVisible()
    await expect(page.getByRole('link', { name: '作成', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'ヘルプ', exact: true })).toBeVisible()

    // Manual page follows the global Japanese locale automatically too.
    await page.getByRole('link', { name: 'ヘルプ', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'BGPShark ユーザーマニュアル' })).toBeVisible()
  })
})

test.describe('header language toggle across screens', () => {
  test('switches between English and Japanese, persists across reloads, and stays synced with the manual', async ({
    page,
  }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await expect(page.getByText('Drop pcap file here')).toBeVisible()

    // Switch to Japanese via header toggle
    await page.getByTestId('language-toggle').click()
    expect(await page.locator('html').getAttribute('lang')).toBe('ja')
    await expect(page.getByText('pcap ファイルをここにドロップ')).toBeVisible()

    // Choice survives reload
    await page.reload({ waitUntil: 'networkidle' })
    expect(await page.locator('html').getAttribute('lang')).toBe('ja')
    await expect(page.getByText('pcap ファイルをここにドロップ')).toBeVisible()

    // Load bundled sample capture in Japanese UI
    await page.getByRole('button', { name: /sample\.pcapng で試す/ }).click()
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 })

    // Dashboard: headings, cards, alerts, neighbor summary
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /^アラート/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'BGP ネイバー' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'タイムライン' })).toBeVisible()

    // Messages: list, filter suggestions, column picker, NOTIFICATION troubleshooting hint
    await page.getByRole('link', { name: 'メッセージ', exact: true }).click()
    await page.waitForURL(/\/messages/)
    await expect(page.getByText(/\d+ 件中 \d+ 件のパケットを表示/)).toBeVisible()
    await expect(page.getByRole('button', { name: '表示する列を設定' })).toContainText('列設定')

    // Filter to NOTIFICATION and verify Japanese troubleshooting hint + RFC code name preserved
    await page.getByRole('button', { name: /NOTIFICATION/ }).first().click()
    await page.locator('tbody tr').first().click()
    await expect(page.getByText('トラブルシューティングのヒント')).toBeVisible()
    await expect(page.getByText('エラーコード')).toBeVisible()

    // Neighbors: router table + Capability Diff
    await page.getByRole('link', { name: 'ネイバー', exact: true }).click()
    await page.waitForURL(/\/neighbors/)
    await expect(page.getByRole('heading', { name: 'ネイバー一覧' })).toBeVisible()
    await expect(page.getByText('メッセージ集計')).toBeVisible()

    // Routes: search match modes + route history
    await page.getByRole('link', { name: '経路', exact: true }).click()
    await page.waitForURL(/\/routes/)
    await expect(page.getByRole('heading', { name: 'プレフィックス統計' })).toBeVisible()
    await expect(page.getByRole('radio', { name: '完全一致' })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'サブネット' })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'スーパーネット' })).toBeVisible()

    // SQL console
    await page.getByRole('link', { name: 'SQL', exact: true }).click()
    await page.waitForURL(/\/sql/)
    await expect(page.getByRole('heading', { name: 'SQL コンソール' })).toBeVisible()
    await expect(page.getByText('クエリテンプレート')).toBeVisible()
    await expect(page.getByText('スキーマ')).toBeVisible()

    // Builder
    await page.getByRole('link', { name: '作成', exact: true }).click()
    await page.waitForURL(/\/builder/)
    await expect(page.getByRole('heading', { name: 'キャプチャを作成' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'アナライザーで開く' })).toBeVisible()

    // Manual sync: switching Manual back to English also switches global header UI back to English
    await page.getByRole('link', { name: 'ヘルプ', exact: true }).click()
    await page.waitForURL(/\/manual/)
    await expect(page.getByRole('heading', { name: 'BGPShark ユーザーマニュアル' })).toBeVisible()

    await page.getByRole('button', { name: 'English' }).click()
    await expect(page.getByRole('heading', { name: 'BGPShark user manual' })).toBeVisible()
    await expect(page.locator('header').getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible()
    await expect(page.locator('header').getByRole('link', { name: 'Help', exact: true })).toBeVisible()
  })

  test('migrates legacy bgpshark:manual-language preference to global UI', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('bgpshark:manual-language', 'ja')
    })
    await page.goto('./', { waitUntil: 'networkidle' })
    await expect(page.getByText('pcap ファイルをここにドロップ')).toBeVisible()
  })
})

test.describe('Japanese UI layout stability', () => {
  test.use({ locale: 'ja-JP', viewport: { width: 480, height: 900 } })

  test('compact viewport has no horizontal overflow in Japanese UI', async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /sample\.pcapng で試す/ }).click()
    await page.waitForURL('**/dashboard', { timeout: 30_000 })

    await page.getByRole('link', { name: 'メッセージ', exact: true }).click()
    await page.waitForURL('**/messages')
    await expect(page.getByText(/\d+ 件中 \d+ 件のパケットを表示/)).toBeVisible()
    await expect(page.getByRole('link', { name: 'SQL', exact: true })).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
