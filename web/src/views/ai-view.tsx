import { Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AiMentionInput } from '@/components/ai-mention-input'
import { ContextTree, SqlBlock } from '@/components/ai-context-tree'
import { Button } from '@/components/ui/button'
import { PasswordInput } from '@/components/ui/password-input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { parseMentionTables } from '@/lib/ai-mentions'
import {
  api,
  type AiContextDb,
  type AiStep,
  type DatabaseRow,
} from '@/lib/api'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'

type Mode = 'query' | 'analyze'

type ChatItem = {
  role: 'user' | 'ai'
  text: string
  sql?: string[]
  notes?: string[]
  warnings?: string[]
  used_objects?: string[]
  context?: AiContextDb[]
  steps?: AiStep[]
  model?: string
}

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
  onOpenSql,
}: {
  onOpenSql: (sql: string, database: string) => void
}) {
  const { t } = useLocale()
  const [databases, setDatabases] = useState<DatabaseRow[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [mode, setMode] = useState<Mode>('query')
  const [message, setMessage] = useState('')
  const [sql, setSql] = useState('')
  const [samples, setSamples] = useState(true)
  const [busy, setBusy] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [preview, setPreview] = useState<AiContextDb[]>([])
  const [previewSteps, setPreviewSteps] = useState<AiStep[]>([])
  const [key, setKey] = useState('')
  const [masked, setMasked] = useState('')
  const [configured, setConfigured] = useState(false)
  const [showPanel, setShowPanel] = useState(true)

  const lastAi = useMemo(() => [...items].reverse().find((item) => item.role === 'ai'), [items])
  const panelContext = lastAi?.context || preview
  const panelSteps = busy ? undefined : lastAi?.steps || previewSteps
  const defaultDb = selected[0] || 'master'

  const mentionTables = useMemo(
    () => parseMentionTables(message, defaultDb),
    [message, defaultDb],
  )

  const loadPreview = useCallback(async () => {
    if (!selected.length) {
      setPreview([])
      setPreviewSteps([])
      return
    }
    setPreviewBusy(true)
    try {
      const result = await api.aiContext({
        databases: selected,
        tables: mentionTables,
        message,
        include_samples: samples,
      })
      setPreview(result.context)
      setPreviewSteps(result.steps)
    } catch {
      setPreview([])
      setPreviewSteps([])
    } finally {
      setPreviewBusy(false)
    }
  }, [selected, mentionTables, message, samples])

  useEffect(() => {
    void api.databases().then((r) => {
      const user = r.databases.filter((db) => !db.is_system)
      setDatabases(user)
      setSelected(user.slice(0, 1).map((db) => db.name))
    })
    void api.aiSettings().then((s) => {
      setConfigured(s.configured)
      setMasked(s.masked)
    })
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPreview()
    }, 350)
    return () => window.clearTimeout(timer)
  }, [loadPreview])

  const toggleDb = (name: string) => {
    setSelected((cur) => (cur.includes(name) ? cur.filter((item) => item !== name) : [...cur, name]))
  }

  const ask = async () => {
    setBusy(true)
    setError(null)
    const prompt = message.trim()
    if (mode === 'query') setItems((cur) => [...cur, { role: 'user', text: prompt }])
    else setItems((cur) => [...cur, { role: 'user', text: prompt || t('ai.pasteSql') }])
    try {
      const reply = await api.aiAsk({
        mode,
        message: prompt,
        databases: selected,
        tables: mentionTables,
        include_samples: samples,
        sql: mode === 'analyze' ? sql : undefined,
      })
      setItems((cur) => [
        ...cur,
        {
          role: 'ai',
          text: reply.explanation,
          sql: reply.sql,
          notes: reply.notes,
          warnings: reply.warnings,
          used_objects: reply.used_objects,
          context: reply.context,
          steps: reply.steps,
          model: reply.model,
        },
      ])
      if (reply.context) {
        setPreview(reply.context)
        setPreviewSteps(reply.steps || [])
      }
      setShowPanel(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.apiUnreachable'))
    } finally {
      setBusy(false)
      if (mode === 'query') setMessage('')
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
          onClick={() => setShowPanel((value) => !value)}
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
          <div className="border-b border-border px-3 py-2 font-mono text-[10px] tracking-widest text-muted-foreground">
            {t('ai.scope')}
          </div>
          <div className="flex flex-wrap gap-1 px-3 py-2">
            <Button variant="outline" size="sm" onClick={() => setSelected(databases.map((db) => db.name))}>
              {t('ai.allDb')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSelected(databases.slice(0, 1).map((db) => db.name))}>
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
            <input type="checkbox" checked={samples} onChange={(e) => setSamples(e.target.checked)} />
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
              <Button key={value} variant={mode === value ? 'default' : 'outline'} size="sm" onClick={() => setMode(value)}>
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
              onChange={(e) => setSql(e.target.value)}
              placeholder={t('ai.pasteSql')}
              className="h-24 shrink-0 resize-none border-t border-border bg-background/40 p-3 font-mono text-xs outline-none"
            />
          ) : null}
          <div className="flex shrink-0 gap-2 border-t border-border p-3">
            <AiMentionInput
              value={message}
              onChange={setMessage}
              context={preview}
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
              {t('ai.preview')}
            </div>
            <ScrollArea className="max-h-40 shrink-0 border-b border-border px-3 py-2 xl:max-h-48">
              <ProcessSteps steps={panelSteps} busy={busy || previewBusy} t={t} />
            </ScrollArea>
            <ScrollArea className="min-h-0 flex-1 px-3 py-2">
              <ContextTree
                context={panelContext}
                usedObjects={lastAi?.used_objects}
                loading={previewBusy && !panelContext.length}
                t={t}
              />
            </ScrollArea>
          </aside>
        ) : null}
      </div>
    </section>
  )
}
