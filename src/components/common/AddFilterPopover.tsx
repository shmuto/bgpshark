import { useEffect, useRef, useState } from 'react'
import { FILTER_FIELDS, type FilterFieldName } from '../../lib/filter/parser'
import { formatCondition } from '../../lib/filter/compose'
import { useI18n } from '../../i18n'

interface AddFilterPopoverProps {
  /** Values seen in the capture for a field, offered as a list where they exist. */
  valuesFor: (field: FilterFieldName | 'ip') => string[]
  onAdd: (condition: string) => void
}

const FIELDS = ['ip', ...Object.keys(FILTER_FIELDS)] as (FilterFieldName | 'ip')[]
const OPERATORS = ['=', '!=', 'contains', 'not contains', '<', '<=', '>', '>='] as const

/**
 * Builds one condition from menus and appends it to the query box.
 *
 * This is what remains of the old Simple mode. It used to be a second filter
 * with state of its own, which disagreed with the query box (a type badge
 * filtered the list while Simple still said "No filters applied") and lost the
 * query when switching back. Writing into the one query box instead means
 * there is only ever one filter, and it is always the text on screen.
 */
export function AddFilterPopover({ valuesFor, onAdd }: AddFilterPopoverProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [field, setField] = useState<FilterFieldName | 'ip'>('ip')
  const [operator, setOperator] = useState<(typeof OPERATORS)[number]>('=')
  const [value, setValue] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const numeric = field !== 'ip' && FILTER_FIELDS[field].valueType === 'number'
  const operators = OPERATORS.filter((op) => numeric || !['<', '<=', '>', '>='].includes(op))
  // Only while open: the values can take a while to gather on a large
  // capture, and a closed popover shows none of them.
  const values = open ? valuesFor(field).slice(0, 200) : []

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    onAdd(formatCondition(field, operator, value.trim()))
    setValue('')
    setOpen(false)
  }

  const control = 'px-2 py-1 text-xs rounded border border-hair-strong bg-surface text-body'

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={t.messages.addFilterTitle}
        className="px-2 py-1.5 text-xs rounded border border-hair-strong text-muted hover:text-accent hover:border-accent"
      >
        {t.messages.addFilterButton}
      </button>
      {open && (
        <form
          onSubmit={submit}
          aria-label={t.messages.addFilterFormAria}
          className="absolute right-0 top-full mt-1 z-30 bg-surface-raised border border-hair rounded shadow-lg p-3 flex flex-col gap-2 w-72"
        >
          <div className="flex items-center gap-2">
            <select
              aria-label={t.messages.addFilterFieldAria}
              value={field}
              onChange={(e) => {
                setField(e.target.value as FilterFieldName | 'ip')
                setOperator('=')
                setValue('')
              }}
              className={`${control} flex-1`}
            >
              {FIELDS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <select
              aria-label={t.messages.addFilterOperatorAria}
              value={operator}
              onChange={(e) => setOperator(e.target.value as (typeof OPERATORS)[number])}
              className={control}
            >
              {operators.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </div>
          <input
            aria-label={t.messages.addFilterValueAria}
            list="add-filter-values"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode={numeric ? 'numeric' : undefined}
            placeholder={
              values.length > 0 ? t.messages.addFilterPickOrType : t.messages.addFilterType
            }
            className={`${control} w-full placeholder:text-dim`}
            autoFocus
          />
          <datalist id="add-filter-values">
            {values.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <button
            type="submit"
            disabled={!value.trim()}
            className="self-end px-3 py-1 text-xs bg-accent text-accent-fg rounded hover:bg-accent-hover disabled:opacity-50"
          >
            {t.messages.addFilterSubmit}
          </button>
        </form>
      )}
    </div>
  )
}
