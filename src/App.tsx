import { Header, MainContent, FileDropzone, WarningBanner } from './components'
import { useBgpAnalyzer } from './hooks/useBgpAnalyzer'
import { useFileDropzone } from './hooks/useFileDropzone'

function App() {
  const { state, loadFile, selectPacket, reset } = useBgpAnalyzer()

  // Enable global drag & drop (disabled during loading)
  const { isDragOver, error: dropError, clearError } = useFileDropzone({
    onFileLoad: loadFile,
    disabled: state.status === 'loading',
  })

  return (
    <div className="h-screen flex flex-col relative overflow-hidden">
      <Header onReset={state.status === 'ready' ? reset : undefined} />

      {state.status === 'idle' || state.status === 'loading' ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <FileDropzone
            onFileLoad={loadFile}
            isLoading={state.status === 'loading'}
          />
        </div>
      ) : state.status === 'error' ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <div className="text-red-600 text-lg font-medium mb-2">Error</div>
            <div className="text-gray-600 mb-4">{state.error}</div>
            <button
              onClick={reset}
              className="px-4 py-2 bg-gray-800 text-white rounded hover:bg-gray-700"
            >
              Try Again
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {state.warnings.length > 0 && (
            <WarningBanner warnings={state.warnings} />
          )}
          <MainContent
            packets={state.packets}
            allPackets={state.allPackets}
            selectedIndex={state.selectedPacketIndex}
            onSelectPacket={selectPacket}
            fileName={state.fileName}
          />
        </div>
      )}

      {/* Global drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 top-12 bg-blue-500/20 border-4 border-dashed border-blue-500 flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-white rounded-lg shadow-lg p-6 text-center">
            <svg
              className="w-12 h-12 mx-auto text-blue-500 mb-3"
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
            <p className="text-lg font-medium text-gray-700">Drop pcap file to load</p>
          </div>
        </div>
      )}

      {/* Global drop error toast */}
      {dropError && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-3 z-50">
          <span>{dropError}</span>
          <button
            onClick={clearError}
            className="text-white/80 hover:text-white"
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

export default App
