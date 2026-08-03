import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AppProvider, useApp } from './context/AppContext'
import { AppHeader } from './components/layout/AppHeader'
import { ErrorBoundary } from './components/common'
import { useFileDropzone } from './hooks/useFileDropzone'
import {
  FileUploadPage,
  DashboardPage,
  NeighborsPage,
  MessagesPage,
  RoutesPage,
  SqlConsolePage,
} from './pages'

function AppContent() {
  const { status, loadFile } = useApp()

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

      <ErrorBoundary>
        <Routes>
          {/* File Upload - always accessible */}
          <Route path="/" element={<FileUploadPage />} />

          {/* Protected routes - redirect to / if no file loaded */}
          <Route
            path="/dashboard"
            element={isReady ? <DashboardPage /> : <Navigate to="/" replace />}
          />
          <Route
            path="/neighbors"
            element={isReady ? <NeighborsPage /> : <Navigate to="/" replace />}
          />
          <Route
            path="/messages"
            element={isReady ? <MessagesPage /> : <Navigate to="/" replace />}
          />
          <Route
            path="/routes"
            element={isReady ? <RoutesPage /> : <Navigate to="/" replace />}
          />
          <Route
            path="/sql"
            element={isReady ? <SqlConsolePage /> : <Navigate to="/" replace />}
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
