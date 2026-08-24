import { ChevronLeft, Database, RefreshCw, Search, Table2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { DataGrid } from '@/components/data-grid'
import { ExportDialog } from '@/components/export-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  api,
  type CatalogObject,
  type DatabaseRow,
  type Meta,
  type TablePage,
} from '@/lib/api'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'

type Catalog = {
  schemas: { name: string; is_system?: boolean }[]
  objects: Record<string, CatalogObject[]>
}

function formatSizeKb(kb?: number | null) {
  if (kb == null) return ''
  if (kb < 1024) return `${Math.round(kb)} KB`
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${(kb / (1024 * 1024)).toFixed(2)} GB`
}

function objectMeta(item: CatalogObject, kind: string) {
  const parts = [item.schema, kind]
  parts.push(item.row_count != null ? `${Number(item.row_count).toLocaleString()} rows` : 'rows unknown')
  if (item.size_kb != null) parts.push(formatSizeKb(item.size_kb))
  return parts.filter(Boolean).join(' · ')
}

export function BrowseView({
  active: _active,
  onOpenSql,
  onStatus,
  onExportStarted,
}: {
  active?: boolean
  onOpenSql: (sql: string, database: string) => void
  onStatus: (text: string) => void
  onExportStarted?: () => void
}) {
  const { t } = useLocale()
  const [databases, setDatabases] = useState<DatabaseRow[]>([])
  const [q, setQ] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [selectedDb, setSelectedDb] = useState('')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [table, setTable] = useState<{ database: string; schema: string; name: string } | null>(null)
  const [page, setPage] = useState<TablePage | null>(null)
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [where, setWhere] = useState('')
  const [afterStack, setAfterStack] = useState<Record<string, unknown>[]>([])
  const [kind, setKind] = useState<'all' | 'tables' | 'views'>('all')
  const [sort, setSort] = useState<'name' | 'rows' | 'size'>('name')
  const [loading, setLoading] = useState(true)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState<'table' | 'db' | 'backup' | null>(null)
  const [defaultFolder, setDefaultFolder] = useState('')
  const [exportLimits, setExportLimits] = useState<Meta['export_limits']>()

  const loadDbs = async () => {
    setLoading(true)
    try {
      const data = await api.databases()
      setDatabases(data.databases)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.apiUnreachable'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDbs()
    void api.meta().then((meta) => {
      setDefaultFolder(meta.default_folder || '')
      setExportLimits(meta.export_limits)
    })
  }, [])

  const visibleDbs = useMemo(
    () =>
      databases.filter((db) => {
        if (!showSystem && db.is_system) return false
        if (q && !db.name.toLowerCase().includes(q.toLowerCase())) return false
        return true
      }),
    [databases, q, showSystem],
  )

  const openDb = async (name: string) => {
    setSelectedDb(name)
    setTable(null)
    setPage(null)
    setRowCount(null)
    setCatalog(null)
    onStatus(t('browse.loadingCatalog'))
    try {
      const data = await api.objects(name, true)
      setCatalog({ schemas: data.schemas, objects: data.objects })
      setError(null)
      onStatus(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.apiUnreachable'))
    }
  }

  const openTable = async (database: string, schema: string, name: string) => {
    setTable({ database, schema, name })
    setAfterStack([])
    setWhere('')
    setPage(null)
    setPreviewing(true)
    onStatus(`${schema}.${name}`)
    try {
      const [data, stats] = await Promise.all([
        api.tablePage({ database, schema, table: name, page_size: 200 }),
        api.tableStats(database, schema, name).catch(() => null),
      ])
      setPage(data)
      setRowCount(stats?.row_count ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.apiUnreachable'))
    } finally {
      setPreviewing(false)
    }
  }

  const loadPage = async (after?: Record<string, unknown> | null, reset = false) => {
    if (!table) return
    setPreviewing(true)
    try {
      const data = await api.tablePage({
        database: table.database,
        schema: table.schema,
        table: table.name,
        page_size: 200,
        after: after || undefined,
        where,
      })
      setPage(data)
      if (reset) setAfterStack([])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.apiUnreachable'))
    } finally {
      setPreviewing(false)
    }
  }

  const tables = (catalog?.objects.tables || []).filter((item) => showSystem || !item.is_system)
  const views = (catalog?.objects.views || []).filter((item) => showSystem || !item.is_system)
  const procedures = (catalog?.objects.procedures || []).filter((item) => showSystem || !item.is_system)
  const functions = (catalog?.objects.functions || []).filter((item) => showSystem || !item.is_system)

  const cards = useMemo(() => {
    const items: { kind: 'tables' | 'views'; label: string; item: CatalogObject }[] = []
    if (kind !== 'views') tables.forEach((item) => items.push({ kind: 'tables', label: 'table', item }))
    if (kind !== 'tables') views.forEach((item) => items.push({ kind: 'views', label: 'view', item }))
    const needle = q.toLowerCase()
    const filtered = needle
      ? items.filter(
          (entry) =>
            entry.item.name.toLowerCase().includes(needle) ||
            entry.item.schema.toLowerCase().includes(needle),
        )
      : items
    return filtered.sort((a, b) => {
      if (sort === 'rows') return (b.item.row_count ?? -1) - (a.item.row_count ?? -1)
      if (sort === 'size') return (b.item.size_kb ?? -1) - (a.item.size_kb ?? -1)
      return `${a.item.schema}.${a.item.name}`.localeCompare(`${b.item.schema}.${b.item.name}`)
    })
  }, [tables, views, kind, q, sort])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
      <aside className="flex h-[36vh] w-full shrink-0 flex-col border-b border-border lg:h-auto lg:w-64 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Database className="size-4 text-primary" />
          <div className="font-mono text-xs tracking-widest text-primary">DB</div>
          <Button variant="outline" size="icon" className="ml-auto" onClick={() => void loadDbs()}>
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        </div>
        <div className="relative border-b border-border px-3 py-2">
          <Search className="pointer-events-none absolute top-4 left-5 size-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('browse.search')} className="pl-7" />
          <label className="mt-2 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
            <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
            {t('browse.system')}
          </label>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {visibleDbs.map((db) => (
            <button
              key={db.name}
              type="button"
              onClick={() => void openDb(db.name)}
              className={cn(
                'flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left font-mono text-[11px] hover:bg-accent/50',
                selectedDb === db.name && 'bg-accent text-primary',
              )}
            >
              <Database className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{db.name}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {db.size_mb != null ? `${Math.round(Number(db.size_mb)).toLocaleString()} MB` : '—'}
              </span>
            </button>
          ))}
        </ScrollArea>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
          <Table2 className="size-4 text-primary" />
          <div className="font-mono text-xs tracking-widest text-primary">{t('nav.browse').toUpperCase()}</div>
          {table ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-primary"
              onClick={() => {
                setTable(null)
                setPage(null)
              }}
            >
              <ChevronLeft className="size-3.5" />
              {selectedDb}
            </button>
          ) : null}
          <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">{t('browse.hint')}</span>
          <div className="ml-auto flex flex-wrap gap-1">
            {selectedDb ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setExportOpen('backup')}>
                  {t('browse.backup')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setExportOpen('db')}>
                  {t('browse.exportDb')}
                </Button>
              </>
            ) : null}
            {table ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setExportOpen('table')}>
                  {t('browse.exportTable')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void api.scriptSelect(table.schema, table.name, table.database).then((r) => onOpenSql(r.sql, table.database))
                  }
                >
                  {t('browse.script')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void api.scriptSelect(table.schema, table.name, table.database).then((r) => onOpenSql(r.sql, table.database))
                  }
                >
                  {t('browse.openSql')}
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {error ? (
          <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 font-mono text-xs text-destructive">
            {error}
          </div>
        ) : null}
        {table ? (
          <>
            <div className="flex flex-wrap items-end gap-2 border-b border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] text-muted-foreground">{t('browse.where')}</div>
                <Input
                  value={where}
                  onChange={(e) => setWhere(e.target.value)}
                  placeholder="Status = 1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void loadPage(null, true)
                  }}
                />
              </div>
              <Button
                variant="outline"
                disabled={!afterStack.length || previewing}
                onClick={() => {
                  const next = afterStack.slice(0, -1)
                  setAfterStack(next)
                  void loadPage(next[next.length - 1] || null)
                }}
              >
                {t('common.prev')}
              </Button>
              <Button
                variant="outline"
                disabled={!page?.last_key || !page.has_more || previewing}
                onClick={() => {
                  if (!page?.last_key) return
                  setAfterStack((s) => [...s, page.last_key as Record<string, unknown>])
                  void loadPage(page.last_key)
                }}
              >
                {t('common.next')}
              </Button>
              <Badge variant="muted">
                {table.schema}.{table.name}
                {rowCount != null ? ` · ${rowCount.toLocaleString()} ${t('browse.page')}` : ''}
                {previewing ? ` · ${t('browse.loadingPage')}` : ''}
              </Badge>
            </div>
            {page ? (
              <DataGrid columns={page.columns} rows={page.rows} />
            ) : (
              <div className="p-5 font-mono text-xs text-muted-foreground">
                {previewing ? t('browse.loadingPage') : t('browse.empty')}
              </div>
            )}
          </>
        ) : selectedDb && catalog ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] tracking-widest text-muted-foreground">{t('browse.catalog')}</div>
                  <div className="text-sm text-primary">{selectedDb}</div>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">{t('browse.clickPreview')}</p>
                </div>
                <div className="flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground">
                  <span>
                    <b className="text-foreground">{tables.length}</b> {t('browse.tables')}
                  </span>
                  <span>
                    <b className="text-foreground">{views.length}</b> {t('browse.views')}
                  </span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {(['all', 'tables', 'views'] as const).map((value) => (
                  <Button key={value} variant={kind === value ? 'default' : 'outline'} size="sm" onClick={() => setKind(value)}>
                    {value === 'all' ? t('browse.kindAll') : value === 'tables' ? t('browse.tables') : t('browse.views')}
                  </Button>
                ))}
                <Button variant={sort === 'name' ? 'default' : 'outline'} size="sm" onClick={() => setSort('name')}>
                  {t('browse.sortName')}
                </Button>
                <Button variant={sort === 'rows' ? 'default' : 'outline'} size="sm" onClick={() => setSort('rows')}>
                  {t('browse.sortRows')}
                </Button>
                <Button variant={sort === 'size' ? 'default' : 'outline'} size="sm" onClick={() => setSort('size')}>
                  {t('browse.sortSize')}
                </Button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {cards.map((entry) => (
                  <button
                    key={`${entry.kind}:${entry.item.schema}.${entry.item.name}`}
                    type="button"
                    onClick={() => void openTable(selectedDb, entry.item.schema, entry.item.name)}
                    className="border border-border px-3 py-2 text-left hover:bg-accent/40"
                  >
                    <div className="truncate font-mono text-xs text-primary">{entry.item.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{objectMeta(entry.item, entry.label)}</div>
                  </button>
                ))}
              </div>
              {!cards.length ? <div className="mt-6 font-mono text-xs text-muted-foreground">{t('browse.noTables')}</div> : null}
              {procedures.length || functions.length ? (
                <div className="mt-6 space-y-2 font-mono text-[11px] text-muted-foreground">
                  {procedures.length ? (
                    <div>
                      <div className="tracking-widest">{t('browse.procs')}</div>
                      {procedures.map((item) => (
                        <div key={`${item.schema}.${item.name}`}>
                          {item.schema}.{item.name}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {functions.length ? (
                    <div>
                      <div className="tracking-widest">{t('browse.functions')}</div>
                      {functions.map((item) => (
                        <div key={`${item.schema}.${item.name}`}>
                          {item.schema}.{item.name}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </ScrollArea>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <div className="font-mono text-[10px] tracking-widest text-muted-foreground">{t('browse.catalog')}</div>
              <div className="mt-1 text-sm text-primary">{t('browse.home')}</div>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">{t('browse.empty')}</p>
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {visibleDbs.map((db) => (
                  <button
                    key={db.name}
                    type="button"
                    onClick={() => void openDb(db.name)}
                    className="border border-border px-3 py-2 text-left hover:bg-accent/40"
                  >
                    <div className="truncate font-mono text-xs text-primary">{db.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {[db.state_desc || db.state, db.size_mb != null ? `${Math.round(Number(db.size_mb)).toLocaleString()} MB` : t('browse.sizeUnknown')]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </ScrollArea>
        )}
      </section>
      <ExportDialog
        mode={exportOpen}
        onClose={() => setExportOpen(null)}
        onStarted={onExportStarted}
        defaultFolder={defaultFolder}
        limits={exportLimits}
        table={table || undefined}
        rowCount={rowCount}
        initialWhere={where}
        database={selectedDb || undefined}
        dbTables={tables}
        dbViews={views}
        databases={databases}
        backupDatabase={selectedDb || undefined}
      />
    </div>
  )
}
