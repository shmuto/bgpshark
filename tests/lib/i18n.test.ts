import { afterEach, describe, expect, test } from 'bun:test'
import {
  LOCALE_STORAGE_KEY,
  LEGACY_MANUAL_LANGUAGE_KEY,
  detectInitialLocale,
  getMessages,
  isLocale,
} from '../../src/i18n'
import { BGP_ERROR_CODES, getErrorHint, getErrorInfo } from '../../src/lib/bgp/errors'
import {
  checkCaptureFile,
  formatCaptureFileIssue,
  validateCaptureFile,
  MAX_FILE_SIZE,
} from '../../src/lib/file-constraints'
import { formatLoadProgressLabel, loadProgress } from '../../src/lib/load-progress'
import { getSuggestions } from '../../src/lib/filter/parser'
import { computeAlerts, computeTransportAlerts } from '../../src/components/dashboard/alerts'
import { buildScenario, PRESETS } from '../../src/lib/build'
import { parsePcap } from '../../src/lib/pcap/parser'
import { parseBgpFromPackets } from '../../src/lib/bgp/parser'

const HAS_JAPANESE = /[\u3040-\u30ff\u4e00-\u9faf]/

function decodePreset(presetId: string) {
  const preset = PRESETS.find((p) => p.id === presetId)
  if (!preset) throw new Error(`Missing preset ${presetId}`)
  const capture = buildScenario(preset.build())
  const buffer = capture.bytes.buffer.slice(
    capture.bytes.byteOffset,
    capture.bytes.byteOffset + capture.bytes.byteLength
  ) as ArrayBuffer
  const pcap = parsePcap(buffer)
  const bgp = parseBgpFromPackets(pcap.packets)
  return { bgp: bgp.packets, all: pcap.allPackets }
}

describe('i18n locale helpers', () => {
  const originalWindow = globalThis.window
  const originalNavigator = globalThis.navigator

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    })
  })

  function mockEnvironment(storage: Record<string, string>, languages: string[]) {
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: (key: string) => (key in storage ? storage[key] : null),
          setItem: (key: string, value: string) => {
            storage[key] = value
          },
        },
      },
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        languages,
        language: languages[0] ?? 'en-US',
      },
      configurable: true,
      writable: true,
    })
  }

  test('validates supported locale tags', () => {
    expect(isLocale('en')).toBe(true)
    expect(isLocale('ja')).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale(null)).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })

  test('detects Japanese from navigator.languages when no preference is stored', () => {
    mockEnvironment({}, ['ja-JP', 'en-US'])
    expect(detectInitialLocale()).toBe('ja')

    mockEnvironment({}, ['en-US', 'ja'])
    expect(detectInitialLocale()).toBe('ja')

    mockEnvironment({}, ['en-US', 'fr-FR'])
    expect(detectInitialLocale()).toBe('en')
  })

  test('prefers stored bgpshark:language over browser languages', () => {
    mockEnvironment({ [LOCALE_STORAGE_KEY]: 'en' }, ['ja-JP'])
    expect(detectInitialLocale()).toBe('en')

    mockEnvironment({ [LOCALE_STORAGE_KEY]: 'ja' }, ['en-US'])
    expect(detectInitialLocale()).toBe('ja')
  })

  test('falls back to legacy bgpshark:manual-language key when new key is absent', () => {
    mockEnvironment({ [LEGACY_MANUAL_LANGUAGE_KEY]: 'ja' }, ['en-US'])
    expect(detectInitialLocale()).toBe('ja')

    mockEnvironment(
      { [LOCALE_STORAGE_KEY]: 'en', [LEGACY_MANUAL_LANGUAGE_KEY]: 'ja' },
      ['ja-JP']
    )
    expect(detectInitialLocale()).toBe('en')
  })

  test('returns distinct English and Japanese catalogs', () => {
    const en = getMessages('en')
    const ja = getMessages('ja')
    expect(en.nav.dashboard).toBe('Dashboard')
    expect(ja.nav.dashboard).toBe('ダッシュボード')
    expect(ja.app.title).toMatch(HAS_JAPANESE)
  })
})

