interface BackToListProps {
  onClick: () => void
  label?: string
}

/**
 * The way out of a detail pane on a narrow screen.
 *
 * On a compact viewport the analysis screens show either the list or the
 * detail, never both, so the detail needs its own way back — there is no list
 * beside it to click.
 */
export function BackToList({ onClick, label = 'Back to list' }: BackToListProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted transition-colors hover:bg-surface-sunken hover:text-strong lg:hidden"
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      {label}
    </button>
  )
}
