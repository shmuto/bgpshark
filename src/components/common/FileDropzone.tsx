import { useCallback, useState, useRef } from 'react'

interface FileDropzoneProps {
  onFileLoad: (file: File) => void
  isLoading: boolean
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export function FileDropzone({ onFileLoad, isLoading }: FileDropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const validateAndLoad = useCallback(
    (file: File) => {
      setError(null)

      if (file.size > MAX_FILE_SIZE) {
        setError(`File too large. Maximum size is 10MB (got ${(file.size / 1024 / 1024).toFixed(1)}MB)`)
        return
      }

      const extension = file.name.toLowerCase().split('.').pop()
      if (extension !== 'pcap' && extension !== 'cap' && extension !== 'pcapng') {
        setError('Invalid file type. Please upload a .pcap, .pcapng, or .cap file.')
        return
      }

      onFileLoad(file)
    },
    [onFileLoad]
  )

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

      const files = e.dataTransfer.files
      if (files.length > 0) {
        validateAndLoad(files[0])
      }
    },
    [validateAndLoad]
  )

  const handleClick = useCallback(() => {
    inputRef.current?.click()
  }, [])

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
          ${isLoading ? 'opacity-50 pointer-events-none' : ''}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pcap,.pcapng,.cap"
          onChange={handleFileChange}
          className="hidden"
          disabled={isLoading}
        />

        {isLoading ? (
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
            <p className="text-gray-600">Parsing file...</p>
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
            <p className="text-sm text-gray-400">Supports .pcap and .pcapng files up to 10MB</p>
          </>
        )}
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}
    </div>
  )
}
