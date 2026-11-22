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
 * Which language to open the app — and its user manual — with.
 *
 * The UI and the user manual share one language preference, so switching in
 * either the header or the manual changes both together. A remembered choice
 * wins (`bgpshark:language`, falling back to the legacy
 * `bgpshark:manual-language` key so existing manual readers keep their choice),
 * then the browser's languages: someone browsing in Japanese is more likely to
 * want the Japanese UI and manual than to want to be asked, and the toggle is
 * right there for when the guess is wrong.
 */
export function detectInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(stored)) return stored
    const legacy = window.localStorage.getItem(LEGACY_MANUAL_LANGUAGE_KEY)
    if (isLocale(legacy)) return legacy
  } catch {
    // Storage can be unavailable — private mode, a blocked origin. Not knowing
    // the reader's last choice is not a reason to fail to render the app.
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
