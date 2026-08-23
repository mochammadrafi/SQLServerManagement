import { ChevronsUpDown, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type DynamicSelectOption = {
  value: string
  label: string
  hint?: string
}

export function DynamicSelect({
  options,
  value,
  onChange,
  placeholder = 'pilih…',
  searchPlaceholder = 'cari…',
  emptyText = 'tidak ada',
  className,
  disabled,
}: {
  options: DynamicSelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = options.find((o) => o.value === value)
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return options
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(n) ||
        o.value.toLowerCase().includes(n) ||
        (o.hint || '').toLowerCase().includes(n),
    )
  }, [options, q])

  useEffect(() => {
    if (!open) return
    setQ('')
    setHi(0)
    const t = window.setTimeout(() => searchRef.current?.focus(), 0)
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [open])

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${hi}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [hi, filtered])

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={cn('relative w-full', className)}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background/70 px-2.5 text-left font-mono text-xs outline-none hover:bg-accent/40 focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/40 disabled:opacity-40"
      >
        <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-muted-foreground')}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div className="absolute top-[calc(100%+4px)] right-0 left-0 z-[80] max-h-[min(16rem,50vh)] overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <div className="relative border-b border-border">
            <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setHi(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setOpen(false)
                  return
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setHi((i) => Math.min(filtered.length - 1, i + 1))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHi((i) => Math.max(0, i - 1))
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const hit = filtered[hi]
                  if (hit) pick(hit.value)
                }
              }}
              placeholder={searchPlaceholder}
              className="h-8 w-full bg-transparent pr-2 pl-7 font-mono text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div ref={listRef} className="max-h-[min(16rem,40vh)] overflow-auto py-1" role="listbox">
            {filtered.length === 0 ? (
              <div className="px-2 py-4 text-center font-mono text-[10px] text-muted-foreground">
                {emptyText}
              </div>
            ) : (
              filtered.map((opt, i) => {
                const active = opt.value === value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    data-idx={i}
                    aria-selected={active}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => pick(opt.value)}
                    className={cn(
                      'flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left font-mono text-xs',
                      i === hi ? 'bg-accent' : 'hover:bg-accent/60',
                      active && 'text-primary',
                    )}
                  >
                    <span className="min-w-0 truncate">{opt.label}</span>
                    {opt.hint ? (
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {opt.hint}
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
