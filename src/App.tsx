import { Header } from './components/Header'
import { FileDropzone } from './components/FileDropzone'
import { MainContent } from './components/MainContent'
import { WarningBanner } from './components/WarningBanner'
import { useBgpAnalyzer } from './hooks/useBgpAnalyzer'

function App() {
  const { state, loadFile, selectPacket, reset } = useBgpAnalyzer()

  return (
    <div className="min-h-screen flex flex-col">
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
        <div className="flex-1 flex flex-col">
          {state.warnings.length > 0 && (
            <WarningBanner warnings={state.warnings} />
          )}
          <MainContent
            packets={state.packets}
            selectedIndex={state.selectedPacketIndex}
            onSelectPacket={selectPacket}
            fileName={state.fileName}
          />
        </div>
      )}
    </div>
  )
}

export default App
