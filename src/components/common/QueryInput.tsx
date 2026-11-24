import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { BgpPacket } from '../../lib/bgp/types'
import { getSuggestions, type Suggestion } from '../../lib/filter'
import { filterValuesForAsync, hasFilterValues, suggestionsAreSettled } from '../../lib/filter/parser'
import { useI18n } from '../../i18n'

interface QueryInputProps {
  value: string
  onChange: (value: string) => void
  packets: BgpPacket[]
  placeholder?: string
  hasError?: boolean
  /** Lets the page focus the box from a keyboard shortcut. */
  inputRef?: React.RefObject<HTMLInputElement>
  ariaLabel?: string
}

/** Nothing in the suggestion list is selected. Enter applies the filter instead. */
const NO_SELECTION = -1

/**
 * From how many packets the values the box suggests (addresses, prefixes, AS
 * numbers…) are gathered in the background.
 *
 * Gathering them walks every route of every packet, and on a large capture
 * that held the page frozen for seconds on the box's first focus — three at
 * 200MB, the longest freeze left once a load had finished. Above this size it
 * starts on that first focus and runs in slices, and the value suggestions
 * join the list when it is done; fields, operators and fixed values are
 * offered meanwhile. Below it, it takes milliseconds and happens at once, as
 * it always did.
 */
const BACKGROUND_VALUES_MIN_PACKETS = 20_000

