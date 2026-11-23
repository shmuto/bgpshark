import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { WorkspaceProvider, useWorkspace } from '../../context/WorkspaceContext'
import { SessionRail } from './SessionRail'
import { useIsCompact } from '../../hooks/useMediaQuery'
import { useI18n } from '../../i18n'

/**
 * The one screen a capture is investigated on.
 *
 * What used to be five sibling pages — a dashboard in front, then Messages,
 * Neighbors, Routes and SQL — is one workspace: the sessions and findings down
 * the left, the views as tabs on the right. The dashboard had become a waiting
 * room between loading a file and reading it; its findings are now beside
 * every view instead of in front of them.
 */
export function WorkspaceLayout() {
  return (
    <WorkspaceProvider>
      <Workspace />
    </WorkspaceProvider>
  )
}

function Workspace() {
  const { t } = useI18n()
  const isCompact = useIsCompact()
  const [railOpen, setRailOpen] = useState(false)
  const location = useLocation()

  // A drawer left open over the next screen hides what the click was for.
  useEffect(() => setRailOpen(false), [location.pathname, location.search])

  return (
    <div className="flex min-h-0 flex-1">
      {isCompact && railOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setRailOpen(false)} aria-hidden="true" />
          <aside
            aria-label={t.workspace.railAria}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,88vw)] flex-col bg-surface shadow-xl"
          >
            <SessionRail onNavigate={() => setRailOpen(false)} />
          </aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceTabs onOpenRail={isCompact ? () => setRailOpen(true) : undefined} />
        <main className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>

      {/* After the view in the document, before it on screen: the view is what
          keyboard and screen-reader users reach first, and the column is one
          landmark away. */}
      {!isCompact && (
        <aside
          aria-label={t.workspace.railAria}
          className="order-first flex w-64 shrink-0 flex-col border-r border-hair bg-surface"
        >
          <SessionRail />
        </aside>
      )}
    </div>
  )
}

function WorkspaceTabs({ onOpenRail }: { onOpenRail?: () => void }) {
  const { t } = useI18n()
  const { scope, setScope } = useWorkspace()

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-1 border-b border-hair bg-surface px-2">
      {onOpenRail && (
        <button
          type="button"
          onClick={onOpenRail}
          aria-label={t.workspace.openRail}
          className="my-1 flex items-center rounded px-2 text-muted hover:bg-surface-sunken hover:text-strong"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
      )}
      <nav aria-label={t.nav.captureAria} className="flex min-w-0 items-stretch overflow-x-auto">
        <Tab to="/messages">{t.nav.messages}</Tab>
        <Tab to="/sessions">{t.nav.sessions}</Tab>
        <Tab to="/routes">{t.nav.routes}</Tab>
        <Tab to="/sql">{t.nav.sql}</Tab>
      </nav>
      {/* The scope is said once, here, rather than in every view: it is the
          one thing that changes what all of them show. */}
      {scope && (
        <div className="ml-auto flex min-w-0 items-center pl-2">
          <span className="flex min-w-0 items-center gap-1 rounded bg-accent-subtle py-0.5 pl-2 pr-0.5 font-mono text-[11px] text-accent">
            <span className="truncate" data-testid="session-scope">{scope.replace('|', ' ↔ ')}</span>
            <button
              type="button"
              onClick={() => setScope(null)}
              aria-label={t.workspace.clearScope}
              title={t.workspace.clearScope}
              className="grid h-4 w-4 shrink-0 place-items-center rounded-sm hover:bg-accent hover:text-accent-fg"
            >
              ×
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

function Tab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `-mb-px flex shrink-0 items-center border-b-2 px-3 text-xs transition-colors ${
          isActive ? 'border-accent font-semibold text-strong' : 'border-transparent text-muted hover:text-strong'
        }`
      }
    >
      {children}
    </NavLink>
  )
}
