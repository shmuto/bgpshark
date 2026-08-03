import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { FileDropzone } from '../components'

export function FileUploadPage() {
  const { status, loadFile, error, reset } = useApp()
  const navigate = useNavigate()

  // Navigate to the message explorer when ready
  useEffect(() => {
    if (status === 'ready') {
      navigate('/messages')
    }
  }, [status, navigate])

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 bg-gray-50">
      {status === 'error' ? (
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 bg-red-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <div className="text-red-600 text-lg font-medium mb-2">Error</div>
          <div className="text-gray-600 mb-4 max-w-md">{error}</div>
          <button
            onClick={reset}
            className="px-4 py-2 bg-gray-800 text-white rounded hover:bg-gray-700"
          >
            Try Again
          </button>
        </div>
      ) : (
        <>
          <FileDropzone
            onFileLoad={loadFile}
            isLoading={status === 'loading' || status === 'initializing'}
          />

          {/* Features section */}
          <div className="mt-12 max-w-2xl w-full">
            <div className="border-t border-gray-200 pt-8">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Features</h2>
              <ul className="grid gap-3 text-sm text-gray-600">
                <FeatureItem>
                  Analyze BGP OPEN, UPDATE, NOTIFICATION, KEEPALIVE messages
                </FeatureItem>
                <FeatureItem>
                  Troubleshoot BGP session issues with detailed error hints
                </FeatureItem>
                <FeatureItem>
                  Filter and search with SQL-powered queries
                </FeatureItem>
                <FeatureItem>
                  100% client-side - your data never leaves your browser
                </FeatureItem>
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function FeatureItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <svg className="w-5 h-5 text-green-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
      <span>{children}</span>
    </li>
  )
}
