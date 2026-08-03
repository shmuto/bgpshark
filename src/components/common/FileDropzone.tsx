import { useCallback, useState, useRef } from 'react'
import {
  ACCEPT_ATTRIBUTE,
  MAX_FILE_SIZE_LABEL,
  validateCaptureFile,
} from '../../lib/file-constraints'

interface FileDropzoneProps {
  onFileLoad: (file: File) => void
  isLoading: boolean
}

export function FileDropzone({ onFileLoad, isLoading }: FileDropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSampleLoading, setIsSampleLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const busy = isLoading || isSampleLoading

  const validateAndLoad = useCallback(
    (file: File) => {
      setError(null)

      const validationError = validateCaptureFile(file)
      if (validationError) {
        setError(validationError)
        return
      }

      onFileLoad(file)
    },
    [onFileLoad]
  )

  const handleSampleClick = useCallback(async () => {
    setError(null)
    setIsSampleLoading(true)

    try {
      const url = `${import.meta.env.BASE_URL}sample.pcapng`
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }

      const blob = await response.blob()
      const file = new File([blob], 'sample.pcapng', { type: 'application/x-pcapng' })
      // Go through the same validation as a user-supplied file, so the sample can
      // never bypass the limits the rest of the app enforces.
      validateAndLoad(file)
    } catch {
      setError('Could not load the sample capture. Check your connection and try again.')
    } finally {
      setIsSampleLoading(false)
    }
  }, [validateAndLoad])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      if (busy) return

      const files = e.dataTransfer.files
      if (files.length > 0) {
        validateAndLoad(files[0])
      }
    },
    [busy, validateAndLoad]
  )

  const handleClick = useCallback(() => {
    if (busy) return
    inputRef.current?.click()
  }, [busy])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        validateAndLoad(files[0])
      }
    },
    [validateAndLoad]
  )

  return (
    <div className="w-full max-w-xl">
      <div
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-lg p-12 text-center cursor-pointer
          transition-colors duration-200
          ${isDragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}
          ${busy ? 'opacity-50 pointer-events-none' : ''}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          onChange={handleFileChange}
          className="hidden"
          disabled={busy}
        />

        {busy ? (
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
            <p className="text-gray-600">{isSampleLoading ? 'Loading sample...' : 'Parsing file...'}</p>
          </div>
        ) : (
          <>
            <div className="mb-4">
              <svg
                className="w-12 h-12 mx-auto text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
            </div>
            <p className="text-gray-600 mb-2">
              <span className="font-medium">Drop pcap file here</span> or click to select
            </p>
            <p className="text-sm text-gray-400">
              Supports .pcap and .pcapng files up to {MAX_FILE_SIZE_LABEL}
            </p>
          </>
        )}
      </div>

      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={handleSampleClick}
          disabled={busy}
          className="text-sm text-blue-600 hover:text-blue-700 hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline disabled:text-gray-400"
        >
          {isSampleLoading ? 'Loading sample.pcapng...' : 'Try with sample.pcapng'}
        </button>
        <p className="mt-1 text-xs text-gray-400">
          Includes session resets and NOTIFICATION messages between two BGP peers
        </p>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}
    </div>
  )
}
