import { Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DataGrid } from '@/components/data-grid'
import { useLocale } from '@/lib/i18n'
import { api } from '@/lib/api'

export function ServerView({ active, tick }: { active?: boolean; tick: number }) {
  const { t } = useLocale()
  const [info, setInfo] = useState<Record<string, unknown> | null>(null)
  const [sessions, setSessions] = useState<Record<string, unknown>[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!active) return
    setLoading(true)
    void api
      .server()
      .then((r) => {
        setInfo(r.server)
        setSessions(r.sessions || [])
        setError(r.sessions_error || null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('error.apiUnreachable')))
      .finally(() => setLoading(false))
  }, [active, tick, t])

  const keys = info ? Object.keys(info) : []

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <Server className="size-4 text-primary" />
        <div className="font-mono text-xs tracking-widest text-primary">{t('nav.server').toUpperCase()}</div>
        <span className="font-mono text-[10px] text-muted-foreground">{t('server.hint')}</span>
      </div>
      {loading ? (
        <div className="p-5 font-mono text-xs text-primary">{t('server.loading')}</div>
      ) : (
        <>
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1 border-b border-border px-4 py-3 font-mono text-[11px] text-muted-foreground">
            {keys.map((key) => (
              <div key={key} className="contents">
                <span>{key}</span>
                <span className="break-all text-foreground">{String(info?.[key] ?? '—')}</span>
              </div>
            ))}
          </div>
          {error ? <div className="px-4 py-2 font-mono text-xs text-destructive">{error}</div> : null}
          <div className="px-4 py-2 font-mono text-[10px] tracking-widest text-muted-foreground">
            {t('server.sessions')}
          </div>
          <DataGrid
            columns={sessions[0] ? Object.keys(sessions[0]) : []}
            rows={sessions}
          />
        </>
      )}
    </section>
  )
}
