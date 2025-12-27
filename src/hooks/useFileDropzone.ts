import { useState, useCallback, useEffect } from 'react'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

interface UseFileDropzoneOptions {
  onFileLoad: (file: File) => void
  disabled?: boolean
}

export function useFileDropzone({ onFileLoad, disabled = false }: UseFileDropzoneOptions) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const handleDragOver = useCallback(
    (e: DragEvent) => {
      if (disabled) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(true)
    },
    [disabled]
  )

  const handleDragLeave = useCallback(
    (e: DragEvent) => {
      if (disabled) return
      e.preventDefault()
      e.stopPropagation()
      // Only set to false if leaving the window
      if (e.relatedTarget === null) {
        setIsDragOver(false)
      }
    },
    [disabled]
  )

  const handleDrop = useCallback(
    (e: DragEvent) => {
      if (disabled) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        validateAndLoad(files[0])
      }
    },
    [disabled, validateAndLoad]
  )

  useEffect(() => {
    if (disabled) return

    // Use document.body to capture all drag events
    document.body.addEventListener('dragover', handleDragOver)
    document.body.addEventListener('dragleave', handleDragLeave)
    document.body.addEventListener('drop', handleDrop)

    return () => {
      document.body.removeEventListener('dragover', handleDragOver)
      document.body.removeEventListener('dragleave', handleDragLeave)
      document.body.removeEventListener('drop', handleDrop)
    }
  }, [disabled, handleDragOver, handleDragLeave, handleDrop])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    isDragOver,
    error,
    clearError,
  }
}
