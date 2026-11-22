import type { ReactNode } from 'react'
import { useFilterActions } from '../../context/filter-actions'
import { formatCondition } from '../../lib/filter/compose'

interface FilterableValueProps {
  field: string
  value: string
  children?: ReactNode
}

/**
 * A value in the packet detail that can be turned into a filter: hovering (or
 * tabbing to) it reveals ＋ to narrow the current filter by it and = to filter
 * on it alone. Clicks stop here, so a value inside a clickable card does not
 * also toggle the card.
 */
export function FilterableValue({ field, value, children }: FilterableValueProps) {
  const actions = useFilterActions()
  if (!actions) return <>{children ?? value}</>

  const condition = formatCondition(field, '=', value)
  const act = (mode: 'and' | 'replace') => (e: React.MouseEvent) => {
    e.stopPropagation()
    actions.apply(field, value, mode)
  }

  return (
    // The buttons float over the text to the right rather than taking up
    // room: hidden-but-present buttons left a gap after every value.
    <span className="group/filter relative inline-flex items-center">
      {children ?? value}
      <span className="absolute left-full top-1/2 -translate-y-1/2 z-10 pl-0.5 inline-flex items-center gap-px opacity-0 pointer-events-none group-hover/filter:opacity-100 group-hover/filter:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity">
        <button
          type="button"
          onClick={act('and')}
          title={`Add to filter: and ${condition}`}
          aria-label={`Add to filter: ${condition}`}
          // The glyph is CSS content so it is not part of the value's text:
          // copying "10.1.0.0/24" must not pick up "＋=".
          className="px-1 leading-4 text-[10px] font-sans rounded bg-surface-raised border border-hair text-muted hover:text-accent hover:border-accent before:content-['＋']"
        />
        <button
          type="button"
          onClick={act('replace')}
          title={`Filter on: ${condition}`}
          aria-label={`Filter on: ${condition}`}
          className="px-1 leading-4 text-[10px] font-sans rounded bg-surface-raised border border-hair text-muted hover:text-accent hover:border-accent before:content-['=']"
        />
      </span>
    </span>
  )
}
