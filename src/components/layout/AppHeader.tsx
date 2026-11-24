import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useApp } from '../../context/AppContext'
import { DatabaseLoadStatus } from '../common/LoadProgressBar'
import { useI18n } from '../../i18n'
import { LanguageToggle } from './LanguageToggle'
import { ThemeToggle } from './ThemeToggle'

/**
 * One thin bar: what is open, and the few controls that are not about it.
 *
 * The analysis views moved into the workspace's own tab row, so this bar no
 * longer carries navigation. The capture's name sits where the eye lands after
 * the logo and doubles as the way to open another one; Build, Help and the
 * repository link are reached rarely enough to live behind one menu button.
 */
export function AppHeader() {
  const { status, fileName, packets, reset, dbStatus, dbProgress } = useApp()
  const { t } = useI18n()
  const navigate = useNavigate()
  const isReady = status === 'ready'

  const openAnother = () => {
    reset()
    navigate('/')
  }

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-hair bg-surface px-3">
      <NavLink to={isReady ? '/messages' : '/'} className="flex shrink-0 items-center gap-2">
        <span className="text-base leading-none" aria-hidden="true">🦈</span>
        <h1 className="hidden text-sm font-semibold tracking-tight text-strong sm:block">BGPShark</h1>
      </NavLink>

      {isReady && fileName && (
        <button
          type="button"
          onClick={openAnother}
          title={t.nav.openAnother}
          className="flex min-w-0 items-center gap-2 rounded border border-hair bg-surface-sunken px-2 py-1 text-xs transition-colors hover:border-hair-strong"
        >
          <span className="truncate font-medium text-strong">{fileName}</span>
          <span className="hidden shrink-0 font-mono text-[11px] text-muted md:inline">
            {t.nav.captureMeta(packets.length)}
          </span>
          <span className="sr-only">— {t.nav.openAnother}</span>
        </button>
      )}

      {isReady && dbStatus === 'loading' && dbProgress && <DatabaseLoadStatus progress={dbProgress} />}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <LanguageToggle />
        <ThemeToggle />
        <AppMenu />
      </div>
    </header>
  )
}

function AppMenu() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item = 'flex items-center justify-between gap-6 rounded px-2.5 py-1.5 text-xs text-body hover:bg-surface-sunken hover:text-strong'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t.nav.menu}
        title={t.nav.menu}
        className="grid h-7 w-7 place-items-center rounded text-muted transition-colors hover:bg-surface-raised hover:text-strong"
      >
        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <nav
          aria-label={t.nav.toolsAria}
          className="absolute right-0 top-full z-50 mt-1 flex w-56 flex-col rounded-md border border-hair-strong bg-surface p-1 shadow-lg"
          onClick={() => setOpen(false)}
        >
          <NavLink to="/builder" className={item}>
            {t.nav.build}
            <span className="text-[11px] text-dim">{t.nav.buildHint}</span>
          </NavLink>
          <NavLink to="/manual" className={item}>
            {t.nav.help}
          </NavLink>
          <div className="my-1 border-t border-hair" />
          <a href="https://github.com/shmuto/bgpshark" target="_blank" rel="noopener noreferrer" className={item}>
            {t.nav.viewOnGithub}
            <span className="text-dim" aria-hidden="true">↗</span>
          </a>
        </nav>
      )}
    </div>
  )
}
