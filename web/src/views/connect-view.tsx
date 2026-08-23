import { yupResolver } from '@hookform/resolvers/yup'
import { Moon, Sun, Terminal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import * as yup from 'yup'
import { LocaleSelect } from '@/components/locale-select'
import { Button } from '@/components/ui/button'
import { DynamicSelect } from '@/components/ui/dynamic-select'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { api, setCsrf, type Meta, type Profile } from '@/lib/api'
import { useLocale } from '@/lib/i18n'
import { useTheme } from '@/lib/theme'
import { useRevalidateOnLocale } from '@/lib/yup-locale'

export function ConnectView({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useLocale()
  const { theme, toggle } = useTheme()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [profileId, setProfileId] = useState('')
  const schema = useMemo(
    () =>
      yup.object({
        server: yup.string().required(),
        port: yup.number().min(1).max(65535).required(),
        instance: yup.string(),
        auth: yup.string().oneOf(['sql', 'windows']).required(),
        username: yup.string(),
        password: yup.string(),
        database: yup.string().required(),
        encrypt: yup.boolean(),
        remember_password: yup.boolean(),
      }),
    [],
  )
  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    trigger,
    formState: { errors, isSubmitting, isSubmitted },
  } = useForm({
    resolver: yupResolver(schema),
    defaultValues: {
      server: 'localhost',
      port: 1433,
      instance: '',
      auth: 'sql',
      username: 'sa',
      password: '',
      database: 'master',
      encrypt: false,
      remember_password: false,
    },
  })
  useRevalidateOnLocale(trigger, isSubmitted)
  const auth = watch('auth')

  useEffect(() => {
    void api
      .meta()
      .then((data) => {
        setCsrf(data.csrf_token)
        setMeta(data)
        if (!data.windows) setValue('auth', 'sql')
        if (data.profiles[0]) fill(data.profiles[0])
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('error.apiUnreachable')))
  }, [setValue, t])

  const fill = (profile: Profile) => {
    setProfileId(profile.id)
    setValue('server', profile.server)
    setValue('port', profile.port)
    setValue('instance', profile.instance)
    setValue('auth', profile.auth === 'windows' ? 'windows' : 'sql')
    setValue('username', profile.username || 'sa')
    setValue('password', '')
    setValue('database', profile.database || 'master')
    setValue('encrypt', profile.encrypt)
    setValue('remember_password', profile.remember_password)
  }

  const submit = handleSubmit(async (values) => {
    setError(null)
    try {
      const result = await api.connect({ ...values, profile_id: profileId })
      if (result.csrf_token) setCsrf(result.csrf_token)
      onAuthed()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('connect.failed'))
    }
  })

  return (
    <div className="corner-frame flex h-full flex-col bg-background/85 text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card/90 px-4">
        <Terminal className="size-4 text-primary" />
        <div className="title-glitch text-sm text-primary">SQLSM</div>
        <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
          {t('common.adminConsole')}
        </span>
        <div className="ml-auto flex items-center gap-2">
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
                      if (profile.auth === 'windows' || profile.has_password) void submit()
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
              <Input className="mt-1" {...register('server')} />
              <FieldError message={errors.server?.message} />
            </div>
            <div>
              <div className="font-mono text-[10px] text-muted-foreground">{t('connect.port')}</div>
              <Input className="mt-1" {...register('port', { valueAsNumber: true })} />
              <FieldError message={errors.port?.message} />
            </div>
          </div>
          <div className="mt-3">
            <div className="font-mono text-[10px] text-muted-foreground">{t('connect.instance')}</div>
            <Input className="mt-1" placeholder="SQLEXPRESS" {...register('instance')} />
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
                <Input className="mt-1" {...register('username')} />
              </div>
              <div className="mt-3">
                <div className="font-mono text-[10px] text-muted-foreground">{t('common.password')}</div>
                <PasswordInput className="mt-1" {...register('password')} />
              </div>
              <label className="mt-2 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <input type="checkbox" {...register('remember_password')} />
                {t('connect.remember')}
              </label>
            </>
          ) : null}
          <div className="mt-3">
            <div className="font-mono text-[10px] text-muted-foreground">{t('connect.database')}</div>
            <Input className="mt-1" {...register('database')} />
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
