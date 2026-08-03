import { useTheme, type ThemePreference } from '../../hooks/useTheme'

const NEXT_LABEL: Record<ThemePreference, string> = {
  light: 'Switch to dark theme',
  dark: 'Follow system theme',
  system: 'Switch to light theme',
}

const STATE_LABEL: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'Auto',
}

export function ThemeToggle() {
  const { preference, isDark, cycleTheme } = useTheme()

  return (
    <button
      type="button"
      onClick={cycleTheme}
      title={NEXT_LABEL[preference]}
      aria-label={NEXT_LABEL[preference]}
      className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-strong"
    >
      {isDark ? <MoonIcon /> : <SunIcon />}
      <span className="hidden sm:inline tabular-nums">{STATE_LABEL[preference]}</span>
    </button>
  )
}

function SunIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path
        strokeLinecap="round"
        d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
      />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"
      />
    </svg>
  )
}
