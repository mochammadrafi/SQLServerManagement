import { Play, Plus, Square, Terminal, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DataGrid } from '@/components/data-grid'
import { Button } from '@/components/ui/button'
import { DynamicSelect } from '@/components/ui/dynamic-select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type DatabaseRow } from '@/lib/api'
import { useLocale } from '@/lib/i18n'
import { createSqlTab, patchSqlTabs, sqlTabTitle, type ShellState, type SqlTabState } from '@/lib/shell-state'
import { cn } from '@/lib/utils'

export function SqlView({
  active,
  shell,
  onShellChange,
}: {
  active: boolean
  shell: ShellState
  onShellChange: (next: ShellState) => void
}) {
  const { t } = useLocale()
  const [databases, setDatabases] = useState<DatabaseRow[]>([])
  const [running, setRunning] = useState(false)
  const tabs = shell.sqlTabs
  const activeTabId = shell.sqlActiveId
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) || tabs[0],
    [tabs, activeTabId],
  )

  const setTabs = useCallback(
    (nextTabs: SqlTabState[], nextActiveId = activeTabId) => {
      onShellChange(patchSqlTabs(shell, nextTabs, nextActiveId))
    },
    [activeTabId, onShellChange, shell],
  )

  const patchActiveTab = useCallback(
    (patch: Partial<SqlTabState>) => {
      if (!activeTab) return
      setTabs(
        tabs.map((tab) => (tab.id === activeTab.id ? { ...tab, ...patch } : tab)),
        activeTab.id,
      )
    },
    [activeTab, setTabs, tabs],
  )

  useEffect(() => {
    void api.databases().then((r) => setDatabases(r.databases)).catch(() => setDatabases([]))
  }, [])

  useEffect(() => {
    if (!activeTab || !databases.length) return
    if (!databases.some((db) => db.name === activeTab.database)) {
      patchActiveTab({ database: databases[0].name })
    }
  }, [activeTab, databases, patchActiveTab])

  const run = useCallback(async () => {
    if (!activeTab) return
    setRunning(true)
    patchActiveTab({ error: null })
    try {
      const data = await api.query(activeTab.sql, activeTab.database, 1000)
      const first = data.result_sets?.[0]
      patchActiveTab({
        result: {
          ...data,
          columns: first?.columns || data.columns || [],
          rows: (first?.rows || data.rows || []) as unknown[][],
        },
      })
    } catch (err) {
      patchActiveTab({
        error: err instanceof Error ? err.message : t('error.apiUnreachable'),
        result: null,
      })
    } finally {
      setRunning(false)
    }
  }, [activeTab, patchActiveTab, t])

  useEffect(() => {
    if (!active || !activeTab) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
        e.preventDefault()
        void run()
      }
      if (e.key === 'Escape') void api.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, activeTab, run])

  const addTab = () => {
    const tab = createSqlTab()
    tab.title = sqlTabTitle(tab.sql, tabs.length + 1)
    setTabs([...tabs, tab], tab.id)
  }

  const closeTab = (id: string) => {
    if (tabs.length <= 1) {
      const tab = createSqlTab()
      setTabs([tab], tab.id)
      return
    }
    const nextTabs = tabs.filter((tab) => tab.id !== id)
    const nextActive = id === activeTabId ? nextTabs[0]?.id || nextTabs[nextTabs.length - 1].id : activeTabId
    setTabs(nextTabs, nextActive)
  }

  if (!activeTab) return null

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <Terminal className="size-4 text-primary" />
        <div className="font-mono text-xs tracking-widest text-primary">SQL</div>
        <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">{t('sql.hint')}</span>
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="w-full sm:w-48">
            <DynamicSelect
              value={activeTab.database}
              onChange={(database) => patchActiveTab({ database })}
              options={databases.map((db) => ({ value: db.name, label: db.name }))}
              placeholder={t('sql.database')}
            />
          </div>
          <Button disabled={!active || running} onClick={() => void run()}>
            <Play />
            {running ? t('sql.running') : t('sql.run')}
          </Button>
          <Button variant="outline" disabled={!active || !running} onClick={() => void api.cancel()}>
            <Square />
            {t('sql.cancel')}
          </Button>
          <Button variant="outline" onClick={addTab}>
            <Plus />
            {t('sql.newTab')}
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card/40 px-2 py-1">
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            className={cn(
              'flex max-w-[220px] shrink-0 items-center gap-1 rounded border px-2 py-1 font-mono text-[10px]',
              tab.id === activeTabId
                ? 'border-primary/40 bg-accent text-primary'
                : 'border-border bg-background/50 text-muted-foreground hover:bg-accent/40',
            )}
          >
            <button type="button" className="min-w-0 truncate" onClick={() => setTabs(tabs, tab.id)}>
              {tab.title || sqlTabTitle(tab.sql, index + 1)}
            </button>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 hover:bg-background/80"
              aria-label={t('sql.closeTab')}
              onClick={() => closeTab(tab.id)}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>

      <textarea
        value={activeTab.sql}
        onChange={(e) => {
          const sql = e.target.value
          patchActiveTab({
            sql,
            title: sqlTabTitle(sql, tabs.findIndex((tab) => tab.id === activeTab.id) + 1),
          })
        }}
        spellCheck={false}
        className="h-40 shrink-0 resize-none border-b border-border bg-background/40 p-3 font-mono text-xs outline-none"
      />
      {activeTab.error ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 font-mono text-xs text-destructive">
          {activeTab.error}
        </div>
      ) : null}
      {activeTab.result?.messages?.length ? (
        <div className="border-b border-border px-4 py-2 font-mono text-[11px] text-muted-foreground">
          {activeTab.result.messages.join(' · ')}
        </div>
      ) : null}
      {activeTab.result ? (
        <DataGrid columns={activeTab.result.columns} rows={activeTab.result.rows} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-5 font-mono text-xs text-muted-foreground">{t('sql.empty')}</div>
        </ScrollArea>
      )}
    </section>
  )
}
