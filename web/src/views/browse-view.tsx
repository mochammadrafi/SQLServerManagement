import { Database, RefreshCw, Search, Table2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { DataGrid } from '@/components/data-grid'
import { FolderPicker } from '@/components/folder-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  api,
  type CatalogObject,
  type DatabaseRow,
  type TablePage,
} from '@/lib/api'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'

type Catalog = {
  schemas: { name: string; is_system?: boolean }[]
  objects: Record<string, CatalogObject[]>
}

export function BrowseView({
  onOpenSql,
  onStatus,
}: {
  onOpenSql: (sql: string, database: string) => void
  onStatus: (text: string) => void
}) {
  const { t } = useLocale()
  const [databases, setDatabases] = useState<DatabaseRow[]>([])
  const [q, setQ] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [selectedDb, setSelectedDb] = useState('')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [table, setTable] = useState<{ database: string; schema: string; name: string } | null>(null)
  const [page, setPage] = useState<TablePage | null>(null)
  const [where, setWhere] = useState('')
  const [afterStack, setAfterStack] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState<'table' | 'db' | 'backup' | null>(null)
  const [folderOpen, setFolderOpen] = useState(false)
  const [folder, setFolder] = useState('')
  const [fileName, setFileName] = useState('')
  const [gzip, setGzip] = useState(true)

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

  const openDb = async (name: string, counts = false) => {
    setSelectedDb(name)
    setTable(null)
    setPage(null)
    onStatus(t('browse.loadingCatalog'))
    try {
      const data = await api.objects(name, counts)
      setCatalog({ schemas: data.schemas, objects: data.objects })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.apiUnreachable'))
    }
  }

  const openTable = async (database: string, schema: string, name: string) => {
    setTable({ database, schema, name })
    setAfterStack([])
    setWhere('')
    onStatus(`${schema}.${name}`)
    try {
      const data = await api.tablePage({ database, schema, table: name, page_size: 200 })
      setPage(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.apiUnreachable'))
    }
  }

  const loadPage = async (after?: Record<string, unknown> | null, reset = false) => {
    if (!table) return
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
  }

  const tables = (catalog?.objects.tables || []).filter((item) => showSystem || !item.is_system)
  const views = (catalog?.objects.views || []).filter((item) => showSystem || !item.is_system)

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
              {db.size_mb != null ? (
                <span className="ml-auto text-[10px] text-muted-foreground">{Number(db.size_mb).toFixed(0)} MB</span>
              ) : null}
            </button>
          ))}
        </ScrollArea>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
          <Table2 className="size-4 text-primary" />
          <div className="font-mono text-xs tracking-widest text-primary">{t('nav.browse').toUpperCase()}</div>
          <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">{t('browse.hint')}</span>
          {selectedDb ? (
            <div className="ml-auto flex flex-wrap gap-1">
              <Button variant="outline" size="sm" onClick={() => setExportOpen('backup')}>
                {t('browse.backup')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void openDb(selectedDb, true).then(() => setExportOpen('db'))}>
                {t('browse.exportDb')}
              </Button>
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
                    {t('browse.openSql')}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        {error ? (
          <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 font-mono text-xs text-destructive">
            {error}
          </div>
        ) : null}
        {table && page ? (
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
                disabled={!afterStack.length}
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
                disabled={!page.last_key || !page.has_more}
                onClick={() => {
                  if (!page.last_key) return
                  setAfterStack((s) => [...s, page.last_key as Record<string, unknown>])
                  void loadPage(page.last_key)
                }}
              >
                {t('common.next')}
              </Button>
              <Badge variant="muted">{table.schema}.{table.name}</Badge>
            </div>
            <DataGrid columns={page.columns} rows={page.rows} />
          </>
        ) : selectedDb && catalog ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <div className="font-mono text-[10px] tracking-widest text-muted-foreground">{t('browse.tables')}</div>
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {tables.map((item) => (
                  <button
                    key={`${item.schema}.${item.name}`}
                    type="button"
                    onClick={() => void openTable(selectedDb, item.schema, item.name)}
                    className="border border-border px-3 py-2 text-left hover:bg-accent/40"
                  >
                    <div className="truncate font-mono text-xs text-primary">{item.schema}.{item.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {item.row_count != null ? t('browse.rows', { n: item.row_count }) : 'table'}
                    </div>
                  </button>
                ))}
              </div>
              {views.length ? (
                <>
                  <div className="mt-4 font-mono text-[10px] tracking-widest text-muted-foreground">{t('browse.views')}</div>
                  <div className="mt-2 space-y-1">
                    {views.map((item) => (
                      <button
                        key={`${item.schema}.${item.name}`}
                        type="button"
                        className="block font-mono text-[11px] text-muted-foreground hover:text-primary"
                        onClick={() => void openTable(selectedDb, item.schema, item.name)}
                      >
                        {item.schema}.{item.name}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              {!tables.length ? <div className="mt-6 font-mono text-xs text-muted-foreground">{t('browse.noTables')}</div> : null}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-5 font-mono text-xs text-muted-foreground">{t('browse.empty')}</div>
        )}
      </section>
      <Dialog
        open={Boolean(exportOpen)}
        title={
          exportOpen === 'backup'
            ? t('export.backupTitle')
            : exportOpen === 'db'
              ? t('export.dbTitle')
              : t('export.title')
        }
        onClose={() => setExportOpen(null)}
        wide
        footer={
          <>
            <Button variant="outline" onClick={() => setExportOpen(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                void (async () => {
                  if (exportOpen === 'backup' && selectedDb) {
                    await api.startBackup({ database: selectedDb, folder, compress: gzip })
                  } else if (exportOpen === 'db' && selectedDb) {
                    await api.startDatabaseExport({
                      database: selectedDb,
                      tables: tables.map((item) => ({ schema: item.schema, name: item.name })),
                      folder,
                      gzip,
                    })
                  } else if (exportOpen === 'table' && table) {
                    const cols = await api.columns(table.database, table.schema, table.name)
                    await api.startExport({
                      database: table.database,
                      schema: table.schema,
                      table: table.name,
                      columns: cols.columns.map((c) => c.name),
                      where,
                      folder,
                      file_name: fileName,
                      gzip,
                    })
                  }
                  setExportOpen(null)
                })()
              }}
            >
              {exportOpen === 'backup' ? t('export.startBackup') : exportOpen === 'db' ? t('export.startDb') : t('export.start')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <div className="font-mono text-[10px] text-muted-foreground">{t('export.filename')}</div>
            <Input value={fileName} onChange={(e) => setFileName(e.target.value)} />
          </div>
          <div>
            <div className="font-mono text-[10px] text-muted-foreground">{t('export.folder')}</div>
            <div className="mt-1 flex gap-2">
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} />
              <Button variant="outline" onClick={() => setFolderOpen(true)}>
                {t('export.browse')}
              </Button>
            </div>
          </div>
          <label className="flex items-center gap-2 font-mono text-[11px]">
            <input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} />
            {exportOpen === 'backup' ? t('export.compress') : t('export.gzip')}
          </label>
        </div>
      </Dialog>
      <FolderPicker open={folderOpen} start={folder} onClose={() => setFolderOpen(false)} onPick={setFolder} />
    </div>
  )
}
