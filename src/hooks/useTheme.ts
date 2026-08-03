import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'bgpshark:theme'

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    // Private mode or blocked storage; fall through to the system default.
  }
  return 'system'
}

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Theme preference, persisted across sessions.
 *
 * The stylesheet already renders the correct palette on first paint via
 * prefers-color-scheme, so this hook only has to stamp data-theme when the user
 * has overridden the system. That ordering is forced by the production CSP,
 * which blocks the inline script the usual no-flash trick relies on.
 */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readStoredPreference)
  const [systemIsDark, setSystemIsDark] = useState(prefersDark)

  // Track the OS setting so the toggle reports the right state while on 'system'
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemIsDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (preference === 'system') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', preference)
    }

    try {
      if (preference === 'system') {
        localStorage.removeItem(STORAGE_KEY)
      } else {
        localStorage.setItem(STORAGE_KEY, preference)
      }
    } catch {
      // Persistence is a convenience; the theme still applies for this session.
    }
  }, [preference])

  const isDark = preference === 'dark' || (preference === 'system' && systemIsDark)

  /** Cycle light -> dark -> system, so returning to the OS setting stays reachable. */
  const cycleTheme = useCallback(() => {
    setPreference((current) =>
      current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light'
    )
  }, [])

  return { preference, isDark, setPreference, cycleTheme }
}
