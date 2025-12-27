import { useState, useCallback } from 'react'
import { parsePcap, isPcapng, parsePcapng, type GenericPacket } from '../lib/pcap'
import { parseBgpFromPackets, type BgpPacket } from '../lib/bgp'

interface AnalyzerState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  fileName: string | null
  packets: BgpPacket[]
  allPackets: GenericPacket[]
  selectedPacketIndex: number | null
  warnings: string[]
  error: string | null
}

const initialState: AnalyzerState = {
  status: 'idle',
  fileName: null,
  packets: [],
  allPackets: [],
  selectedPacketIndex: null,
  warnings: [],
  error: null,
}

export function useBgpAnalyzer() {
  const [state, setState] = useState<AnalyzerState>(initialState)

  const loadFile = useCallback(async (file: File) => {
    setState((prev) => ({
      ...prev,
      status: 'loading',
      fileName: file.name,
      error: null,
    }))

    try {
      const buffer = await file.arrayBuffer()

      // Detect format and parse
      const pcapResult = isPcapng(buffer) ? parsePcapng(buffer) : parsePcap(buffer)

      if (pcapResult.errors.length > 0) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: pcapResult.errors.join('\n'),
        }))
        return
      }

      // Parse BGP messages from BGP-specific packets
      const bgpResult = parseBgpFromPackets(pcapResult.packets)

      // If no packets at all, show error
      if (pcapResult.allPackets.length === 0) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'No IP packets found in the pcap file.',
        }))
        return
      }

      setState({
        status: 'ready',
        fileName: file.name,
        packets: bgpResult.packets,
        allPackets: pcapResult.allPackets,
        selectedPacketIndex: null,
        warnings: [...pcapResult.warnings, ...bgpResult.warnings],
        error: null,
      })
    } catch (e) {
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: e instanceof Error ? e.message : 'Unknown error occurred',
      }))
    }
  }, [])

  const selectPacket = useCallback((index: number | null) => {
    setState((prev) => ({
      ...prev,
      selectedPacketIndex: index,
    }))
  }, [])

  const reset = useCallback(() => {
    setState(initialState)
  }, [])

  return {
    state,
    loadFile,
    selectPacket,
    reset,
  }
}
