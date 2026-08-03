import { useState, useRef, useEffect, useCallback } from 'react'
import type { BgpPacket } from '../../lib/bgp/types'
import { getSuggestions, type Suggestion } from '../../lib/filter'

interface QueryInputProps {
  value: string
  onChange: (value: string) => void
  packets: BgpPacket[]
  placeholder?: string
  hasError?: boolean
}

export function QueryInput({ value, onChange, packets, placeholder, hasError }: QueryInputProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)

  const updateSuggestions = useCallback(
    (query: string, cursorPos: number) => {
      if (isComposing) {
        setShowSuggestions(false)
        return
      }
      const newSuggestions = getSuggestions(query, cursorPos, packets)
      setSuggestions(newSuggestions)
      setSelectedIndex(0)
      setShowSuggestions(newSuggestions.length > 0)
    },
    [packets, isComposing]
  )

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
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Tab':
      case 'Enter':
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

    // Check if this is an operator suggestion (=, !=, contains)
    const isOperator = ['=', '!=', 'contains'].includes(suggestion.text)

    let wordStart: number
    if (isOperator) {
      // For operators, just append after current position
      wordStart = cursorPos
    } else {
      // For fields/values, replace the current word
      const match = beforeCursor.match(/[\w\-."']*$/)
      wordStart = match ? cursorPos - match[0].length : cursorPos
    }

    const newValue = value.slice(0, wordStart) + suggestion.insertText + afterCursor
    onChange(newValue)
    setShowSuggestions(false)

    // Set cursor position after the inserted text
    setTimeout(() => {
      const newPos = wordStart + suggestion.insertText.length
      input.setSelectionRange(newPos, newPos)
      input.focus()
    }, 0)
  }

  const handleFocus = () => {
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
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          placeholder={placeholder ?? 'type=OPEN and src=10.0.0.1'}
          className={`w-full pl-8 pr-3 py-1.5 text-sm font-mono border rounded
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
                w-full px-3 py-2 text-left text-sm flex items-center justify-between
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
