import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Windowed rendering for a long table.
 *
 * A capture can hold tens of thousands of rows, and a browser asked to lay all
 * of them out stops answering for tens of seconds. Only the rows near the
 * viewport are mounted; spacer rows above and below stand in for the rest so
 * the scrollbar still describes the whole dataset.
 *
 * The numbers and the measure-then-correct approach are the packet list's,
 * which had this first — a second, differently tuned windowing would only give
 * the two tables different scrolling feel for no reason.
 */

// Row/header heights are measured from the live DOM once rows exist; these are
// just first-paint estimates so the initial windowed range is roughly right
// before real measurements land.
const ESTIMATED_ROW_HEIGHT = 29
const ESTIMATED_HEADER_HEIGHT = 33
const OVERSCAN_ROWS = 8

export interface VirtualRows {
  /** Goes on the scrolling element, which is the table's ancestor, not the table. */
  containerRef: React.RefObject<HTMLDivElement>
  onScroll: () => void
  /** Goes on the first mounted row, so the real row height is known after a render or two. */
  measureRowRef: (el: HTMLTableRowElement | null) => void
  /** Goes on the `<thead>`, which the sticky header takes out of the scrollable height. */
  measureHeaderRef: (el: HTMLTableSectionElement | null) => void
  /** Mount `rows.slice(startIndex, endIndex)`. */
  startIndex: number
  endIndex: number
  topSpacerHeight: number
  bottomSpacerHeight: number
}

export function useVirtualRows(totalCount: number): VirtualRows {
  const containerRef = useRef<HTMLDivElement>(null)
  const [rowHeight, setRowHeight] = useState(ESTIMATED_ROW_HEIGHT)
  const [headerHeight, setHeaderHeight] = useState(ESTIMATED_HEADER_HEIGHT)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  // Track the scrollable viewport's height synchronously (before paint) so the
  // very first windowed render already covers the visible area, then keep it
  // updated as the container is resized (e.g. pane resizing, window resize).
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setViewportHeight(entry.contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (el) setScrollTop(el.scrollTop)
  }, [])

  // Measure the real rendered row/header height from the DOM instead of
  // trusting the estimate forever - fonts/zoom/DPI can shift it slightly.
  // Only updates state when the measurement actually differs, so this
  // converges after one or two renders rather than looping.
  const measureRowRef = useCallback((el: HTMLTableRowElement | null) => {
    if (!el) return
    const measured = el.getBoundingClientRect().height
    if (measured > 0) {
      setRowHeight((prev) => (Math.abs(prev - measured) > 0.5 ? measured : prev))
    }
  }, [])

  const measureHeaderRef = useCallback((el: HTMLTableSectionElement | null) => {
    if (!el) return
    const measured = el.getBoundingClientRect().height
    if (measured > 0) {
      setHeaderHeight((prev) => (Math.abs(prev - measured) > 0.5 ? measured : prev))
    }
  }, [])

  const availableHeight = Math.max(0, viewportHeight - headerHeight)
  const rawStartIndex = Math.floor(scrollTop / rowHeight)
  const visibleRowCount = Math.ceil(availableHeight / rowHeight) + 1
  const startIndex = Math.max(0, rawStartIndex - OVERSCAN_ROWS)
  const endIndex = Math.min(totalCount, rawStartIndex + visibleRowCount + OVERSCAN_ROWS)

  // If the dataset shrinks (new capture, filter applied) while scrolled far
  // down, clamp back into range instead of leaving an empty overscroll.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const maxScrollTop = Math.max(0, totalCount * rowHeight - availableHeight)
    if (el.scrollTop > maxScrollTop) {
      el.scrollTop = maxScrollTop
      setScrollTop(maxScrollTop)
    }
  }, [totalCount, rowHeight, availableHeight])

  return {
    containerRef,
    onScroll,
    measureRowRef,
    measureHeaderRef,
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * rowHeight,
    bottomSpacerHeight: Math.max(0, (totalCount - endIndex) * rowHeight),
  }
}
