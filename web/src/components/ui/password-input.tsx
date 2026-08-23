import { Eye, EyeOff } from 'lucide-react'
import { forwardRef, useState, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const PasswordInput = forwardRef<HTMLInputElement, Omit<ComponentProps<'input'>, 'type'>>(
  function PasswordInput({ className, ...props }, ref) {
    const { t } = useLocale()
    const [show, setShow] = useState(false)

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={show ? 'text' : 'password'}
          className={cn('pr-9', className)}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? t('common.hidePassword') : t('common.showPassword')}
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </div>
    )
  },
)

export { PasswordInput }
