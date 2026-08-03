import { Component, type ErrorInfo, type ReactNode } from 'react'
import { clearPcapFile } from '../../lib/storage'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  errorInfo: ErrorInfo | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, errorInfo: null }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error', error, errorInfo)
    this.setState({ errorInfo })
  }

  handleReload = () => {
    window.location.reload()
  }

  handleClearAndReset = () => {
    clearPcapFile()
      .catch((err) => {
        console.error('Failed to clear stored pcap file', err)
      })
      .finally(() => {
        window.location.reload()
      })
  }

  render() {
    const { error, errorInfo } = this.state

    if (error) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 bg-canvas">
          <div className="max-w-lg w-full text-center">
            <div className="w-16 h-16 mx-auto mb-4 bg-critical-subtle rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-critical" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>

            <div className="text-critical text-lg font-medium mb-2">Something went wrong</div>
            <p className="text-muted mb-4">
              The app hit an unexpected error, possibly while parsing the loaded pcap file.
            </p>

            <details className="mb-6 text-left bg-surface-sunken border border-hair rounded">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-body hover:bg-surface">
                Error details
              </summary>
              <div className="px-3 pb-3 max-h-48 overflow-auto">
                <pre className="text-xs font-mono text-body whitespace-pre-wrap break-words">
                  {error.message}
                  {errorInfo?.componentStack}
                </pre>
              </div>
            </details>

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.handleReload}
                className="px-4 py-2 bg-accent text-accent-fg rounded hover:bg-accent-hover"
              >
                Reload
              </button>
              <button
                onClick={this.handleClearAndReset}
                className="px-4 py-2 bg-critical text-on-solid rounded hover:opacity-90"
              >
                Clear stored file and reset
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
