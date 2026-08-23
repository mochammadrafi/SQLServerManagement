import { Moon, Sun, Terminal } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Controller, useForm, type DefaultValues } from 'react-hook-form'
import { LocaleSelect } from '@/components/locale-select'
import { Button } from '@/components/ui/button'
import { DynamicSelect } from '@/components/ui/dynamic-select'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { api, setCsrf, type Meta, type Profile } from '@/lib/api'
import { useLocale } from '@/lib/i18n'
import { useTheme } from '@/lib/theme'

type ConnectForm = {
  server: string
  port: string
  instance: string
  auth: 'sql' | 'windows'
  username: string
  password: string
  database: string
  encrypt: boolean
  remember_password: boolean
}

type ConnectPayload = Omit<ConnectForm, 'port'> & { port: number }

const DEFAULTS: DefaultValues<ConnectForm> = {
  server: 'localhost',
  port: '1433',
  instance: '',
  auth: 'sql',
  username: 'sa',
  password: '',
  database: 'master',
  encrypt: false,
  remember_password: false,
}

function profileValues(profile: Profile): ConnectForm {
  return {
    server: profile.server,
    port: String(profile.port || 1433),
    instance: profile.instance || '',
    auth: profile.auth === 'windows' ? 'windows' : 'sql',
    username: profile.username || 'sa',
    password: '',
    database: profile.database || 'master',
    encrypt: profile.encrypt,
    remember_password: profile.remember_password,
  }
}

function parsePort(raw: string | number | undefined): number {
  const text = String(raw ?? '').trim()
  if (!text) return 1433
  const port = Number.parseInt(text, 10)
  return Number.isFinite(port) ? port : 1433
}

function normalizeValues(raw: ConnectForm): ConnectPayload {
  return {
    ...raw,
    server: raw.server.trim(),
    database: raw.database.trim() || 'master',
    port: parsePort(raw.port),
    auth: raw.auth === 'windows' ? 'windows' : 'sql',
  }
}

