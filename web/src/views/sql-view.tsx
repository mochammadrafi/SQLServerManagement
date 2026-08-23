import { Play, Square, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DataGrid } from '@/components/data-grid'
import { Button } from '@/components/ui/button'
import { DynamicSelect } from '@/components/ui/dynamic-select'
import { api, type DatabaseRow, type TablePage } from '@/lib/api'
import { useLocale } from '@/lib/i18n'

export function SqlView({
  initialSql,
  initialDb,
}: {
  initialSql?: string
  initialDb?: string
}) {
  const { t } = useLocale()
  const [sql, setSql] = useState(initialSql || 'SELECT TOP 100 * FROM sys.databases;')
  const [database, setDatabase] = useState(initialDb || 'master')
  const [databases, setDatabases] = useState<DatabaseRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<(TablePage & { messages?: string[] }) | null>(null)

  useEffect(() => {
    if (initialSql) setSql(initialSql)
    if (initialDb) setDatabase(initialDb)
  }, [initialSql, initialDb])

  useEffect(() => {
    void api.databases().then((r) => setDatabases(r.databases)).catch(() => setDatabases([]))
  }, [])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.query(sql, database, 1000)
      const first = data.result_sets?.[0]
      setResult({
        ...data,
        columns: first?.columns || data.columns || [],
        rows: (first?.rows || data.rows || []) as unknown[][],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.apiUnreachable'))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
        e.preventDefault()
        void run()
      }
      if (e.key === 'Escape' && busy) void api.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <Terminal className="size-4 text-primary" />
        <div className="font-mono text-xs tracking-widest text-primary">SQL</div>
        <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">{t('sql.hint')}</span>
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="w-full sm:w-48">
            <DynamicSelect
              value={database}
              onChange={setDatabase}
              options={databases.map((db) => ({ value: db.name, label: db.name }))}
              placeholder={t('sql.database')}
            />
          </div>
          <Button disabled={busy} onClick={() => void run()}>
            <Play />
            {busy ? t('sql.running') : t('sql.run')}
          </Button>
          <Button variant="outline" disabled={!busy} onClick={() => void api.cancel()}>
            <Square />
            {t('sql.cancel')}
          </Button>
          <Button variant="outline" onClick={() => setSql('')}>
            {t('sql.new')}
          </Button>
        </div>
      </div>
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        spellCheck={false}
        className="h-40 shrink-0 resize-none border-b border-border bg-background/40 p-3 font-mono text-xs outline-none"
      />
      {error ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {result?.messages?.length ? (
        <div className="border-b border-border px-4 py-2 font-mono text-[11px] text-muted-foreground">
          {result.messages.join(' · ')}
        </div>
      ) : null}
      {result ? (
        <DataGrid columns={result.columns} rows={result.rows} />
      ) : (
        <div className="p-5 font-mono text-xs text-muted-foreground">{t('sql.empty')}</div>
      )}
    </section>
  )
}
