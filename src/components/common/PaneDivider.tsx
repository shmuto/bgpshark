interface PaneDividerProps {
  onDragStart: () => void
  onReset: () => void
  onNudge: (direction: -1 | 1) => void
  isDragging: boolean
  label?: string
}

/**
 * The handle between two panes.
 *
 * Drawn as a hairline but given a wider hit area, because a one-pixel target is
 * a fair thing to ask of a mouse and an unfair one of everything else. Hidden
 * on compact viewports, where only one pane is on screen at a time.
 */
export function PaneDivider({
  onDragStart,
  onReset,
  onNudge,
  isDragging,
  label = 'Resize panes',
}: PaneDividerProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onMouseDown={(e) => {
        e.preventDefault()
        onDragStart()
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          onNudge(-1)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          onNudge(1)
        } else if (e.key === 'Home') {
          e.preventDefault()
          onReset()
        }
      }}
      title="Drag to resize, double-click to reset"
      className={`hidden lg:flex shrink-0 basis-1.5 cursor-col-resize items-stretch justify-center
                  focus:outline-none focus-visible:bg-accent
                  ${isDragging ? 'bg-accent' : 'bg-hair hover:bg-accent/50'}`}
    />
  )
}