export function ConnectView({
  onAuthed,
  onCancel,
}: {
  onAuthed: () => void
  onCancel?: () => void
}) {
  const { t } = useLocale()
  const { theme, toggle } = useTheme()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [profileId, setProfileId] = useState('')
  const {
    register,
    control,
    reset,
    setValue,
    getValues,
    setError: setFieldError,
    clearErrors,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ConnectForm>({
    defaultValues: DEFAULTS,
    shouldUnregister: false,
  })
  const auth = watch('auth')

  useEffect(() => {
    void api
      .meta()
      .then((data) => {
        setCsrf(data.csrf_token)
        setMeta(data)
        if (!data.windows) setValue('auth', 'sql')
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('error.apiUnreachable')))
  }, [setValue, t])

  const fill = (profile: Profile) => {
    setProfileId(profile.id)
    reset(profileValues(profile))
    clearErrors()
  }

  const connectNow = async (values: ConnectPayload, id?: string) => {
    setError(null)
    try {
      const result = await api.connect({ ...values, profile_id: id || '' })
      if (result.csrf_token) setCsrf(result.csrf_token)
      onAuthed()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('connect.failed'))
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    clearErrors()
    setError(null)

    const raw = getValues()
    const values = normalizeValues(raw)
    let blocked = false

    if (!values.server) {
      setFieldError('server', { type: 'required', message: t('validation.required') })
      blocked = true
    }
    if (!values.database) {
      setFieldError('database', { type: 'required', message: t('validation.required') })
      blocked = true
    }
    if (values.port < 1 || values.port > 65535) {
      setFieldError('port', { type: 'validate', message: t('validation.invalid') })
      blocked = true
    }
    if (blocked) return

    await connectNow(values, profileId)
  }

  return (
    <div className="corner-frame flex h-full flex-col bg-background/85 text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card/90 px-4">
        <Terminal className="size-4 text-primary" />
        <div className="title-glitch text-sm text-primary">SQLSM</div>
        <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
          {t('common.adminConsole')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {onCancel ? (
            <Button variant="outline" size="sm" type="button" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          ) : null}
          <LocaleSelect className="w-36" />
          <Button variant="outline" size="icon" onClick={toggle} aria-label={t('common.themeDark')}>
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 sm:p-6">
        <form onSubmit={(e) => void submit(e)} className="w-full max-w-md border border-border bg-card/80 p-4 sm:p-5">
          <div className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground">{t('common.auth')}</div>
          <div className="mt-1 text-sm text-primary">{t('connect.subtitle')}</div>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">{t('connect.help')}</p>
          {error ? (
            <div className="mt-3 border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {meta?.profiles.length ? (
            <div className="mt-3 space-y-1">
              <div className="font-mono text-[10px] text-muted-foreground">{t('connect.profiles')}</div>
              {meta.profiles.map((profile) => (
                <div key={profile.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate border border-border px-2 py-1 text-left font-mono text-[11px] hover:bg-accent/40"
                    onClick={() => {
                      fill(profile)
                      if (profile.auth === 'windows' || profile.has_password) {
                        void connectNow(normalizeValues(profileValues(profile)), profile.id)
                      }
                    }}
                  >
                    {profile.label}
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void api.deleteProfile(profile.id).then((r) =>
                        setMeta((m) => (m ? { ...m, profiles: r.profiles } : m)),
                      )
                    }
                  >
                    {t('connect.delete')}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-3 grid grid-cols-[1fr_6rem] gap-2">
            <div>
              <div className="font-mono text-[10px] text-muted-foreground">{t('connect.server')}</div>
              <Input className="mt-1" autoComplete="off" {...register('server')} />
              <FieldError message={errors.server?.message} />
            </div>
            <div>
              <div className="font-mono text-[10px] text-muted-foreground">{t('connect.port')}</div>
              <Input className="mt-1" inputMode="numeric" autoComplete="off" {...register('port')} />
              <FieldError message={errors.port?.message} />
            </div>
          </div>
          <div className="mt-3">
            <div className="font-mono text-[10px] text-muted-foreground">{t('connect.instance')}</div>
            <Input className="mt-1" placeholder="SQLEXPRESS" autoComplete="off" {...register('instance')} />
          </div>
          <div className="mt-3">
            <div className="font-mono text-[10px] text-muted-foreground">{t('connect.authMode')}</div>
            <Controller
              name="auth"
              control={control}
              render={({ field }) => (
                <DynamicSelect
                  className="mt-1"
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { value: 'sql', label: t('connect.sql') },
                    { value: 'windows', label: t('connect.windows') },
                  ]}
                  disabled={meta != null && !meta.windows}
                />
              )}
            />
          </div>
          {auth === 'sql' ? (
            <>
              <div className="mt-3">
                <div className="font-mono text-[10px] text-muted-foreground">{t('connect.username')}</div>
                <Input className="mt-1" autoComplete="username" {...register('username')} />
              </div>
              <div className="mt-3">
                <div className="font-mono text-[10px] text-muted-foreground">{t('common.password')}</div>
                <PasswordInput className="mt-1" autoComplete="current-password" {...register('password')} />
              </div>
              <label className="mt-2 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <input type="checkbox" {...register('remember_password')} />
                {t('connect.remember')}
              </label>
            </>
          ) : null}
          <div className="mt-3">
            <div className="font-mono text-[10px] text-muted-foreground">{t('connect.database')}</div>
            <Input className="mt-1" autoComplete="off" {...register('database')} />
            <FieldError message={errors.database?.message} />
          </div>
          <label className="mt-2 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <input type="checkbox" {...register('encrypt')} />
            {t('connect.encrypt')}
          </label>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            {meta && !meta.windows
              ? t('connect.windowsOnly')
              : meta?.preferred_driver
                ? t('connect.driver', { name: meta.preferred_driver })
                : t('connect.noDriver')}
          </p>
          <Button type="submit" className="mt-4 w-full" disabled={isSubmitting}>
            {isSubmitting ? t('connect.checking') : t('connect.submit')}
          </Button>
        </form>
      </div>
      <footer className="flex h-7 shrink-0 items-center border-t border-border bg-card/90 px-4 font-mono text-[10px] text-muted-foreground">
        127.0.0.1
      </footer>
    </div>
  )
}
