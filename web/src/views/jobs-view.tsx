import { Download, Pause, Play, Square, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type Job } from '@/lib/api'
import { useLocale } from '@/lib/i18n'
import { fmtBytes } from '@/lib/utils'

export function JobsView({ active, tick }: { active?: boolean; tick: number }) {
  const { t } = useLocale()
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)

  const load = () =>
    api
      .exports()
      .then((r) => setJobs(r.jobs))
      .finally(() => setLoading(false))

  useEffect(() => {
    if (!active) return
    void load()
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [active, tick])

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <div className="font-mono text-xs tracking-widest text-primary">{t('nav.jobs').toUpperCase()}</div>
        <span className="font-mono text-[10px] text-muted-foreground">{t('jobs.hint')}</span>
      </div>
      {loading ? (
        <div className="p-5 font-mono text-xs text-primary">{t('jobs.loading')}</div>
      ) : !jobs.length ? (
        <div className="p-5 font-mono text-xs text-muted-foreground">{t('jobs.empty')}</div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 p-3">
            {jobs.map((job) => (
              <article key={job.id} className="border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-mono text-xs text-primary">
                    {job.kind} · {job.schema ? `${job.schema}.` : ''}
                    {job.table}
                  </div>
                  <Badge variant={job.status === 'done' ? 'live' : job.status === 'error' ? 'warn' : 'intel'}>
                    {job.status}
                  </Badge>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {job.rows_written} rows · {fmtBytes(job.bytes_written)}
                  </span>
                </div>
                {job.current_object ? (
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{job.current_object}</div>
                ) : null}
                {job.error ? <div className="mt-1 font-mono text-[11px] text-destructive">{job.error}</div> : null}
                <div className="mt-2 flex flex-wrap gap-1">
                  {job.can_pause ? (
                    <Button variant="outline" size="sm" onClick={() => void api.pauseJob(job.id).then(() => load())}>
                      <Pause />
                      {t('jobs.pause')}
                    </Button>
                  ) : null}
                  {job.can_resume ? (
                    <Button variant="outline" size="sm" onClick={() => void api.resumeJob(job.id).then(() => load())}>
                      <Play />
                      {t('jobs.resume')}
                    </Button>
                  ) : null}
                  {job.can_cancel ? (
                    <Button variant="outline" size="sm" onClick={() => void api.cancelJob(job.id).then(() => load())}>
                      <Square />
                      {t('jobs.cancel')}
                    </Button>
                  ) : null}
                  {job.kind === 'export_db' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void api.skipJob(job.id, '', '').then(() => load())}
                    >
                      <Trash2 />
                      {t('jobs.skip')}
                    </Button>
                  ) : null}
                  {job.parts.map((part) => (
                    <Button key={part.name} variant="outline" size="sm" asChild>
                      <a href={api.partUrl(job.id, part.name)}>
                        <Download />
                        {part.name}
                      </a>
                    </Button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  )
}
