import { en, type Messages } from './en'
import { ja } from './ja'

export type Locale = 'en' | 'ja'
export type { Messages }

export const LOCALE_STORAGE_KEY = 'bgpshark:language'
/** Previous per-manual key — migrated transparently on first read. */
export const LEGACY_MANUAL_LANGUAGE_KEY = 'bgpshark:manual-language'

const CATALOGS: Record<Locale, Messages> = { en, ja }

export function getMessages(locale: Locale): Messages {
  return CATALOGS[locale]
}

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'en' || value === 'ja'
}

/**
 * Determine the initial UI language:
 * 1. Explicit user preference in localStorage (`bgpshark:language`, falling
 *    back to the legacy `bgpshark:manual-language` key so existing manual
 *    readers keep their choice).
 * 2. Browser language list (`navigator.languages` / `navigator.language`):
 *    any `ja` tag selects Japanese; everything else selects English.
 */
export function detectInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(stored)) return stored
    const legacy = window.localStorage.getItem(LEGACY_MANUAL_LANGUAGE_KEY)
    if (isLocale(legacy)) return legacy
  } catch {
    // Private mode or blocked storage; fall through to browser languages.
  }

  if (typeof navigator !== 'undefined') {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
    if (languages.some((tag) => typeof tag === 'string' && tag.toLowerCase().startsWith('ja'))) {
      return 'ja'
    }
  }
  return 'en'
}

export function saveLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Persistence is a convenience; the choice still applies for this session.
  }
}
