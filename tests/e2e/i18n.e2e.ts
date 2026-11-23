import { test, expect } from '@playwright/test'
import { openSessionsTab } from './helpers'

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
    await page.getByRole('button', { name: 'その他' }).click()
    await expect(page.getByRole('link', { name: /^作成/ })).toBeVisible()
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
    await page.waitForURL(/\/messages/, { timeout: 30_000 })

    // Workspace: sessions and findings beside every view
    await expect(page.getByRole('heading', { name: /^セッション/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /^検出事項/ })).toBeVisible()
    await expect(page.getByText('すべてのセッション')).toBeVisible()
    // Counts carry their unit: "23 件" left open whether it meant packets or
    // messages, and the total beside "すべてのセッション" had none at all.
    const rail = page.getByRole('complementary', { name: 'セッションと検出事項' })
    await expect(rail.getByRole('button', { name: /^すべてのセッション/ })).toContainText('68 メッセージ')
    await expect(rail.getByRole('button', { name: /^1\.1\.1\.1 ↔ 2\.2\.2\.2/ })).toContainText('23 メッセージ')
    await expect(rail.getByRole('heading', { name: /^検出事項/ })).toContainText('4 種類 · 計 18 回')

    // Messages: list, filter suggestions, column picker, NOTIFICATION troubleshooting hint
    await expect(page.getByText(/\d+ 件中 \d+ 件のパケットを表示/)).toBeVisible()
    await expect(page.getByRole('button', { name: '表示する列を設定' })).toContainText('列設定')

    // Filter to NOTIFICATION and verify Japanese troubleshooting hint + RFC code name preserved
    await page.getByLabel('フィルタ', { exact: true }).fill('type = NOTIFICATION')
    await page.keyboard.press('Escape')
    await page.getByRole('main').locator('tbody tr').first().click()
    await expect(page.getByText('トラブルシューティングのヒント')).toBeVisible()
    await expect(page.getByText('エラーコード')).toBeVisible()

    // Sessions: session table, then one session's OPEN comparison
    await openSessionsTab(page, '1.1.1.1')
    await expect(page.getByText('OPEN の比較', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'すべてのセッションを表示' }).click()

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
    await page.getByRole('button', { name: 'その他' }).click()
    await page.getByRole('link', { name: /^作成/ }).click()
    await page.waitForURL(/\/builder/)
    await expect(page.getByRole('heading', { name: 'キャプチャを作成' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'アナライザーで開く' })).toBeVisible()

    // Manual sync: switching Manual back to English also switches global header UI back to English
    await page.getByRole('button', { name: 'その他' }).click()
    await page.getByRole('link', { name: 'ヘルプ', exact: true }).click()
    await page.waitForURL(/\/manual/)
    await expect(page.getByRole('heading', { name: 'BGPShark ユーザーマニュアル' })).toBeVisible()

    await page.getByRole('button', { name: 'English' }).click()
    await expect(page.getByRole('heading', { name: 'BGPShark user manual' })).toBeVisible()
    await page.locator('header').getByRole('button', { name: 'More' }).click()
    await expect(page.locator('header').getByRole('link', { name: 'Help', exact: true })).toBeVisible()
  })

  test('migrates legacy bgpshark:manual-language preference to global UI', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('bgpshark:manual-language', 'ja')
    })
    await page.goto('./', { waitUntil: 'networkidle' })
    await expect(page.getByText('pcap ファイルをここにドロップ')).toBeVisible()
  })

  test('re-translates active validation errors when switching language', async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a capture'),
    })
    await expect(page.getByText(/Invalid file type/)).toBeVisible()

    // Switching language updates the already-visible error banner in place.
    await page.getByTestId('language-toggle').click()
    await expect(page.getByText(/対応していないファイル形式です/)).toBeVisible()
  })
})

test.describe('Japanese UI layout stability', () => {
  test.use({ locale: 'ja-JP', viewport: { width: 480, height: 900 } })

  test('compact viewport has no horizontal overflow in Japanese UI', async ({ page }) => {
    await page.goto('./', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /sample\.pcapng で試す/ }).click()
    await page.waitForURL('**/messages', { timeout: 30_000 })
    await expect(page.getByText(/\d+ 件中 \d+ 件のパケットを表示/)).toBeVisible()
    await expect(page.getByRole('link', { name: 'SQL', exact: true })).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
