import { createContext, useContext, type ReactNode } from 'react'
import type { BgpPacket } from '../lib/bgp/types'
import type { GenericPacket } from '../lib/pcap'
import { useBgpAnalyzer } from '../hooks/useBgpAnalyzer'
import type { LoadProgress } from '../lib/load-progress'

interface AppContextType {
  // State
  status: 'idle' | 'initializing' | 'loading' | 'ready' | 'error'
  packets: BgpPacket[]
  allPackets: GenericPacket[]
  linkType: number | null
  fileName: string | null
  warnings: string[]
  error: string | null
  selectedPacketIndex: number | null
  /** How far the load in flight has got; null when nothing is loading. */
  progress: LoadProgress | null

  // Actions
  loadFile: (file: File) => Promise<void>
  selectPacket: (index: number | null) => void
  reset: () => void
}

const AppContext = createContext<AppContextType | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const analyzer = useBgpAnalyzer()

  const value: AppContextType = {
    status: analyzer.state.status,
    packets: analyzer.state.packets,
    allPackets: analyzer.state.allPackets,
    linkType: analyzer.state.linkType,
    fileName: analyzer.state.fileName,
    warnings: analyzer.state.warnings,
    error: analyzer.state.error,
    selectedPacketIndex: analyzer.state.selectedPacketIndex,
    progress: analyzer.state.progress,
    loadFile: analyzer.loadFile,
    selectPacket: analyzer.selectPacket,
    reset: analyzer.reset,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const context = useContext(AppContext)
  if (!context) {
    throw new Error('useApp must be used within an AppProvider')
  }
  return context
}
