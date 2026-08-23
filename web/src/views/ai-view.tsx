import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type AiReply, type DatabaseRow } from '@/lib/api'
import { useLocale } from '@/lib/i18n'

type Mode = 'query' | 'analyze' | 'join' | 'scan'

type ChatItem = {
  role: 'user' | 'ai'
  text: string
  sql?: string[]
  notes?: string[]
  scanned?: AiReply['scanned']
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
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [key, setKey] = useState('')
  const [masked, setMasked] = useState('')
  const [configured, setConfigured] = useState(false)

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

  const toggleDb = (name: string) => {
    setSelected((cur) => (cur.includes(name) ? cur.filter((item) => item !== name) : [...cur, name]))
  }

  const ask = async () => {
    setBusy(true)
    setError(null)
    const prompt = mode === 'scan' ? message || t('ai.scanDefault') : message
    if (mode !== 'scan') setItems((cur) => [...cur, { role: 'user', text: prompt }])
    else setItems((cur) => [...cur, { role: 'user', text: t('ai.scanStart') }])
    try {
      const reply = await api.aiAsk({
        mode,
        message: prompt,
        databases: selected,
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
          scanned: reply.scanned,
        },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.apiUnreachable'))
    } finally {
      setBusy(false)
      setMessage('')
    }
  }

  const dbForSql = selected[0] || 'master'

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <Sparkles className="size-4 text-primary" />
        <div className="font-mono text-xs tracking-widest text-primary">AI</div>
        <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">{t('ai.hint')}</span>
        <div className="ml-auto font-mono text-[10px] text-muted-foreground">
          {configured ? masked : t('ai.noKey')}
        </div>
      </div>
      {error ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex max-h-[40vh] w-full shrink-0 flex-col border-b border-border lg:max-h-none lg:w-64 lg:border-r lg:border-b-0">
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
            {(['query', 'analyze', 'join', 'scan'] as const).map((value) => (
              <Button key={value} variant={mode === value ? 'default' : 'outline'} size="sm" onClick={() => setMode(value)}>
                {t(`ai.mode.${value}`)}
              </Button>
            ))}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-4">
              {!items.length ? (
                <p className="font-mono text-xs text-muted-foreground">{t('ai.empty')}</p>
              ) : null}
              {items.map((item, index) => (
                <div key={index} className={item.role === 'user' ? 'border border-border px-3 py-2' : 'border border-primary/30 bg-accent/20 px-3 py-2'}>
                  <div className="font-mono text-[10px] tracking-widest text-muted-foreground">
                    {item.role === 'user' ? t('ai.you') : 'AI'}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{item.text}</p>
                  {item.scanned?.length ? (
                    <div className="mt-2 font-mono text-[10px] text-muted-foreground">
                      {item.scanned.map((db) => (
                        <div key={db.database}>
                          {db.database}: {db.tables} {t('ai.objects')}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {item.sql?.map((block, i) => (
                    <div key={i} className="mt-2 border border-border bg-background/60">
                      <pre className="max-h-56 overflow-auto p-2 font-mono text-[11px]">{block}</pre>
                      <div className="border-t border-border px-2 py-1">
                        <Button variant="outline" size="sm" onClick={() => onOpenSql(block, dbForSql)}>
                          {t('browse.openSql')}
                        </Button>
                      </div>
                    </div>
                  ))}
                  {item.notes?.length ? (
                    <ul className="mt-2 list-disc pl-4 font-mono text-[10px] text-muted-foreground">
                      {item.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
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
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={mode === 'scan' ? t('ai.scanPlaceholder') : t('ai.placeholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (!busy) void ask()
                }
              }}
            />
            <Button disabled={busy || !selected.length} onClick={() => void ask()}>
              {busy ? t('ai.working') : mode === 'scan' ? t('ai.scan') : t('ai.send')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
