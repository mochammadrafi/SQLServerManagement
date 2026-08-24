import { useEffect, useMemo, useState } from 'react'
import { FolderPicker } from '@/components/folder-picker'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { DynamicSelect } from '@/components/ui/dynamic-select'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  api,
  type CatalogObject,
  type DatabaseRow,
  type Meta,
} from '@/lib/api'
import {
  BACKUP_CHUNK_OPTIONS,
  CHUNK_ROW_OPTIONS,
  CHUNK_SIZE_OPTIONS,
  chunkFromForm,
  readBatchSize,
  writeBatchSize,
  type ChunkMode,
} from '@/lib/export-form'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'

type ExportMode = 'table' | 'db' | 'backup'

function formatCount(value: number | null | undefined) {
  if (value == null) return '—'
  return Number(value).toLocaleString()
}

function ChunkFields({
  mode,
  chunkMode,
  chunkSize,
  chunkRows,
  customGb,
  onModeChange,
  onSizeChange,
  onRowsChange,
  onCustomChange,
  t,
}: {
  mode: ExportMode
  chunkMode: ChunkMode
  chunkSize: string
  chunkRows: string
  customGb: string
  onModeChange: (value: ChunkMode) => void
  onSizeChange: (value: string) => void
  onRowsChange: (value: string) => void
  onCustomChange: (value: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const modeOptions = [
    { value: 'size', label: t('export.chunkSize') },
    { value: 'rows', label: t('export.chunkRows') },
    { value: 'none', label: mode === 'db' ? t('export.chunkDbNone') : t('export.chunkNone') },
  ]
  return (
    <>
      <div>
        <div className="font-mono text-[10px] text-muted-foreground">{t('export.chunk')}</div>
        <DynamicSelect
          className="mt-1"
          options={modeOptions}
          value={chunkMode}
          onChange={(value) => onModeChange(value as ChunkMode)}
        />
      </div>
      {chunkMode === 'size' ? (
        <>
          <div>
            <div className="font-mono text-[10px] text-muted-foreground">{t('export.chunkSize')}</div>
            <DynamicSelect
              className="mt-1"
              options={CHUNK_SIZE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
              value={chunkSize}
              onChange={onSizeChange}
            />
          </div>
          {chunkSize === 'custom' ? (
            <div>
              <div className="font-mono text-[10px] text-muted-foreground">{t('export.customGb')}</div>
              <Input className="mt-1" value={customGb} onChange={(e) => onCustomChange(e.target.value)} inputMode="numeric" />
            </div>
          ) : null}
        </>
      ) : null}
      {chunkMode === 'rows' ? (
        <div>
          <div className="font-mono text-[10px] text-muted-foreground">{t('export.chunkRows')}</div>
          <DynamicSelect
            className="mt-1"
            options={CHUNK_ROW_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
            value={chunkRows}
            onChange={onRowsChange}
          />
        </div>
      ) : null}
    </>
  )
}

export function ExportDialog({
  mode,
  onClose,
  onStarted,
  defaultFolder,
  limits,
  table,
  rowCount,
  initialWhere = '',
  database,
  dbTables = [],
  dbViews = [],
  databases = [],
  backupDatabase,
}: {
  mode: ExportMode | null
  onClose: () => void
  onStarted?: () => void
  defaultFolder: string
  limits?: Meta['export_limits']
  table?: { database: string; schema: string; name: string }
  rowCount?: number | null
  initialWhere?: string
  database?: string
  dbTables?: CatalogObject[]
  dbViews?: CatalogObject[]
  databases?: DatabaseRow[]
  backupDatabase?: string
}) {
  const { t } = useLocale()
  const [folder, setFolder] = useState(defaultFolder)
  const [folderOpen, setFolderOpen] = useState(false)
  const [fileName, setFileName] = useState('')
  const [exportWhere, setExportWhere] = useState('')
  const [gzip, setGzip] = useState(true)
  const [nolock, setNolock] = useState(true)
  const [includeViews, setIncludeViews] = useState(false)
  const [workers, setWorkers] = useState('3')
  const [batchSize, setBatchSize] = useState(String(readBatchSize(limits?.batch_size || 10000)))
  const [chunkMode, setChunkMode] = useState<ChunkMode>('size')
  const [chunkSize, setChunkSize] = useState('10737418240')
  const [chunkRows, setChunkRows] = useState('1000000')
  const [customGb, setCustomGb] = useState('10')
  const [backupChunk, setBackupChunk] = useState('10737418240')
  const [backupDb, setBackupDb] = useState('')
  const [columns, setColumns] = useState<{ name: string; type?: string }[]>([])
  const [pickedColumns, setPickedColumns] = useState<Record<string, boolean>>({})
  const [pickedTables, setPickedTables] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!mode) return
    setFolder((current) => current || defaultFolder)
    setError(null)
    setBusy(false)
    if (mode === 'table' && table) {
      setFileName(table.name)
      setExportWhere(initialWhere)
      void api.columns(table.database, table.schema, table.name).then((result) => {
        setColumns(result.columns)
        setPickedColumns(Object.fromEntries(result.columns.map((col) => [col.name, true])))
      })
    }
    if (mode === 'db') {
      setFileName('')
      const next: Record<string, boolean> = {}
      for (const item of dbTables) next[`${item.schema}.${item.name}`] = true
      setPickedTables(next)
    }
    if (mode === 'backup') {
      setBackupDb(backupDatabase || database || databases[0]?.name || '')
    }
  }, [mode, table, initialWhere, defaultFolder, dbTables, backupDatabase, database, databases])

  const dbObjects = useMemo(() => {
    const items: { schema: string; name: string; kind: 'table' | 'view'; row_count?: number | null }[] = []
    for (const item of dbTables) items.push({ schema: item.schema, name: item.name, kind: 'table', row_count: item.row_count })
    if (includeViews) {
      for (const item of dbViews) items.push({ schema: item.schema, name: item.name, kind: 'view', row_count: item.row_count })
    }
    return items.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`))
  }, [dbTables, dbViews, includeViews])

  const selectedColumns = columns.filter((col) => pickedColumns[col.name]).map((col) => col.name)
  const selectedTables = dbObjects
    .filter((item) => pickedTables[`${item.schema}.${item.name}`])
    .map((item) => ({ schema: item.schema, name: item.name }))

  const start = async () => {
    if (!mode) return
    setError(null)
    const chunks = chunkFromForm(chunkMode, chunkSize, chunkRows, customGb)
    if (!chunks && mode !== 'backup') {
      setError(t('export.customGbError'))
      return
    }
    setBusy(true)
    try {
      if (mode === 'table' && table) {
        if (!selectedColumns.length) {
          setError(t('export.pickColumn'))
          return
        }
        writeBatchSize(Number(batchSize || limits?.batch_size || 10000))
        await api.startExport({
          database: table.database,
          schema: table.schema,
          table: table.name,
          columns: selectedColumns,
          where: exportWhere,
          folder,
          file_name: fileName || table.name,
          gzip,
          nolock,
          batch_size: Number(batchSize),
          chunk_rows: chunks?.chunk_rows || 0,
          chunk_bytes: chunks?.chunk_bytes || 0,
        })
      } else if (mode === 'db' && database) {
        if (!selectedTables.length) {
          setError(t('export.pickTable'))
          return
        }
        writeBatchSize(Number(batchSize || limits?.batch_size || 10000))
        await api.startDatabaseExport({
          database,
          tables: selectedTables,
          include_views: includeViews,
          folder,
          file_name: fileName,
          gzip,
          nolock,
          workers: Number(workers || 3),
          batch_size: Number(batchSize),
          chunk_rows: chunks?.chunk_rows || 0,
          chunk_bytes: chunks?.chunk_bytes || 0,
        })
      } else if (mode === 'backup') {
        if (!backupDb) {
          setError(t('export.pickDatabase'))
          return
        }
        await api.startBackup({
          database: backupDb,
          folder,
          compress: gzip,
          chunk_bytes: Number(backupChunk || 0),
        })
      }
      onStarted?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const title =
    mode === 'backup' ? t('export.backupTitle') : mode === 'db' ? t('export.dbTitle') : t('export.title')

  return (
    <>
      <Dialog
        open={Boolean(mode)}
        title={title}
        onClose={onClose}
        wide
        footer={
          <>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void start()} disabled={busy}>
              {mode === 'backup' ? t('export.startBackup') : mode === 'db' ? t('export.startDb') : t('export.start')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {mode === 'table' && table ? (
            <>
              <div className="font-mono text-xs text-primary">
                {table.database}.{table.schema}.{table.name}
              </div>
              {rowCount != null && rowCount >= 1_000_000 ? (
                <p className="font-mono text-[11px] text-amber-500">{t('export.warnLarge', { n: formatCount(rowCount) })}</p>
              ) : rowCount != null ? (
                <p className="font-mono text-[11px] text-muted-foreground">{t('export.estimate', { n: formatCount(rowCount) })}</p>
              ) : null}
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <div className="font-mono text-[10px] text-muted-foreground">{t('export.columns')}</div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPickedColumns(Object.fromEntries(columns.map((col) => [col.name, true])))}
                  >
                    {t('export.all')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPickedColumns({})}>
                    {t('export.none')}
                  </Button>
                </div>
                <ScrollArea className="max-h-40 border border-border">
                  <div className="grid gap-1 p-2 md:grid-cols-2">
                    {columns.map((col) => (
                      <label key={col.name} className="flex items-center gap-2 font-mono text-[11px]">
                        <input
                          type="checkbox"
                          checked={Boolean(pickedColumns[col.name])}
                          onChange={(e) => setPickedColumns((current) => ({ ...current, [col.name]: e.target.checked }))}
                        />
                        <span>
                          {col.name}
                          {col.type ? <span className="text-muted-foreground"> ({col.type})</span> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              </div>
              <div>
                <div className="font-mono text-[10px] text-muted-foreground">{t('export.where')}</div>
                <Input
                  className="mt-1"
                  value={exportWhere}
                  onChange={(e) => setExportWhere(e.target.value)}
                  placeholder="CreatedAt >= '2024-01-01' AND Status = 1"
                />
              </div>
            </>
          ) : null}

          {mode === 'db' && database ? (
            <>
              <div className="font-mono text-xs text-primary">{database}</div>
              <div className="flex flex-wrap gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPickedTables(Object.fromEntries(dbObjects.map((item) => [`${item.schema}.${item.name}`, true])))
                  }
                >
                  {t('export.all')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPickedTables({})}>
                  {t('export.none')}
                </Button>
              </div>
              <ScrollArea className="max-h-48 border border-border">
                <div className="grid gap-1 p-2 md:grid-cols-2">
                  {dbObjects.map((item) => {
                    const key = `${item.schema}.${item.name}`
                    return (
                      <label key={key} className="flex items-center gap-2 font-mono text-[11px]">
                        <input
                          type="checkbox"
                          checked={Boolean(pickedTables[key])}
                          onChange={(e) => setPickedTables((current) => ({ ...current, [key]: e.target.checked }))}
                        />
                        <span>
                          {item.schema}.{item.name}
                          {item.kind === 'view' ? <span className="text-muted-foreground"> (view)</span> : null}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </ScrollArea>
              <label className="flex items-center gap-2 font-mono text-[11px]">
                <input type="checkbox" checked={includeViews} onChange={(e) => setIncludeViews(e.target.checked)} />
                {t('export.views')}
              </label>
              <div>
                <div className="font-mono text-[10px] text-muted-foreground">{t('export.workers')}</div>
                <Input className="mt-1 w-32" value={workers} onChange={(e) => setWorkers(e.target.value)} inputMode="numeric" />
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">{t('export.workersHint')}</p>
              </div>
            </>
          ) : null}

          {mode === 'backup' ? (
            <>
              <p className="font-mono text-[11px] text-muted-foreground">{t('export.backupHint')}</p>
              <div>
                <div className="font-mono text-[10px] text-muted-foreground">{t('export.database')}</div>
                <DynamicSelect
                  className="mt-1"
                  options={databases.map((db) => ({ value: db.name, label: db.name }))}
                  value={backupDb}
                  onChange={setBackupDb}
                />
              </div>
              <div>
                <div className="font-mono text-[10px] text-muted-foreground">{t('export.chunk')}</div>
                <DynamicSelect
                  className="mt-1"
                  options={BACKUP_CHUNK_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                  value={backupChunk}
                  onChange={setBackupChunk}
                />
              </div>
            </>
          ) : null}

          {mode !== 'backup' ? (
            <>
              <div>
                <div className="font-mono text-[10px] text-muted-foreground">{t('export.filename')}</div>
                <Input className="mt-1" value={fileName} onChange={(e) => setFileName(e.target.value)} />
              </div>
              <ChunkFields
                mode={mode || 'table'}
                chunkMode={chunkMode}
                chunkSize={chunkSize}
                chunkRows={chunkRows}
                customGb={customGb}
                onModeChange={setChunkMode}
                onSizeChange={setChunkSize}
                onRowsChange={setChunkRows}
                onCustomChange={setCustomGb}
                t={t}
              />
              <div>
                <div className="font-mono text-[10px] text-muted-foreground">{t('export.batch')}</div>
                <Input className="mt-1 w-40" value={batchSize} onChange={(e) => setBatchSize(e.target.value)} inputMode="numeric" />
              </div>
              <label className="flex items-center gap-2 font-mono text-[11px]">
                <input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} />
                {t('export.gzip')}
              </label>
              <label className="flex items-center gap-2 font-mono text-[11px]">
                <input type="checkbox" checked={nolock} onChange={(e) => setNolock(e.target.checked)} />
                {t('export.nolock')}
              </label>
            </>
          ) : (
            <label className="flex items-center gap-2 font-mono text-[11px]">
              <input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} />
              {t('export.compress')}
            </label>
          )}

          <div>
            <div className="font-mono text-[10px] text-muted-foreground">{t('export.folder')}</div>
            <div className="mt-1 flex gap-2">
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} />
              <Button variant="outline" onClick={() => setFolderOpen(true)}>
                {t('export.browse')}
              </Button>
            </div>
          </div>

          {error ? <div className={cn('font-mono text-[11px] text-destructive')}>{error}</div> : null}
        </div>
      </Dialog>
      <FolderPicker open={folderOpen} start={folder} onClose={() => setFolderOpen(false)} onPick={setFolder} />
    </>
  )
}