export function QueryInput({ value, onChange, packets, placeholder, hasError, inputRef: externalRef, ariaLabel }: QueryInputProps) {
  const { locale, t } = useI18n()
  /**
   * Which suggestion the user has picked, not merely which one is first.
   *
   * The list is a hint about what could come next, so it also opens on input
   * that is already complete — after `... and`, for instance, it lists every
   * field. Pre-selecting the first entry meant Enter silently replaced the word
   * the user had just typed, so a selection only exists once they arrow into it.
   */
  const [selectedIndex, setSelectedIndex] = useState(NO_SELECTION)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [cursorPos, setCursorPos] = useState(value.length)
  const [isComposing, setIsComposing] = useState(false)
  const ownRef = useRef<HTMLInputElement>(null)
  const inputRef = externalRef ?? ownRef
  const suggestionsRef = useRef<HTMLDivElement>(null)

  // See BACKGROUND_VALUES_MIN_PACKETS. `wantValues` is set by the first focus,
  // so a capture whose filter box is never used never pays for its values.
  const [wantValues, setWantValues] = useState(false)
  const [, setValuesVersion] = useState(0)
  const valuesPending = packets.length > BACKGROUND_VALUES_MIN_PACKETS && !hasFilterValues(packets)

  // Derive suggestions at render time so switching UI language updates an open
  // dropdown immediately without waiting for another keystroke.
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!showSuggestions || isComposing) return []
    return getSuggestions(value, cursorPos, packets, locale, { onlyGatheredValues: valuesPending })
  }, [showSuggestions, isComposing, value, cursorPos, packets, locale, valuesPending])

  const updateSuggestions = useCallback(
    (query: string, pos: number) => {
      if (isComposing) {
        setShowSuggestions(false)
        return
      }
      setCursorPos(pos)
      const newSuggestions = getSuggestions(query, pos, packets, locale, { onlyGatheredValues: valuesPending })
      setSelectedIndex(NO_SELECTION)
      setShowSuggestions(
        newSuggestions.length > 0 && !suggestionsAreSettled(query.slice(0, pos), newSuggestions)
      )
    },
    [packets, isComposing, locale, valuesPending]
  )

  // Read by the gathering below when it finishes, which may be several
  // renders after it started.
  const latestUpdateSuggestions = useRef(updateSuggestions)
  useEffect(() => {
    latestUpdateSuggestions.current = updateSuggestions
  }, [updateSuggestions])

  useEffect(() => {
    if (!wantValues || !valuesPending) return
    const controller = new AbortController()
    void filterValuesForAsync(packets, controller.signal).then((gathered) => {
      if (!gathered) return
      setValuesVersion((version) => version + 1)
      // The reader may be sitting after `prefix = ` with nothing listed:
      // offer the values now rather than at their next keystroke.
      const input = inputRef.current
      if (input && document.activeElement === input) {
        latestUpdateSuggestions.current(input.value, input.selectionStart ?? input.value.length)
      }
    })
    return () => controller.abort()
  }, [wantValues, valuesPending, packets, inputRef])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    onChange(newValue)
    if (!isComposing) {
      updateSuggestions(newValue, e.target.selectionStart ?? newValue.length)
    }
  }

  const handleCompositionStart = () => {
    setIsComposing(true)
    setShowSuggestions(false)
  }

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    setIsComposing(false)
    // Update suggestions after composition ends
    const input = e.target as HTMLInputElement
    updateSuggestions(input.value, input.selectionStart ?? input.value.length)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Ignore key events during IME composition
    if (isComposing) return

    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === 'Enter') {
        setShowSuggestions(false)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        // Arrowing back off the top returns to "no selection", so Enter goes
        // back to applying the filter.
        setSelectedIndex((prev) => (prev <= 0 ? NO_SELECTION : prev - 1))
        break
      case 'Tab':
        // Tab is the completion key, so it takes the first suggestion when the
        // user has not picked one.
        e.preventDefault()
        applySuggestion(suggestions[selectedIndex === NO_SELECTION ? 0 : selectedIndex])
        break
      case 'Enter':
        if (selectedIndex === NO_SELECTION) {
          // The user is applying what they typed, not accepting a suggestion.
          setShowSuggestions(false)
          break
        }
        e.preventDefault()
        applySuggestion(suggestions[selectedIndex])
        break
      case 'Escape':
        setShowSuggestions(false)
        break
    }
  }

  const applySuggestion = (suggestion: Suggestion) => {
    const input = inputRef.current
    if (!input) return

    const cursorPos = input.selectionStart ?? value.length
    const beforeCursor = value.slice(0, cursorPos)
    const afterCursor = value.slice(cursorPos)

    // Check if this is an operator suggestion (=, !=, <, <=, >, >=, contains)
    const isOperator = ['=', '!=', '<', '<=', '>', '>=', 'contains'].includes(suggestion.text)

    let wordStart: number
    if (isOperator) {
      // For operators, just append after current position
      wordStart = cursorPos
    } else {
      // For fields/values, replace the word being typed — but only when the
      // suggestion actually completes it. `and` is a finished word that no field
      // name completes, and swallowing it turned a valid query into a broken one.
      const currentWord = beforeCursor.match(/[\w\-."']*$/)?.[0] ?? ''
      const completesWord =
        currentWord.length > 0 &&
        suggestion.text.toLowerCase().startsWith(currentWord.toLowerCase())
      wordStart = completesWord ? cursorPos - currentWord.length : cursorPos
    }

    // Appending after a finished word needs a separator of its own.
    const separator =
      wordStart === cursorPos && wordStart > 0 && !/\s$/.test(value.slice(0, wordStart)) ? ' ' : ''
    const insertText = separator + suggestion.insertText

    const newValue = value.slice(0, wordStart) + insertText + afterCursor
    onChange(newValue)
    setShowSuggestions(false)

    // Set cursor position after the inserted text
    setTimeout(() => {
      const newPos = wordStart + insertText.length
      input.setSelectionRange(newPos, newPos)
      input.focus()
    }, 0)
  }

  const handleFocus = () => {
    setWantValues(true)
    if (inputRef.current && !isComposing) {
      updateSuggestions(value, inputRef.current.selectionStart ?? value.length)
    }
  }

  const handleBlur = (e: React.FocusEvent) => {
    // Delay hiding to allow clicking on suggestions
    if (!suggestionsRef.current?.contains(e.relatedTarget as Node)) {
      setTimeout(() => setShowSuggestions(false), 150)
    }
  }

  // Scroll selected suggestion into view
  useEffect(() => {
    if (showSuggestions && suggestionsRef.current) {
      const selected = suggestionsRef.current.children[selectedIndex] as HTMLElement
      selected?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex, showSuggestions])

  return (
    <div className="relative flex-1">
      <div className="relative">
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-dim"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          ref={inputRef}
          aria-label={ariaLabel}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          placeholder={placeholder ?? 'type=OPEN and src=10.0.0.1'}
          className={`w-full pl-8 pr-3 py-1.5 text-xs font-mono border rounded
                     focus:outline-none focus:ring-2 focus:border-transparent
                     placeholder:text-dim
                     ${hasError
                       ? 'border-critical bg-critical-subtle focus:ring-critical'
                       : 'border-hair-strong focus:ring-accent'
                     }`}
          spellCheck={false}
          autoComplete="off"
        />
        {value && (
          <button
            type="button"
            aria-label={t.messages.clearFilterAria}
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-dim hover:text-strong"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          className="absolute top-full left-0 right-0 mt-1 bg-surface-raised border border-hair
                     rounded shadow-lg z-20 max-h-60 overflow-auto"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.text}
              onMouseDown={(e) => {
                e.preventDefault()
                applySuggestion(suggestion)
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              className={`
                w-full px-3 py-2 text-left text-xs flex items-center justify-between
                ${index === selectedIndex ? 'bg-accent-subtle' : 'hover:bg-surface-sunken'}
              `}
            >
              <span className="font-mono font-medium text-strong">{suggestion.text}</span>
              <span className="text-muted text-xs">{suggestion.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