describe('Japanese BGP error hints', () => {
  test('every RFC error code and subcode in BGP_ERROR_CODES has a Japanese hint', () => {
    for (const [codeStr, codeDef] of Object.entries(BGP_ERROR_CODES)) {
      const code = Number(codeStr)
      for (const [subcodeStr, subDef] of Object.entries(codeDef.subcodes)) {
        const subcode = Number(subcodeStr)
        const jaHint = getErrorHint(code, subcode, 'ja')
        expect(jaHint, `code ${code} subcode ${subcode} should have Japanese hint`).toMatch(
          HAS_JAPANESE
        )
        expect(jaHint).not.toBe(subDef.hint)

        // RFC code/subcode names remain standard English even when hint is localized.
        const info = getErrorInfo(code, subcode, 'ja')
        expect(info.codeName).toBe(codeDef.name)
        expect(info.subcodeName).toBe(subDef.name)
        expect(info.hint).toBe(jaHint)
      }
    }
  })

  test('unknown codes and subcodes return localized fallback hints', () => {
    expect(getErrorHint(99, 0, 'ja')).toMatch(HAS_JAPANESE)
    expect(getErrorHint(2, 99, 'ja')).toMatch(HAS_JAPANESE)
    expect(getErrorHint(2, 99, 'ja')).not.toBe(getErrorHint(2, 99, 'en'))
  })
})

describe('localized domain helpers', () => {
  test('validateCaptureFile and CaptureFileIssue helpers support switching locale', () => {
    const badExt = new File(['hello'], 'notes.txt')
    const issue = checkCaptureFile(badExt)
    expect(issue).toEqual({ kind: 'invalidType' })
    expect(formatCaptureFileIssue(issue!, 'en')).toContain('Invalid file type')
    expect(formatCaptureFileIssue(issue!, 'ja')).toMatch(HAS_JAPANESE)
    expect(validateCaptureFile(badExt, 'ja')).toMatch(HAS_JAPANESE)

    const tooBig = { name: 'big.pcap', size: MAX_FILE_SIZE + 1024 } as File
    const sizeIssue = checkCaptureFile(tooBig)
    expect(sizeIssue?.kind).toBe('tooLarge')
    expect(formatCaptureFileIssue(sizeIssue!, 'en')).toContain('File too large')
    expect(formatCaptureFileIssue(sizeIssue!, 'ja')).toMatch(HAS_JAPANESE)
    expect(validateCaptureFile(tooBig, 'ja')).toMatch(HAS_JAPANESE)
  })

  test('loadProgress formats stages and row counts in Japanese', () => {
    expect(loadProgress('parsing', undefined, undefined, 'ja').label).toBe('パケットを解析中')
    expect(loadProgress('database', undefined, undefined, 'ja').label).toBe(
      'DuckDB へ読み込み中 — 行データを準備中'
    )
    expect(formatLoadProgressLabel('database', 1200, 3400, 'ja')).toBe(
      'DuckDB へ読み込み中 — 1,200 / 3,400 行'
    )
  })

  test('computeAlerts and computeTransportAlerts localize titles and details', () => {
    const flap = decodePreset('flap')
    const flapAlertsJa = computeAlerts(flap.bgp, flap.all, 'ja')
    expect(flapAlertsJa.some((a) => a.title.includes('経路フラップ'))).toBe(true)

    const refused = decodePreset('connection-refused')
    const refusedAlertsJa = computeTransportAlerts(refused.all, 'ja')
    expect(refusedAlertsJa.some((a) => a.title.includes('TCP ポート 179'))).toBe(true)
    expect(refusedAlertsJa[0].detail).toMatch(HAS_JAPANESE)
  })

  test('getSuggestions localizes field and operator descriptions in Japanese', () => {
    const fieldSuggestions = getSuggestions('src_i', 5, [], 'ja')
    expect(fieldSuggestions[0]?.text).toBe('src_ip')
    expect(fieldSuggestions[0]?.description).toMatch(HAS_JAPANESE)

    const opSuggestions = getSuggestions('med ', 4, [], 'ja')
    expect(opSuggestions.some((s) => s.text === '>' && s.description?.includes('より大きい'))).toBe(
      true
    )
  })
})
