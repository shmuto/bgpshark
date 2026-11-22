import type { ReactNode } from 'react'
import { useFilterActions } from '../../context/filter-actions'
import { formatCondition } from '../../lib/filter/compose'
import { useI18n } from '../../i18n'

interface FilterableValueProps {
  field: string
  value: string
  children?: ReactNode
  /**
   * Which side the ＋ / = buttons appear on. `right` (the default) suits a
   * value followed by space; `left` is for a value in a right-aligned row
   * whose text continues after it — `10.0.0.2:179` — where buttons on the
   * right would sit on the port.
   */
  align?: 'right' | 'left'
}

/**
 * A value in the packet detail that can be turned into a filter: hovering (or
 * tabbing to) it reveals ＋ to narrow the current filter by it and = to filter
 * on it alone. Clicks stop here, so a value inside a clickable card does not
 * also toggle the card.
 */
export function FilterableValue({ field, value, children, align = 'right' }: FilterableValueProps) {
  const actions = useFilterActions()
  const { t } = useI18n()
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
      {/* A faint dotted underline says "this does something" before the
          pointer happens to land on it; it firms up on hover. */}
      <span className="underline decoration-dotted decoration-hair-strong underline-offset-2 group-hover/filter:decoration-accent">
        {children ?? value}
      </span>
      <span className={`absolute ${align === 'left' ? 'right-full pr-1' : 'left-full pl-0.5'} top-1/2 -translate-y-1/2 z-10 inline-flex items-center gap-px opacity-0 pointer-events-none group-hover/filter:opacity-100 group-hover/filter:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity`}>
        <button
          type="button"
          onClick={act('and')}
          title={t.packetDetail.addToFilterTitle(condition)}
          aria-label={t.packetDetail.addToFilterAria(condition)}
          // The glyph is CSS content so it is not part of the value's text:
          // copying "10.1.0.0/24" must not pick up "＋=".
          className="px-1 leading-4 text-[10px] font-sans rounded bg-surface-raised border border-hair text-muted hover:text-accent hover:border-accent before:content-['＋']"
        />
        <button
          type="button"
          onClick={act('replace')}
          title={t.packetDetail.filterOnTitle(condition)}
          aria-label={t.packetDetail.filterOnAria(condition)}
          className="px-1 leading-4 text-[10px] font-sans rounded bg-surface-raised border border-hair text-muted hover:text-accent hover:border-accent before:content-['=']"
        />
      </span>
    </span>
  )
}
