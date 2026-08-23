import { forwardRef, type ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>(function Input(
  { className, type, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-8 w-full rounded-md border border-input bg-background/70 px-2.5 text-xs font-mono shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/40',
        className,
      )}
      {...props}
    />
  )
})

export { Input }
