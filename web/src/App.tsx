import {
  Database,
  FileDown,
  HelpCircle,
  LogOut,
  Moon,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Sun,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { LocaleSelect } from '@/components/locale-select'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { api, setCsrf, type Connection, type Session } from '@/lib/api'
import { useLocale } from '@/lib/i18n'
import { createDefaultShell, normalizeAiState, openSqlInShell, patchAiState, type ShellState } from '@/lib/shell-state'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { BrowseView } from '@/views/browse-view'
import { ConnectView } from '@/views/connect-view'
import { JobsView } from '@/views/jobs-view'
import { AiView } from '@/views/ai-view'
import { ServerView } from '@/views/server-view'
import { SqlView } from '@/views/sql-view'

export default function App() {
  const { t } = useLocale()
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [adding, setAdding] = useState(false)

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

  if (!session?.connected || adding) {
    return (
      <TooltipProvider>
        <ConnectView
          onAuthed={() => {
            setAdding(false)
            setReady(false)
            void boot()
          }}
          onCancel={session?.connected ? () => setAdding(false) : undefined}
        />
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <Console
        session={session}
        onReload={boot}
        onAdd={() => setAdding(true)}
        onLogout={() => {
          void api.disconnect(undefined, true).then((next) => {
            setSession(next.connected ? { ...next, connected: true } : null)
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
  onAdd,
  onLogout,
  onSession,
}: {
  session: Session
  onReload: () => Promise<void>
  onAdd: () => void
  onLogout: () => void
  onSession: (session: Session | null) => void
}) {
  const { t } = useLocale()
  const { theme, toggle } = useTheme()
  const [help, setHelp] = useState(false)
  const [status, setStatus] = useState(t('footer.ready'))
  const [jobTick, setJobTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const [shellByConn, setShellByConn] = useState<Record<string, ShellState>>({})

  const connections = session.connections || []
  const connId = session.connection_id || connections[0]?.id || 'none'
  const active = session.connection
  const shell = useMemo(() => {
    const raw = shellByConn[connId] || createDefaultShell()
    return { ...raw, ai: normalizeAiState(raw.ai) }
  }, [connId, shellByConn])

  useEffect(() => {
    setShellByConn((prev) => {
      const next = { ...prev }
      for (const conn of connections) {
        if (!next[conn.id]) {
          next[conn.id] = createDefaultShell()
        } else {
          next[conn.id] = { ...next[conn.id], ai: normalizeAiState(next[conn.id].ai) }
        }
      }
      for (const id of Object.keys(next)) {
        if (!connections.some((conn) => conn.id === id)) delete next[id]
      }
      return next
    })
  }, [connections])

  const patchShell = useCallback((patch: ShellState | ((current: ShellState) => ShellState)) => {
    setShellByConn((prev) => {
      const current = prev[connId] || createDefaultShell()
      const nextShell = typeof patch === 'function' ? patch(current) : patch
      return { ...prev, [connId]: nextShell }
    })
  }, [connId])

  const patchAi = useCallback((patch: Parameters<typeof patchAiState>[1]) => {
    patchShell((shell) => patchAiState(shell, patch))
  }, [patchShell])

  const setView = (view: ShellState['view']) => {
    patchShell((current) => ({ ...current, view }))
  }

  const openSql = (sql: string, database: string) => {
    patchShell((current) => openSqlInShell(current, sql, database))
  }

  const switchConn = (id: string) => {
    if (id === connId) return
    void api.switchConnection(id).then((next) => onSession({ ...session, ...next, connected: true }))
  }

  const closeConn = (id: string) => {
    void api.disconnect(id, false).then((next) => {
      if (!next.connected) {
        onSession(null)
        return
      }
      onSession({ ...session, ...next, connected: true })
    })
  }

  const view = shell.view

  return (
    <div className="corner-frame flex h-full flex-col bg-background/85 text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card/90 px-3 sm:gap-3 sm:px-4">
        <Terminal className="size-4 shrink-0 text-primary" />
        <div className="title-glitch shrink-0 text-sm text-primary">SQLSM</div>
        <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">
          {t('common.adminConsole')}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Button variant="outline" size="sm" className="hidden sm:inline-flex" onClick={onAdd}>
            <Plus />
            {t('connect.new')}
          </Button>
          <LocaleSelect className="hidden w-36 sm:block" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  setLoading(true)
                  setJobTick((n) => n + 1)
                  void onReload().finally(() => setLoading(false))
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

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card/70 px-2 py-1">
        {connections.map((conn: Connection) => (
          <div
            key={conn.id}
            className={cn(
              'flex max-w-[240px] shrink-0 items-center gap-1 rounded border px-2 py-1 font-mono text-[10px]',
              conn.id === connId
                ? 'border-primary/40 bg-accent text-primary'
                : 'border-border bg-background/50 text-muted-foreground hover:bg-accent/40',
            )}
          >
            <button type="button" className="min-w-0 truncate" onClick={() => switchConn(conn.id)}>
              {conn.label}
            </button>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 hover:bg-background/80"
              aria-label={t('shell.closeConnection')}
              onClick={() => closeConn(conn.id)}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="shrink-0 sm:hidden" onClick={onAdd}>
          <Plus />
          {t('connect.new')}
        </Button>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <aside className="flex shrink-0 flex-row overflow-x-auto border-b border-border bg-card/60 md:w-56 md:flex-col md:overflow-visible md:border-r md:border-b-0">
          <div className="hidden px-3 py-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground md:block">
            {t('nav.modules')}
          </div>
          <NavBtn active={view === 'browse'} onClick={() => setView('browse')} icon={Database} label={t('nav.browse')} />
          <NavBtn active={view === 'sql'} onClick={() => setView('sql')} icon={Terminal} label={t('nav.sql')} />
          <NavBtn active={view === 'ai'} onClick={() => setView('ai')} icon={Sparkles} label={t('nav.ai')} />
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

        <div className={cn('min-h-0 min-w-0 flex-1', view === 'browse' ? 'flex' : 'hidden')}>
          <BrowseView key={`browse-${connId}`} active={view === 'browse'} onOpenSql={openSql} onStatus={setStatus} />
        </div>
        <div className={cn('min-h-0 min-w-0 flex-1', view === 'sql' ? 'flex' : 'hidden')}>
          <SqlView active={view === 'sql'} shell={shell} onShellChange={(next) => patchShell(next)} />
        </div>
        <div className={cn('min-h-0 min-w-0 flex-1', view === 'ai' ? 'flex' : 'hidden')}>
          <AiView
            active={view === 'ai'}
            connectionId={connId}
            ai={shell.ai}
            onAiChange={patchAi}
            onOpenSql={openSql}
          />
        </div>
        <div className={cn('min-h-0 min-w-0 flex-1', view === 'jobs' ? 'flex' : 'hidden')}>
          <JobsView key={`jobs-${connId}`} active={view === 'jobs'} tick={jobTick} />
        </div>
        <div className={cn('min-h-0 min-w-0 flex-1', view === 'server' ? 'flex' : 'hidden')}>
          <ServerView key={`server-${connId}`} active={view === 'server'} tick={jobTick} />
        </div>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-card/90 px-3 font-mono text-[10px] text-muted-foreground sm:px-4">
        <span>127.0.0.1</span>
        <span className="truncate">{active?.display_server || active?.server}</span>
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
