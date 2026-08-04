import { NavLink, useNavigate } from 'react-router-dom'
import { useApp } from '../../context/AppContext'
import { ThemeToggle } from './ThemeToggle'

export function AppHeader() {
  const { status, fileName, reset } = useApp()
  const navigate = useNavigate()
  const isReady = status === 'ready'

  const handleNewFile = () => {
    reset()
    navigate('/')
  }

  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-hair bg-surface px-4 py-2.5">
      {/* min-w-0 lets this side shrink so the nav can scroll instead of pushing
          the buttons on the right off the screen */}
      <div className="flex min-w-0 items-center gap-3 sm:gap-6">
        {/* Logo */}
        <NavLink to={isReady ? '/messages' : '/'} className="flex shrink-0 items-center gap-2.5">
          <span className="text-lg leading-none" aria-hidden="true">🦈</span>
          <h1 className="hidden text-sm font-semibold tracking-tight text-strong sm:block">
            BGPShark
          </h1>
        </NavLink>

        {/* Navigation */}
        {isReady && (
          <nav className="-mx-1 flex items-center gap-1 overflow-x-auto px-1">
            <NavItem to="/dashboard">Dashboard</NavItem>
            <NavItem to="/messages">Messages</NavItem>
            <NavItem to="/neighbors">Neighbors</NavItem>
            <NavItem to="/routes">Routes</NavItem>
            <NavItem to="/sql">SQL</NavItem>
          </nav>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* File name */}
        {fileName && (
          <span className="hidden max-w-[16rem] truncate rounded border border-hair bg-surface-sunken px-2 py-1 font-mono text-xs text-muted md:block">
            {fileName}
          </span>
        )}

        {/* New File button */}
        {isReady && (
          <button
            onClick={handleNewFile}
            className="flex items-center gap-1.5 rounded border border-hair px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-hair-strong hover:text-strong"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New File
          </button>
        )}

        <ThemeToggle />

        {/* GitHub link */}
        <a
          href="https://github.com/shmuto/bgpshark"
          target="_blank"
          rel="noopener noreferrer"
          className="text-dim transition-colors hover:text-strong"
          aria-label="View on GitHub"
        >
          <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
            <path
              fillRule="evenodd"
              d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              clipRule="evenodd"
            />
          </svg>
        </a>
      </div>
    </header>
  )
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
          isActive
            ? 'bg-accent text-accent-fg'
            : 'text-muted hover:bg-surface-sunken hover:text-strong'
        }`
      }
    >
      {children}
    </NavLink>
  )
}
