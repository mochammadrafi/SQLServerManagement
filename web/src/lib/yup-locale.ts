import { useEffect } from 'react'
import type { FieldValues, UseFormTrigger } from 'react-hook-form'
import { useLocale } from '@/lib/i18n'

export function useRevalidateOnLocale<T extends FieldValues>(
  trigger: UseFormTrigger<T>,
  isSubmitted: boolean,
) {
  const { locale } = useLocale()
  useEffect(() => {
    if (isSubmitted) void trigger()
  }, [locale, isSubmitted, trigger])
}
