import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useLocale } from '@/lib/i18n'

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const { t } = useLocale()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-background/70 p-0 sm:items-center sm:p-4"
      onMouseDown={onClose}
    >
      <div
        className={
          wide
            ? 'flex max-h-[92vh] w-full max-w-2xl flex-col border border-border bg-card shadow-lg sm:max-h-[90vh]'
            : 'flex max-h-[92vh] w-full max-w-md flex-col border border-border bg-card shadow-lg sm:max-h-[90vh]'
        }
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
          <div className="font-mono text-xs tracking-widest text-primary">{title}</div>
          <Button variant="ghost" size="icon" className="ml-auto" onClick={onClose} aria-label={t('common.close')}>
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? (
          <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border px-4 py-2 sm:flex-row sm:items-center sm:justify-end">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
