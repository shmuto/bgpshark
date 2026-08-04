import { useEffect, useState } from 'react'

/** Tailwind's `lg` breakpoint, below which there is no room for two columns. */
const COMPACT_QUERY = '(max-width: 1023px)'

function subscribe(query: string, onChange: () => void) {
  const list = window.matchMedia(query)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const update = () => setMatches(window.matchMedia(query).matches)
    // The window can be resized across the breakpoint between the first render
    // and this effect, so read it once more before subscribing.
    update()
    return subscribe(query, update)
  }, [query])

  return matches
}

/**
 * True when the viewport is too narrow to show a list and a detail pane side by
 * side.
 *
 * The analysis screens use this to behave like a phone app — the list, then the
 * detail with a way back — instead of giving each half the height, which leaves
 * neither readable.
 */
export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY)
}
