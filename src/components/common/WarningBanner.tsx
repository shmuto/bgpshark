import { useState } from 'react'

interface WarningBannerProps {
  warnings: string[]
}

/**
 * A malformed capture can warn once per packet, and there is nothing to learn
 * from the ten thousandth copy of the same message — so the list is capped and
 * the rest is counted.
 */
const MAX_LISTED = 100

export function WarningBanner({ warnings }: WarningBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  if (warnings.length === 0) {
    return null
  }

  return (
    <div className="bg-warning-subtle border-b border-warning/30">
      <div className="px-4 py-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 text-warning hover:opacity-80 transition-opacity text-sm w-full"
        >
          <svg
            className="w-4 h-4 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span className="font-medium">
            {warnings.length} warning{warnings.length > 1 ? 's' : ''} during parsing
          </span>
          <svg
            className={`w-4 h-4 ml-auto transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {isExpanded && (
          <div className="mt-2 max-h-48 space-y-1 overflow-auto">
            {warnings.slice(0, MAX_LISTED).map((warning, index) => (
              <div key={index} className="text-sm text-warning pl-6">
                {warning}
              </div>
            ))}
            {warnings.length > MAX_LISTED && (
              <div className="pl-6 text-sm text-muted">
                …and {warnings.length - MAX_LISTED} more
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
