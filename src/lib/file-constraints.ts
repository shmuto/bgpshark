/**
 * Constraints on the capture files the app accepts.
 *
 * Kept in one place because both the drop zone component and the global
 * drag-and-drop hook validate uploads, and the limits are also quoted in the UI
 * copy and the docs.
 */
import { getMessages, type Locale } from '../i18n/locale'

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

export type CaptureFileIssue =
  | { kind: 'tooLarge'; actualMb: string }
  | { kind: 'invalidType' }

/**
 * Validate a dropped or selected file, returning a locale-independent issue
 * descriptor so UI state can re-render the message if the user switches
 * language after the error appears.
 */
export function checkCaptureFile(file: File): CaptureFileIssue | null {
  if (file.size > MAX_FILE_SIZE) {
    return { kind: 'tooLarge', actualMb: (file.size / 1024 / 1024).toFixed(1) }
  }

  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  if (!ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number])) {
    return { kind: 'invalidType' }
  }

  return null
}

/** Format a capture file validation issue in the requested locale. */
export function formatCaptureFileIssue(issue: CaptureFileIssue, locale: Locale = 'en'): string {
  const t = getMessages(locale).fileConstraints
  if (issue.kind === 'tooLarge') {
    return t.tooLarge(MAX_FILE_SIZE_LABEL, issue.actualMb)
  }
  return t.invalidType(ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(', '))
}

/**
 * Validate a dropped or selected file.
 * Returns an error message, or null when the file is acceptable.
 */
export function validateCaptureFile(file: File, locale: Locale = 'en'): string | null {
  const issue = checkCaptureFile(file)
  return issue ? formatCaptureFileIssue(issue, locale) : null
}
