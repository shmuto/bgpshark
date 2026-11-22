import { useCallback, useState, useRef } from 'react'
import {
  ACCEPT_ATTRIBUTE,
  MAX_FILE_SIZE_LABEL,
  checkCaptureFile,
  formatCaptureFileIssue,
  type CaptureFileIssue,
} from '../../lib/file-constraints'
import type { LoadProgress } from '../../lib/load-progress'
import { useI18n } from '../../i18n'
import { LoadProgressBar } from './LoadProgressBar'

type DropzoneError = { kind: 'file'; issue: CaptureFileIssue } | { kind: 'sample' }

interface FileDropzoneProps {
  onFileLoad: (file: File) => void
  isLoading: boolean
  /** The load in flight, when there is one to measure. */
  progress?: LoadProgress | null
}

export function FileDropzone({ onFileLoad, isLoading, progress }: FileDropzoneProps) {
  const { locale, t } = useI18n()
  const [isDragOver, setIsDragOver] = useState(false)
  const [errorState, setErrorState] = useState<DropzoneError | null>(null)
  const [isSampleLoading, setIsSampleLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const busy = isLoading || isSampleLoading
  const error =
    errorState === null
      ? null
      : errorState.kind === 'sample'
        ? t.upload.sampleError
        : formatCaptureFileIssue(errorState.issue, locale)

  const validateAndLoad = useCallback(
    (file: File) => {
      setErrorState(null)

      const fileIssue = checkCaptureFile(file)
      if (fileIssue) {
        setErrorState({ kind: 'file', issue: fileIssue })
        return
      }

      onFileLoad(file)
    },
    [onFileLoad]
  )

  const handleSampleClick = useCallback(async () => {
    setErrorState(null)
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
      setErrorState({ kind: 'sample' })
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
          ${isDragOver ? 'border-accent bg-accent-subtle' : 'border-hair-strong hover:border-accent hover:bg-surface-sunken'}
          ${busy ? 'pointer-events-none' : ''}
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

        {busy && progress ? (
          <div className="flex flex-col items-center">
            <LoadProgressBar progress={progress} />
          </div>
        ) : busy ? (
          // Fetching the sample, or DuckDB still starting up: nothing to count yet.
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin w-8 h-8 border-4 border-accent border-t-transparent rounded-full" />
            <p className="text-muted">
              {isSampleLoading ? t.upload.loadingSample : t.upload.preparing}
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4">
              <svg
                className="w-12 h-12 mx-auto text-muted"
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
            <p className="text-muted mb-2">
              <span className="font-medium text-strong">{t.upload.dropHere}</span> {t.upload.orClick}
            </p>
            <p className="text-sm text-dim">
              {t.upload.supports(MAX_FILE_SIZE_LABEL)}
            </p>
          </>
        )}
      </div>

      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={handleSampleClick}
          disabled={busy}
          className="text-sm text-accent hover:text-accent-hover hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline disabled:text-dim"
        >
          {isSampleLoading ? t.upload.loadingSampleFile : t.upload.trySample}
        </button>
        <p className="mt-1 text-xs text-dim">
          {t.upload.sampleDescription}
        </p>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-critical-subtle border border-critical/30 rounded-lg text-critical text-sm">
          {error}
        </div>
      )}
    </div>
  )
}
