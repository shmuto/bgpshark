import { useI18n } from '../../i18n'

/**
 * Header language switch (EN ↔ 日本語).
 *
 * Mirrors ThemeToggle's compact footprint so narrow viewports keep the
 * navigation links reachable without horizontal overflow: globe icon alone on
 * small screens, with the active language label beside it from `sm:` upward.
 */
export function LanguageToggle() {
  const { locale, toggleLocale, t } = useI18n()
  const label = locale === 'en' ? t.language.switchToJa : t.language.switchToEn

  return (
    <button
      type="button"
      onClick={toggleLocale}
      title={label}
      aria-label={label}
      data-testid="language-toggle"
      className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-strong"
    >
      <GlobeIcon />
      <span className="hidden sm:inline">
        {locale === 'ja' ? t.language.badgeJa : t.language.badgeEn}
      </span>
    </button>
  )
}

function GlobeIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.6 9h16.8M3.6 15h16.8M12 3a13.5 13.5 0 010 18M12 3a13.5 13.5 0 000 18"
      />
    </svg>
  )
}
