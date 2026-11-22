import { useEffect, useRef } from 'react'

/**
 * Selects the first row of a master–detail screen when it opens with nothing
 * selected, so the detail half of the screen is not a blank "Select a …"
 * panel that every visit has to click past.
 *
 * Only once per visit, and only when the selection came from nowhere: a link
 * that names a row wins, and a reader who closes the detail is left with it
 * closed rather than having the first row forced back on them.
 *
 * Not on a narrow screen, where "nothing selected" is what shows the list at
 * all — selecting a row there would replace the list with its detail.
 *
 * The caller's `select` must replace the history entry, not push one: the
 * reader did not choose this row, so Back should not have to undo it.
 */
export function useAutoSelectFirst(
  enabled: boolean,
  selected: string | null,
  first: string | undefined,
  select: (id: string) => void
) {
  const settled = useRef(false)

  useEffect(() => {
    if (settled.current || !enabled) return
    if (selected !== null) {
      settled.current = true
      return
    }
    if (first === undefined) return
    settled.current = true
    select(first)
  }, [enabled, selected, first, select])
}
