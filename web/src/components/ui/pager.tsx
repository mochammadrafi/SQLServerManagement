import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLocale } from '@/lib/i18n'

export const PAGE_SIZE = 20

export function Pager({
  page,
  pageSize = PAGE_SIZE,
  total,
  onPage,
}: {
  page: number
  pageSize?: number
  total: number
  onPage: (page: number) => void
}) {
  const { t } = useLocale()
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-3 sm:px-4">
      <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
        {from}–{to} / {total}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="outline" disabled={page <= 0} onClick={() => onPage(page - 1)} aria-label="Sebelumnya">
          <ChevronLeft />
          <span className="hidden sm:inline">{t('common.prev')}</span>
        </Button>
        <Button
          variant="outline"
          disabled={page >= pages - 1}
          onClick={() => onPage(page + 1)}
          aria-label="Berikutnya"
        >
          <span className="hidden sm:inline">{t('common.next')}</span>
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
