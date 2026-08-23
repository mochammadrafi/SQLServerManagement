import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AiCatalogItem, AiContextDb } from '@/lib/api'
import {
  buildMentionSuggestions,
  insertMention,
  mentionFilterAt,
  type MentionPick,
} from '@/lib/ai-mentions'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/i18n'

export function AiMentionInput({
  value,
  onChange,
  catalog,
  context,
  databases,
  placeholder,
  disabled,
  rows = 3,
  onSubmit,
}: {
  value: string
  onChange: (value: string) => void
  catalog?: AiCatalogItem[]
  context?: AiContextDb[]
  databases: string[]
  placeholder?: string
  disabled?: boolean
  rows?: number
  onSubmit?: () => void
}) {
  const { t } = useLocale()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(false)
  const [start, setStart] = useState(-1)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)

  const suggestions = useMemo(
    () => (open ? buildMentionSuggestions(filter, catalog, context, databases, 80) : []),
    [open, filter, catalog, context, databases],
  )

  useEffect(() => {
    setActive(0)
  }, [filter, suggestions.length])

  const syncMention = (nextValue: string, cursor: number) => {
    const hit = mentionFilterAt(nextValue, cursor)
    if (hit) {
      setOpen(true)
      setStart(hit.start)
      setFilter(hit.filter)
    } else {
      setOpen(false)
      setStart(-1)
      setFilter('')
    }
  }

  const pick = (item: MentionPick) => {
    const cursor = ref.current?.selectionStart ?? value.length
    const { nextValue, nextCursor } = insertMention(value, start, cursor, item.ref)
    onChange(nextValue)
    setOpen(false)
    window.setTimeout(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(nextCursor, nextCursor)
    }, 0)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && suggestions.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((index) => Math.min(index + 1, suggestions.length - 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => Math.max(index - 1, 0))
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        pick(suggestions[active])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && onSubmit) {
      event.preventDefault()
      onSubmit()
    }
  }

  const catalogCount = catalog?.length || 0

  return (
    <div className="relative min-w-0 flex-1">
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value)
          syncMention(event.target.value, event.target.selectionStart ?? event.target.value.length)
        }}
        onClick={(event) =>
          syncMention(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)
        }
        onKeyUp={(event) =>
          syncMention(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)
        }
        onKeyDown={handleKeyDown}
        className={cn(
          'min-h-8 w-full resize-none rounded-md border border-input bg-background/70 px-2.5 py-2 font-mono text-xs shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/40 disabled:opacity-50',
        )}
      />
      {open ? (
        <div className="absolute bottom-[calc(100%+4px)] z-[80] max-h-72 w-full overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <div className="border-b border-border px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
            {suggestions.length
              ? `${suggestions.length}${catalogCount ? ` / ${catalogCount}` : ''}`
              : catalogCount
                ? `0 / ${catalogCount}`
                : '…'}
          </div>
          <div className="max-h-64 overflow-auto py-1">
            {suggestions.length ? (
              suggestions.map((item, index) => (
                <button
                  key={`${item.kind}-${item.ref}`}
                  type="button"
                  className={cn(
                    'flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left font-mono text-[11px]',
                    index === active ? 'bg-accent text-primary' : 'hover:bg-accent/60',
                  )}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(item)}
                >
                  <span className="shrink-0 text-[9px] tracking-widest text-muted-foreground">{item.kind}</span>
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.hint ? (
                    <span className="ml-auto truncate text-[10px] text-muted-foreground">{item.hint}</span>
                  ) : null}
                </button>
              ))
            ) : (
              <div className="px-2.5 py-3 font-mono text-[10px] text-muted-foreground">
                {catalogCount ? t('ai.mentionNoMatch') : t('ai.mentionLoading')}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
