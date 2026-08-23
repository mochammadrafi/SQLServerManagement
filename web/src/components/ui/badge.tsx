import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-sm border px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider',
  {
    variants: {
      variant: {
        default: 'border-primary/40 bg-primary/10 text-primary',
        muted: 'border-border bg-muted text-muted-foreground',
        warn: 'border-warn/40 bg-warn/10 text-warn',
        cred: 'border-cred/40 bg-cred/10 text-cred',
        live: 'border-primary/50 bg-primary/15 text-primary',
        intel: 'border-intel/40 bg-intel/10 text-intel',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge }
