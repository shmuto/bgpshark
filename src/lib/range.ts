/**
 * Smallest and largest of a list of numbers.
 *
 * Exists because `Math.min(...values)` is not safe here. Spreading passes one
 * argument per element, and past roughly 125,000 arguments V8 throws
 * "Maximum call stack size exceeded" — so the idiom works on every capture
 * anyone tries it on until someone loads a big one, and then it takes out
 * whatever screen it was on. A capture within the size limit can hold several
 * hundred thousand packets, which is well over that line.
 *
 * Returns null for an empty list: there is no minimum of nothing, and the
 * callers all have something specific to do in that case.
 */
export function minMax(values: readonly number[]): { min: number; max: number } | null {
  if (values.length === 0) return null

  let min = values[0]
  let max = values[0]
  for (let i = 1; i < values.length; i++) {
    const value = values[i]
    if (value < min) min = value
    if (value > max) max = value
  }
  return { min, max }
}
