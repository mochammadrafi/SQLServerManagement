import { Plus, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AiMentionInput } from '@/components/ai-mention-input'
import { ContextTree, SqlBlock } from '@/components/ai-context-tree'
import { Button } from '@/components/ui/button'
import { PasswordInput } from '@/components/ui/password-input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { parseMentionTables } from '@/lib/ai-mentions'
import { api, type AiStep, type DatabaseRow } from '@/lib/api'
import { localeTag, useLocale } from '@/lib/i18n'
import {
  addChatSession,
  chatSessionTitle,
  getActiveSession,
  patchActiveSession,
  removeChatSession,
  switchChatSession,
  type AiShellState,
} from '@/lib/shell-state'
import { cn } from '@/lib/utils'

const LIVE_STEPS = ['scope', 'catalog', 'columns', 'samples', 'model', 'validate'] as const

function ProcessSteps({
  steps,
  busy,
  t,
}: {
  steps?: AiStep[]
  busy?: boolean
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const [liveIndex, setLiveIndex] = useState(0)

  useEffect(() => {
    if (!busy) {
      setLiveIndex(0)
      return
    }
    setLiveIndex(0)
    const timer = window.setInterval(() => {
      setLiveIndex((value) => Math.min(value + 1, LIVE_STEPS.length - 1))
    }, 900)
    return () => window.clearInterval(timer)
  }, [busy])

  const rows =
    steps?.length
      ? steps
      : busy
        ? LIVE_STEPS.slice(0, liveIndex + 1).map((id, index) => ({
            id,
            label: t(`ai.step.${id}`),
            detail: t(`ai.live.${id}`),
            ms: index === liveIndex ? undefined : 1,
          }))
        : []

  if (!rows.length) return null

  return (
    <div className="space-y-1.5">
      {rows.map((item, index) => {
        const done = Boolean(item.ms) || (!busy && index < rows.length - 1)
        const active = busy && index === rows.length - 1 && !item.ms
        return (
          <div
            key={`${item.id}-${index}`}
            className={cn(
              'rounded border px-2 py-1.5 font-mono text-[10px]',
              active ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-background/50',
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px]',
                  done ? 'border-primary/50 text-primary' : 'border-muted-foreground/40 text-muted-foreground',
                )}
              >
                {done ? '✓' : index + 1}
              </span>
              <span className="truncate">{item.label}</span>
              {item.ms != null && item.ms > 0 ? (
                <span className="ml-auto shrink-0 text-muted-foreground">{item.ms}ms</span>
              ) : null}
            </div>
            {item.detail ? <div className="mt-1 pl-6 text-muted-foreground">{item.detail}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

export function AiView({
  active,
  connectionId,
  ai,
  onAiChange,
  onOpenSql,
}: {
  active: boolean
  connectionId: string
  ai: AiShellState
  onAiChange: (patch: Partial<AiShellState> | ((current: AiShellState) => AiShellState)) => void
  onOpenSql: (sql: string, database: string) => void
}) {
  const { t, locale } = useLocale()
  const [databases, setDatabases] = useState<DatabaseRow[]>([])
  const [busy, setBusy] = useState(false)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [detailBusy, setDetailBusy] = useState(false)
  const [key, setKey] = useState('')
  const [masked, setMasked] = useState('')
  const [configured, setConfigured] = useState(false)

  const patchAi = onAiChange
  const session = getActiveSession(ai)
  const { selected, samples, catalog, showPanel, sessions, activeSessionId } = ai
  const { mode, message, sql, items, detailContext, detailSteps, error } = session

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  )

  const patchSession = useCallback(
    (patch: Parameters<typeof patchActiveSession>[1], aiPatch?: Partial<AiShellState>) => {
      patchAi((current) => {
        const next = patchActiveSession(current, patch)
        return aiPatch ? { ...next, ...aiPatch } : next
      })
    },
    [patchAi],
  )

  const formatSessionTime = (value: number) =>
    new Date(value).toLocaleString(localeTag(locale), {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })

  const lastAi = useMemo(() => [...items].reverse().find((item) => item.role === 'ai'), [items])
  const panelContext = lastAi?.context || detailContext
  const panelSteps = busy ? undefined : lastAi?.steps || detailSteps
  const showProcess = busy || detailBusy
  const defaultDb = selected[0] || 'master'
  const selectedKey = selected.join('|')

  const mentionTables = useMemo(
    () => parseMentionTables(message, defaultDb),
    [message, defaultDb],
  )

  useEffect(() => {
    setBusy(false)
    setCatalogBusy(false)
    setDetailBusy(false)
    void api.databases().then((r) => {
      const user = r.databases.filter((db) => !db.is_system)
      setDatabases(user)
      onAiChange((current) => {
        if (current.selected.length) return current
        if (!user.length) return current
        return { ...current, selected: user.slice(0, 1).map((db) => db.name) }
      })
    })
  }, [connectionId, onAiChange])

  useEffect(() => {
    void api.aiSettings().then((s) => {
      setConfigured(s.configured)
      setMasked(s.masked)
    })
  }, [])

  useEffect(() => {
    if (!active) return
    if (!selected.length) {
      patchAi((current) => ({
        ...patchActiveSession(current, { detailContext: [], detailSteps: [] }),
        catalog: [],
      }))
      return
    }
    let cancelled = false
    setCatalogBusy(true)
    void api
      .aiCatalog({ databases: selected })
      .then((result) => {
        if (cancelled) return
        patchAi((current) => ({
          ...patchActiveSession(current, { detailContext: [], detailSteps: [] }),
          catalog: result.catalog,
        }))
      })
      .catch(() => {
        if (cancelled) return
        patchAi((current) => ({
          ...patchActiveSession(current, { detailContext: [], detailSteps: [] }),
          catalog: [],
        }))
      })
      .finally(() => {
        if (!cancelled) setCatalogBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, selectedKey, connectionId, patchAi, selected])

  const loadDetailContext = useCallback(async () => {
    if (!selected.length) {
      patchSession({ detailContext: [], detailSteps: [] })
      return
    }
    setDetailBusy(true)
    try {
      const result = await api.aiContext({
        databases: selected,
        tables: mentionTables,
        message,
        include_samples: samples,
      })
      patchSession(
        {
          detailContext: result.context,
          detailSteps: result.steps,
        },
        { catalog: result.catalog.length ? result.catalog : catalog },
      )
    } catch {
      patchSession({ detailContext: [], detailSteps: [] })
    } finally {
      setDetailBusy(false)
    }
  }, [catalog, mentionTables, message, patchSession, samples, selected])

  const toggleDb = (name: string) => {
    patchAi((current) => ({
      ...current,
      selected: current.selected.includes(name)
        ? current.selected.filter((item) => item !== name)
        : [...current.selected, name],
    }))
  }

  const ask = async () => {
    setBusy(true)
    patchSession({ error: null })
    const prompt = message.trim()
    patchSession((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          role: 'user',
          text: mode === 'query' ? prompt : prompt || t('ai.pasteSql'),
        },
      ],
    }))
    try {
      const reply = await api.aiAsk({
        mode,
        message: prompt,
        databases: selected,
        tables: mentionTables,
        include_samples: samples,
        sql: mode === 'analyze' ? sql : undefined,
      })
      patchSession((current) => {
        const nextItems = [
          ...current.items,
          {
            role: 'ai' as const,
            text: reply.explanation,
            sql: reply.sql,
            notes: reply.notes,
            warnings: reply.warnings,
            used_objects: reply.used_objects,
            context: reply.context,
            steps: reply.steps,
            model: reply.model,
          },
        ]
        return {
          ...current,
          items: nextItems,
          title: chatSessionTitle(nextItems, current.title),
          detailContext: reply.context || current.detailContext,
          detailSteps: reply.steps || current.detailSteps,
          message: mode === 'query' ? '' : current.message,
        }
      })
      patchAi({ showPanel: true })
    } catch (err) {
      patchSession({ error: err instanceof Error ? err.message : t('error.apiUnreachable') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <Sparkles className="size-4 text-primary" />
        <div className="font-mono text-xs tracking-widest text-primary">AI</div>
        <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">{t('ai.hint')}</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto lg:hidden"
          onClick={() => patchAi({ showPanel: !showPanel })}
        >
          {showPanel ? t('ai.hideContext') : t('ai.showContext')}
        </Button>
        <div className="font-mono text-[10px] text-muted-foreground lg:ml-auto">
          {configured ? masked : t('ai.noKey')}
        </div>
      </div>
      {error ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <aside className="flex max-h-[36vh] w-full shrink-0 flex-col border-b border-border xl:max-h-none xl:w-56 xl:border-r xl:border-b-0">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <div className="font-mono text-[10px] tracking-widest text-muted-foreground">{t('ai.history')}</div>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 px-2"
              disabled={busy}
              onClick={() => patchAi((current) => addChatSession(current))}
            >
              <Plus className="size-3" />
              {t('ai.newChat')}
            </Button>
          </div>
          <ScrollArea className="max-h-32 shrink-0 border-b border-border xl:max-h-44">
            <div className="space-y-1 p-2">
              {sortedSessions.map((entry) => {
                const activeSession = entry.id === activeSessionId
                const turns = entry.items.filter((item) => item.role === 'user').length
                return (
                  <div
                    key={entry.id}
                    className={cn(
                      'flex items-start gap-1 rounded border px-2 py-1.5',
                      activeSession
                        ? 'border-primary/40 bg-accent text-primary'
                        : 'border-border bg-background/50 hover:bg-accent/40',
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      disabled={busy}
                      onClick={() => patchAi((current) => switchChatSession(current, entry.id))}
                    >
                      <div className="truncate font-mono text-[11px]">{entry.title}</div>
                      <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                        {formatSessionTime(entry.updatedAt)}
                        {turns ? ` · ${t('ai.sessionTurns', { n: turns })}` : ` · ${t('ai.sessionEmpty')}`}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 hover:bg-background/80"
                      aria-label={t('ai.deleteSession')}
                      disabled={busy}
                      onClick={() => patchAi((current) => removeChatSession(current, entry.id))}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
          <div className="border-b border-border px-3 py-2 font-mono text-[10px] tracking-widest text-muted-foreground">
            {t('ai.scope')}
          </div>
          <div className="flex flex-wrap gap-1 px-3 py-2">
            <Button variant="outline" size="sm" onClick={() => patchAi({ selected: databases.map((db) => db.name) })}>
              {t('ai.allDb')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => patchAi({ selected: databases.slice(0, 1).map((db) => db.name) })}
            >
              {t('ai.oneDb')}
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1 px-3 pb-2">
            {databases.map((db) => (
              <label key={db.name} className="flex items-center gap-2 py-1 font-mono text-[11px]">
                <input type="checkbox" checked={selected.includes(db.name)} onChange={() => toggleDb(db.name)} />
                <span className="truncate">{db.name}</span>
              </label>
            ))}
          </ScrollArea>
          <label className="flex items-center gap-2 border-t border-border px-3 py-2 font-mono text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={samples}
              onChange={(e) => patchAi({ samples: e.target.checked })}
            />
            {t('ai.samples')}
          </label>
          <div className="space-y-2 border-t border-border px-3 py-2">
            <div className="font-mono text-[10px] text-muted-foreground">{t('ai.key')}</div>
            <PasswordInput value={key} onChange={(e) => setKey(e.target.value)} placeholder={masked || 'sk-...'} />
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                void api.saveAiSettings(key).then((s) => {
                  setConfigured(s.configured)
                  setMasked(s.masked)
                  setKey('')
                })
              }
            >
              {t('ai.saveKey')}
            </Button>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
            {(['query', 'analyze'] as const).map((value) => (
              <Button
                key={value}
                variant={mode === value ? 'default' : 'outline'}
                size="sm"
                onClick={() => patchSession({ mode: value })}
              >
                {t(`ai.mode.${value}`)}
              </Button>
            ))}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-4">
              {!items.length && !busy ? (
                <p className="font-mono text-xs text-muted-foreground">{t('ai.empty')}</p>
              ) : null}
              {items.map((item, index) => (
                <div
                  key={index}
                  className={cn(
                    'border px-3 py-2',
                    item.role === 'user' ? 'border-border' : 'border-primary/30 bg-accent/20',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] tracking-widest text-muted-foreground">
                    <span>{item.role === 'user' ? t('ai.you') : 'AI'}</span>
                    {item.model ? <span className="text-primary">{item.model}</span> : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{item.text}</p>
                  {item.warnings?.length ? (
                    <div className="mt-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5">
                      <div className="font-mono text-[10px] tracking-widest text-destructive">{t('ai.warnings')}</div>
                      <ul className="mt-1 list-disc pl-4 font-mono text-[10px] text-destructive">
                        {item.warnings.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <SqlBlock sql={item.sql || []} fallbackDb={defaultDb} onOpenSql={onOpenSql} t={t} />
                  {item.notes?.length ? (
                    <ul className="mt-2 list-disc pl-4 font-mono text-[10px] text-muted-foreground">
                      {item.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
              {busy ? (
                <div className="border border-primary/30 bg-accent/10 px-3 py-2 font-mono text-xs text-primary">
                  {t('ai.working')}
                </div>
              ) : null}
            </div>
          </ScrollArea>
          {mode === 'analyze' ? (
            <textarea
              value={sql}
              onChange={(e) => patchSession({ sql: e.target.value })}
              placeholder={t('ai.pasteSql')}
              className="h-24 shrink-0 resize-none border-t border-border bg-background/40 p-3 font-mono text-xs outline-none"
            />
          ) : null}
          <div className="flex shrink-0 gap-2 border-t border-border p-3">
            <AiMentionInput
              value={message}
              onChange={(value) => patchSession({ message: value })}
              catalog={catalog}
              context={panelContext.length ? panelContext : undefined}
              databases={selected}
              placeholder={t('ai.placeholder')}
              disabled={busy || !selected.length}
              onSubmit={() => {
                if (!busy && selected.length) void ask()
              }}
            />
            <Button disabled={busy || !selected.length} onClick={() => void ask()}>
              {busy ? t('ai.working') : t('ai.send')}
            </Button>
          </div>
          <p className="border-t border-border px-3 pb-2 font-mono text-[10px] text-muted-foreground">{t('ai.mentionHint')}</p>
        </div>

        {showPanel ? (
          <aside className="flex max-h-[42vh] w-full shrink-0 flex-col border-t border-border xl:max-h-none xl:w-80 xl:border-t-0 xl:border-l">
            <div className="border-b border-border px-3 py-2 font-mono text-[10px] tracking-widest text-muted-foreground">
              {t('ai.catalog')}
            </div>
            <div className="space-y-2 border-b border-border px-3 py-2">
              <p className="font-mono text-[11px] text-foreground">
                {catalogBusy
                  ? t('common.loading')
                  : t('ai.catalogSummary', { n: catalog.length, d: selected.length })}
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">{t('ai.catalogHint')}</p>
              {mentionTables.length ? (
                <Button variant="outline" size="sm" disabled={detailBusy} onClick={() => void loadDetailContext()}>
                  {detailBusy ? t('common.loading') : t('ai.loadContext')}
                </Button>
              ) : null}
            </div>
            {showProcess ? (
              <>
                <div className="border-b border-border px-3 py-2 font-mono text-[10px] tracking-widest text-muted-foreground">
                  {t('ai.process')}
                </div>
                <ScrollArea className="max-h-36 shrink-0 border-b border-border px-3 py-2">
                  <ProcessSteps steps={panelSteps} busy={busy || detailBusy} t={t} />
                </ScrollArea>
              </>
            ) : null}
            <div className="border-b border-border px-3 py-2 font-mono text-[10px] tracking-widest text-muted-foreground">
              {t('ai.contextDetail')}
            </div>
            <ScrollArea className="min-h-0 flex-1 px-3 py-2">
              {panelContext.length ? (
                <ContextTree
                  context={panelContext}
                  usedObjects={lastAi?.used_objects}
                  loading={detailBusy}
                  t={t}
                />
              ) : (
                <p className="font-mono text-[10px] text-muted-foreground">{t('ai.contextIdle')}</p>
              )}
            </ScrollArea>
          </aside>
        ) : null}
      </div>
    </section>
  )
}
