/**
 * Constraints on the capture files the app accepts.
 *
 * Kept in one place because both the drop zone component and the global
 * drag-and-drop hook validate uploads, and the limits are also quoted in the UI
 * copy and the docs.
 */
import { getMessages, type Locale } from '../i18n/locale'

/**
 * A few minutes of capture on a busy session clears 10MB easily. The ceiling
 * is set by memory, not parse time: parsing even 100MB takes under a second,
 * but the decoded packets weigh 1–1.5KB per BGP message in the tab's JS heap
 * (about 4GB at most), and DuckDB WASM holds its own copy beside them. In
 * headless Chromium a 50MB capture opens its list in about 4s with the whole
 * browser at 3.5–4.5GB; 100MB opens in about 9s at 5.5–6.5GB, 150MB in about
 * 13s at 6.5–7.5GB, and 200MB runs the tab out of heap shortly after its list
 * opens. See docs/design.md §3.1.
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
