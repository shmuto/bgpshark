/**
 * Remember a computation over a capture for as long as the capture is loaded.
 *
 * The analysis screens aggregate the whole capture — per-route history, the
 * dashboard's alerts — and did it in a `useMemo` inside the page. A `useMemo`
 * lives as long as the component, and a page is unmounted every time the
 * reader navigates away, so the same aggregation over the same packets ran
 * again on every visit: about four seconds each time for the dashboard on an
 * 18MB capture, most of it spent rebuilding route history the Routes screen
 * had also just built.
 *
 * Keying on the packet array itself is what makes this safe. The analyzer
 * builds a new array for every capture it loads and never mutates one, so the
 * same array always means the same capture, and a WeakMap lets the entry go
 * when the capture does. Callers must treat what comes back as read-only —
 * it is shared between every screen that asks.
 */
export function perCapture<K extends object, R>(compute: (key: K) => R): (key: K) => R {
  const cache = new WeakMap<K, R>()
  return (key) => {
    if (cache.has(key)) return cache.get(key) as R
    const result = compute(key)
    cache.set(key, result)
    return result
  }
}

/**
 * `perCapture` for a computation over two arrays from the same load — the BGP
 * packets and every packet — keyed on both, so that neither can be swapped
 * without the other and still be answered from the cache.
 */
export function perCapturePair<A extends object, B extends object, R>(
  compute: (a: A, b: B) => R
): (a: A, b: B) => R {
  const cache = new WeakMap<A, WeakMap<B, R>>()
  return (a, b) => {
    let inner = cache.get(a)
    if (!inner) {
      inner = new WeakMap()
      cache.set(a, inner)
    }
    if (inner.has(b)) return inner.get(b) as R
    const result = compute(a, b)
    inner.set(b, result)
    return result
  }
}
