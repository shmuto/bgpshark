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
 * is set by memory, not parse time: what counts is the tab's JS heap (about
 * 4GB at most), and how much a capture takes there depends on how often its
 * values repeat, since repeated attribute lists and prefixes are kept once. In
 * headless Chromium, on UPDATE-heavy synthetic captures, 100MB opens its list
 * in 4–10s with the heap at 0.4–0.7GB when attribute lists repeat from UPDATE
 * to UPDATE; when every UPDATE carries its own prefix, AS_PATH and MED, it opens
 * in about 7s at 1.7GB. 200MB of the latter reaches 3.5GB and stops
 * responding, which is why the ceiling stops at 100MB. See docs/design.md §3.1.
 */
export const MAX_FILE_SIZE = 100 * 1024 * 1024

export const MAX_FILE_SIZE_LABEL = '100MB'

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
