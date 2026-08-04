import type { ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AppProvider, useApp } from './context/AppContext'
import { AppHeader } from './components/layout/AppHeader'
import { ErrorBoundary, WarningBanner } from './components/common'
import { useFileDropzone } from './hooks/useFileDropzone'
import {
  FileUploadPage,
  DashboardPage,
  NeighborsPage,
  MessagesPage,
  RoutesPage,
  SqlConsolePage,
} from './pages'

/**
 * Gate for the screens that need a capture.
 *
 * The capture is restored from IndexedDB after the first render, so for a moment
 * "no capture" and "we have not looked yet" are the same state. Redirecting
 * during that moment is what threw away deep links, reloads and bookmarks, so
 * this waits for an answer instead — and when the answer really is "no capture",
 * it remembers where the user was headed so the upload screen can send them back
 * there.
 */
function RequireCapture({ children }: { children: ReactNode }) {
  const { status } = useApp()
  const location = useLocation()

  if (status === 'initializing' || status === 'loading') {
    return <RestoringCapture />
  }

  if (status !== 'ready') {
    return (
      <Navigate to="/" replace state={{ from: `${location.pathname}${location.search}` }} />
    )
  }

  return <>{children}</>
}

function RestoringCapture() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-canvas">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-hair-strong border-t-accent" />
      <p className="text-sm text-muted">Restoring capture…</p>
    </div>
  )
}

function AppContent() {
  const { status, loadFile, warnings } = useApp()

  // Enable global drag & drop (disabled during loading)
  const { isDragOver, error: dropError, clearError } = useFileDropzone({
    onFileLoad: loadFile,
    disabled: status === 'loading' || status === 'initializing',
  })

  const isReady = status === 'ready'

  return (
    <div className="h-screen flex flex-col relative overflow-hidden">
      <ErrorBoundary>
        <AppHeader />
      </ErrorBoundary>

      {/* What the parser could not make sense of. Collapsed to a single line
          unless the user opens it, and it belongs to the capture rather than to
          any one screen, so it sits above the routes. */}
      <WarningBanner warnings={warnings} />

      <ErrorBoundary>
        <Routes>
          {/* File Upload - always accessible */}
          <Route path="/" element={<FileUploadPage />} />

          {/* Protected routes - wait for the restore, then redirect if there is no file */}
          <Route
            path="/dashboard"
            element={<RequireCapture><DashboardPage /></RequireCapture>}
          />
          <Route
            path="/neighbors"
            element={<RequireCapture><NeighborsPage /></RequireCapture>}
          />
          <Route
            path="/messages"
            element={<RequireCapture><MessagesPage /></RequireCapture>}
          />
          <Route
            path="/routes"
            element={<RequireCapture><RoutesPage /></RequireCapture>}
          />
          <Route
            path="/sql"
            element={<RequireCapture><SqlConsolePage /></RequireCapture>}
          />

          {/* Catch all - redirect to messages or home */}
          <Route
            path="*"
            element={<Navigate to={isReady ? '/messages' : '/'} replace />}
          />
        </Routes>
      </ErrorBoundary>

      {/* Global drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 top-12 bg-accent/20 border-4 border-dashed border-accent flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-surface rounded-lg shadow-lg p-6 text-center">
            <svg
              className="w-12 h-12 mx-auto text-accent mb-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <p className="text-lg font-medium text-strong">Drop pcap file to load</p>
          </div>
        </div>
      )}

      {/* Global drop error toast */}
      {dropError && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-critical text-on-solid px-4 py-2 rounded-lg shadow-lg flex items-center gap-3 z-50">
          <span>{dropError}</span>
          <button
            onClick={clearError}
            className="text-accent-fg/80 hover:text-accent-fg"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

function App() {
  return (
    <BrowserRouter basename="/bgpshark">
      <AppProvider>
        <AppContent />
      </AppProvider>
    </BrowserRouter>
  )
}

export default App
