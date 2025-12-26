import { useState } from 'react'

interface WarningBannerProps {
  warnings: string[]
}

export function WarningBanner({ warnings }: WarningBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  if (warnings.length === 0) {
    return null
  }

  return (
    <div className="bg-amber-50 border-b border-amber-200">
      <div className="px-4 py-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 text-amber-700 hover:text-amber-800 text-sm w-full"
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
          <div className="mt-2 space-y-1">
            {warnings.map((warning, index) => (
              <div key={index} className="text-sm text-amber-600 pl-6">
                {warning}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
