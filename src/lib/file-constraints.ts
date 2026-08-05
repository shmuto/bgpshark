/**
 * Constraints on the capture files the app accepts.
 *
 * Kept in one place because both the drop zone component and the global
 * drag-and-drop hook validate uploads, and the limits are also quoted in the UI
 * copy and the docs.
 */

/**
 * A few minutes of capture on a busy session clears 10MB easily, and the
 * parser handles ~7MB in under 3 seconds, so the ceiling is set by memory
 * comfort (the buffer is also persisted to IndexedDB and mirrored into
 * DuckDB), not parse time.
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024

export const MAX_FILE_SIZE_LABEL = '50MB'

export const ACCEPTED_EXTENSIONS = ['pcap', 'pcapng', 'cap'] as const

/** File input `accept` attribute matching ACCEPTED_EXTENSIONS. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(',')

/**
 * Validate a dropped or selected file.
 * Returns an error message, or null when the file is acceptable.
 */
export function validateCaptureFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    const actual = (file.size / 1024 / 1024).toFixed(1)
    return `File too large. Maximum size is ${MAX_FILE_SIZE_LABEL} (got ${actual}MB)`
  }

  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  if (!ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number])) {
    return `Invalid file type. Please upload a ${ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(', ')} file.`
  }

  return null
}
