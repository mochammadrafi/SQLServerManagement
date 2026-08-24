import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AiContextDb, AiContextObject } from '@/lib/api'
import { cn } from '@/lib/utils'

function formatCell(value: unknown) {
  if (value == null) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function SampleTable({
  columns,
  rows,
}: {
  columns: string[]
  rows: unknown[][]
}) {
  if (!rows.length) return null
  const cols = columns.length ? columns : rows[0].map((_, index) => `c${index}`)
  return (
    <div className="mt-2 overflow-auto rounded border border-border bg-background/60">
      <table className="w-full border-collapse font-mono text-[9px]">
        <thead>
          <tr className="border-b border-border bg-card/80 text-left text-muted-foreground">
            {cols.map((col) => (
              <th key={col} className="px-1.5 py-1 font-normal">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-border/60 last:border-0">
              {cols.map((_, colIndex) => (
                <td key={`${rowIndex}-${colIndex}`} className="max-w-32 truncate px-1.5 py-1">
                  {formatCell(row[colIndex])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ObjectNode({
  obj,
  open,
  onToggle,
  t,
}: {
  obj: AiContextObject
  open: boolean
  onToggle: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const meta = [
    obj.kind,
    obj.row_count != null ? `${obj.row_count.toLocaleString()} ${t('ai.rows')}` : null,
    obj.pk?.length ? `${t('ai.pk')}: ${obj.pk.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="rounded border border-border/70">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left font-mono text-[10px] hover:bg-accent/30"
        onClick={onToggle}
      >
        {open ? <ChevronDown className="mt-0.5 size-3 shrink-0" /> : <ChevronRight className="mt-0.5 size-3 shrink-0" />}
        <span className="min-w-0">
          <span className="text-[9px] tracking-widest text-muted-foreground">{t('ai.level.table')}</span>
          <span className="mt-0.5 block text-foreground">
            {obj.schema}.{obj.name}
          </span>
          <span className="mt-0.5 block text-muted-foreground">{meta}</span>
        </span>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-2 py-1.5">
          <div>
            <div className="font-mono text-[9px] tracking-widest text-muted-foreground">{t('ai.level.columns')}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {obj.columns.map((col) => (
                <span key={col.name} className="rounded border border-border px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {col.name} <span className="text-foreground/70">{col.type}</span>
                </span>
              ))}
            </div>
          </div>
          {obj.sample?.rows?.length ? (
            <div>
              <div className="font-mono text-[9px] tracking-widest text-muted-foreground">{t('ai.level.sample')}</div>
              <SampleTable columns={obj.sample.columns} rows={obj.sample.rows} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function ContextTree({
  context,
  usedObjects,
  loading,
  t,
}: {
  context?: AiContextDb[]
  usedObjects?: string[]
  loading?: boolean
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const [openDb, setOpenDb] = useState<string | null>(context?.[0]?.database || null)
  const [openObj, setOpenObj] = useState<string | null>(null)

  useEffect(() => {
    if (context?.length) setOpenDb(context[0].database)
  }, [context])

  if (loading) {
    return <p className="font-mono text-[10px] text-muted-foreground">{t('common.loading')}</p>
  }

  if (!context?.length) {
    return <p className="font-mono text-[10px] text-muted-foreground">{t('ai.noContext')}</p>
  }

  const total = context.reduce((sum, db) => sum + db.objects.length, 0)

  return (
    <div className="space-y-3">
      <div className="font-mono text-[10px] text-muted-foreground">{t('ai.usedObjects', { n: total })}</div>
      {usedObjects?.length ? (
        <div className="rounded border border-border bg-background/50 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
          {usedObjects.join(' · ')}
        </div>
      ) : null}
      {context.map((db) => {
        const dbOpen = openDb === db.database
        return (
          <div key={db.database} className="rounded border border-border">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-[11px] hover:bg-accent/40"
              onClick={() => setOpenDb(dbOpen ? null : db.database)}
            >
              {dbOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              <span className="min-w-0">
                <span className="text-[9px] tracking-widest text-muted-foreground">{t('ai.level.db')}</span>
                <span className="mt-0.5 block truncate text-primary">{db.database}</span>
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {db.object_count} · {db.fk_count} FK
              </span>
            </button>
            {dbOpen ? (
              <div className="space-y-2 border-t border-border px-2 py-2">
                {db.foreign_keys.length ? (
                  <div>
                    <div className="font-mono text-[9px] tracking-widest text-muted-foreground">{t('ai.relations')}</div>
                    <div className="mt-1 max-h-28 space-y-1 overflow-auto font-mono text-[10px] text-muted-foreground">
                      {db.foreign_keys.slice(0, 16).map((fk) => (
                        <div key={`${fk.from}-${fk.to}-${fk.constraint || fk.columns.join(',')}`}>
                          {fk.from} → {fk.to} ({fk.columns.join(', ')})
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {db.inferred_links?.length ? (
                  <div>
                    <div className="font-mono text-[9px] tracking-widest text-muted-foreground">{t('ai.inferredLinks')}</div>
                    <div className="mt-1 max-h-28 space-y-1 overflow-auto font-mono text-[10px] text-muted-foreground">
                      {db.inferred_links.slice(0, 16).map((link) => (
                        <div key={`${link.from}-${link.to}-${link.columns.join(',')}`}>
                          {link.from} → {link.to} ({link.columns.join(', ')})
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {db.objects.map((obj) => {
                  const key = `${db.database}.${obj.schema}.${obj.name}`
                  return (
                    <ObjectNode
                      key={key}
                      obj={obj}
                      open={openObj === key}
                      onToggle={() => setOpenObj(openObj === key ? null : key)}
                      t={t}
                    />
                  )
                })}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function SqlBlock({
  sql,
  fallbackDb,
  onOpenSql,
  t,
}: {
  sql: string[]
  fallbackDb: string
  onOpenSql: (sql: string, database: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  if (!sql.length) return null
  return (
    <>
      {sql.map((block, index) => {
        const db = block.match(/\[([^\]]+)\]\.\[[^\]]+\]\.\[[^\]]+\]/i)?.[1] || fallbackDb
        return (
          <div key={index} className="mt-2 border border-border bg-background/60">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px]">{block}</pre>
            <div className="flex items-center gap-2 border-t border-border px-2 py-1">
              <span className="font-mono text-[10px] text-muted-foreground">{db}</span>
              <ButtonRow block={block} db={db} onOpenSql={onOpenSql} t={t} />
            </div>
          </div>
        )
      })}
    </>
  )
}

function ButtonRow({
  block,
  db,
  onOpenSql,
  t,
}: {
  block: string
  db: string
  onOpenSql: (sql: string, database: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  return (
    <button
      type="button"
      className={cn(
        'ml-auto rounded border border-border px-2 py-0.5 font-mono text-[10px] hover:bg-accent/40',
      )}
      onClick={() => onOpenSql(block, db)}
    >
      {t('browse.openSql')}
    </button>
  )
}
