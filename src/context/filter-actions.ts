import { createContext, useContext } from 'react'

/**
 * How a value shown in the packet detail becomes part of the filter — the
 * "Apply as Filter" a Wireshark user reaches for. Provided by the Messages
 * screen; absent anywhere else, where the values render as plain text.
 */
export interface FilterActions {
  /** `and` narrows the current filter; `replace` starts a new one. */
  apply: (field: string, value: string, mode: 'and' | 'replace') => void
}

export const FilterActionsContext = createContext<FilterActions | null>(null)

export function useFilterActions(): FilterActions | null {
  return useContext(FilterActionsContext)
}
