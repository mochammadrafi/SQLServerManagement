import { DynamicSelect } from '@/components/ui/dynamic-select'
import { LOCALE_OPTIONS, useLocale, type Locale } from '@/lib/i18n'

export function LocaleSelect({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale()
  return (
    <DynamicSelect
      className={className}
      value={locale}
      onChange={(value) => setLocale(value as Locale)}
      options={LOCALE_OPTIONS}
      placeholder={t('common.language')}
      searchPlaceholder={t('common.search')}
      emptyText={t('common.empty')}
    />
  )
}
