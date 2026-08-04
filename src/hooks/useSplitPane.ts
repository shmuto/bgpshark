import { useCallback, useEffect, useRef, useState } from 'react'

/** Neither pane may be dragged below this share of the container. */
const MIN_PERCENT = 15
const MAX_PERCENT = 100 - MIN_PERCENT

/** How far an arrow key nudges the divider. */
const KEYBOARD_STEP = 2

function storageKeyFor(name: string) {
  return `bgpshark-split-${name}`
}

function loadPercent(name: string, fallback: number): number {
  try {
    const stored = window.localStorage.getItem(storageKeyFor(name))
    if (stored === null) return fallback
    const value = Number(stored)
    if (!Number.isFinite(value)) return fallback
    return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, value))
  } catch {
    // Private mode and blocked storage are not worth failing a render over.
    return fallback
  }
}

/**
 * A draggable divider between a list pane and a detail pane.
 *
 * The width lives here as a percentage rather than in CSS because the split is
 * something the user sets and expects to find again: which of the two halves
 * deserves the room depends on the capture, and on whether you are reading
 * packet summaries or a decoded OPEN. It is remembered per screen, so the
 * message explorer and the route list do not have to agree.
 *
 * Only meaningful when both panes are on screen; the caller stops using the
 * width on compact viewports, where it shows one pane at a time.
 */
export function useSplitPane(name: string, defaultPercent = 50) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [percent, setPercent] = useState(() => loadPercent(name, defaultPercent))
  const [isDragging, setIsDragging] = useState(false)

  const commit = useCallback(
    (next: number) => {
      const clamped = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, next))
      setPercent(clamped)
      try {
        window.localStorage.setItem(storageKeyFor(name), String(Math.round(clamped)))
      } catch {
        // Not being able to remember the split is not a reason to refuse to move it.
      }
    },
    [name]
  )

  const startDrag = useCallback(() => setIsDragging(true), [])

  /** Double-clicking the divider puts the panes back where they started. */
  const reset = useCallback(() => commit(defaultPercent), [commit, defaultPercent])

  const nudge = useCallback(
    (direction: -1 | 1) => commit(percent + direction * KEYBOARD_STEP),
    [commit, percent]
  )

  useEffect(() => {
    if (!isDragging) return

    const onMove = (event: MouseEvent) => {
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      if (rect.width === 0) return
      commit(((event.clientX - rect.left) / rect.width) * 100)
    }

    const onUp = () => setIsDragging(false)

    // Dragging past the divider must keep working over the panes themselves, so
    // these listen on the document rather than on the divider.
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    // A drag over a table would otherwise select its text.
    const previousUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = ''
    }
  }, [isDragging, commit])

  return { containerRef, percent, isDragging, startDrag, reset, nudge }
}
