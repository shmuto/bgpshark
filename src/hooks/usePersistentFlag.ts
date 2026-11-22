import { useCallback, useEffect, useState } from 'react'

/**
 * A boolean preference shared by every component that reads the same key, and
 * remembered across reloads.
 *
 * Shared because the thing it remembers is a reading habit rather than the
 * state of one widget: an UPDATE's attributes stay expanded when the reader
 * arrows on to the next packet — which mounts a fresh view — instead of
 * snapping shut on every packet and making attribute comparisons a click each.
 */
const listeners = new Map<string, Set<(value: boolean) => void>>()

function read(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key)
    return stored === null ? fallback : stored === '1'
  } catch {
    return fallback
  }
}

export function usePersistentFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => read(key, fallback))

  useEffect(() => {
    let set = listeners.get(key)
    if (!set) {
      set = new Set()
      listeners.set(key, set)
    }
    set.add(setValue)
    return () => {
      set.delete(setValue)
    }
  }, [key])

  const update = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        // Not remembering is no reason to refuse the click.
      }
      for (const listener of listeners.get(key) ?? []) listener(next)
    },
    [key]
  )

  return [value, update]
}
