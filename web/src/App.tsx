import {
  Database,
  FileDown,
  HelpCircle,
  LogOut,
  Moon,
  RefreshCw,
  Server,
  Sun,
  Terminal,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { LocaleSelect } from '@/components/locale-select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { api, setCsrf, type Connection, type Session } from '@/lib/api'
import { useLocale } from '@/lib/i18n'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { BrowseView } from '@/views/browse-view'
import { ConnectView } from '@/views/connect-view'
import { JobsView } from '@/views/jobs-view'
import { ServerView } from '@/views/server-view'
import { SqlView } from '@/views/sql-view'

type View = 'browse' | 'sql' | 'jobs' | 'server'

export default function App() {
  const { t } = useLocale()
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<Session | null>(null)

  const boot = useCallback(async () => {
    try {
      const meta = await api.meta()
      setCsrf(meta.csrf_token)
      const current = await api.session()
      if (current.csrf_token) setCsrf(current.csrf_token)
      setSession(current.connected ? current : null)
    } catch {
      setSession(null)
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-primary">
        {t('boot.checking')}
      </div>
    )
  }

  if (!session?.connected) {
    return (
      <TooltipProvider>
        <ConnectView
          onAuthed={() => {
            setReady(false)
            void boot()
          }}
        />
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <Console
        session={session}
        onReload={() => void boot()}
        onLogout={() => {
          void api.disconnect(undefined, false).then(() => {
            setSession(null)
          })
        }}
        onSession={setSession}
      />
    </TooltipProvider>
  )
}

function Console({
  session,
  onReload,
  onLogout,
  onSession,
}: {
  session: Session
  onReload: () => void
  onLogout: () => void
  onSession: (session: Session | null) => void
}) {
  const { t } = useLocale()
  const { theme, toggle } = useTheme()
  const [view, setView] = useState<View>('browse')
  const [help, setHelp] = useState(false)
  const [status, setStatus] = useState(t('footer.ready'))
  const [sqlSeed, setSqlSeed] = useState<{ sql: string; db: string } | null>(null)
  const [jobTick, setJobTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const connections = session.connections || []
  const active = session.connection

  return (
    <div className="corner-frame flex h-full flex-col bg-background/85 text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card/90 px-3 sm:gap-3 sm:px-4">
        <Terminal className="size-4 shrink-0 text-primary" />
        <div className="title-glitch shrink-0 text-sm text-primary">SQLSM</div>
        <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">
          {t('common.adminConsole')}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
          {connections.length > 1 ? (
            <select
              className="hidden max-w-48 truncate border border-border bg-background/70 px-2 py-1 font-mono text-[11px] sm:block"
              value={session.connection_id}
              onChange={(e) => {
                void api.switchConnection(e.target.value).then((next) => onSession({ ...session, ...next, connected: true }))
              }}
            >
              {connections.map((c: Connection) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <Badge variant="live" className="hidden max-w-52 truncate lg:inline-flex">
              {active?.label}
            </Badge>
          )}
          <LocaleSelect className="hidden w-36 sm:block" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  setLoading(true)
                  onReload()
                  setJobTick((n) => n + 1)
                  setLoading(false)
                }}
              >
                <RefreshCw className={cn(loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('common.reload')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" onClick={() => setHelp(true)}>
                <HelpCircle />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('help.open')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" onClick={toggle}>
                {theme === 'dark' ? <Sun /> : <Moon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{theme === 'dark' ? t('common.themeLight') : t('common.themeDark')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" onClick={onLogout}>
                <LogOut />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('common.logout')}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <aside className="flex shrink-0 flex-row overflow-x-auto border-b border-border bg-card/60 md:w-56 md:flex-col md:overflow-visible md:border-r md:border-b-0">
          <div className="hidden px-3 py-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground md:block">
            {t('nav.modules')}
          </div>
          <NavBtn active={view === 'browse'} onClick={() => setView('browse')} icon={Database} label={t('nav.browse')} />
          <NavBtn active={view === 'sql'} onClick={() => setView('sql')} icon={Terminal} label={t('nav.sql')} />
          <NavBtn active={view === 'jobs'} onClick={() => setView('jobs')} icon={FileDown} label={t('nav.jobs')} />
          <NavBtn active={view === 'server'} onClick={() => setView('server')} icon={Server} label={t('nav.server')} />
          <Separator className="my-2 hidden md:block" />
          <div className="hidden px-3 py-1 font-mono text-[10px] tracking-[0.2em] text-muted-foreground md:block">
            {t('nav.session')}
          </div>
          <div className="hidden truncate px-3 py-1.5 font-mono text-[11px] text-primary md:block">
            {active?.display_server || active?.server}
          </div>
          <div className="hidden px-3 font-mono text-[10px] text-muted-foreground md:block">{t('nav.connected')}</div>
        </aside>

        {view === 'browse' ? (
          <BrowseView
            onOpenSql={(sql, database) => {
              setSqlSeed({ sql, db: database })
              setView('sql')
            }}
            onStatus={setStatus}
          />
        ) : view === 'sql' ? (
          <SqlView initialSql={sqlSeed?.sql} initialDb={sqlSeed?.db} />
        ) : view === 'jobs' ? (
          <JobsView tick={jobTick} />
        ) : (
          <ServerView tick={jobTick} />
        )}
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-card/90 px-3 font-mono text-[10px] text-muted-foreground sm:px-4">
        <span>127.0.0.1</span>
        <span className="ml-auto truncate">{status}</span>
      </footer>
      <Dialog
        open={help}
        title={t('help.title')}
        onClose={() => setHelp(false)}
        footer={
          <Button variant="outline" onClick={() => setHelp(false)}>
            {t('common.close')}
          </Button>
        }
      >
        <p className="font-mono text-xs text-muted-foreground">{t('help.body')}</p>
      </Dialog>
    </div>
  )
}

function NavBtn({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Database
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'mx-1 my-1 flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11px] hover:bg-accent md:mx-2 md:my-0 md:mb-0.5',
        active && 'bg-accent text-primary',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  )
}
