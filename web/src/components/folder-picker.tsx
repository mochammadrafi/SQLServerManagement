import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { useLocale } from '@/lib/i18n'

export function FolderPicker({
  open,
  start,
  onClose,
  onPick,
}: {
  open: boolean
  start?: string
  onClose: () => void
  onPick: (path: string) => void
}) {
  const { t } = useLocale()
  const [path, setPath] = useState(start || '')
  const [parent, setParent] = useState('')
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([])
  const [shortcuts, setShortcuts] = useState<{ name: string; path: string }[]>([])

  useEffect(() => {
    if (!open) return
    void api.fs(start || path || '').then((data) => {
      setPath(data.path)
      setParent(data.parent || '')
      setEntries((data.entries || data.folders || []) as { name: string; path: string }[])
      setShortcuts((data.shortcuts || []) as { name: string; path: string }[])
    })
  }, [open, start])

  const go = (next: string) => {
    void api.fs(next).then((data) => {
      setPath(data.path)
      setParent(data.parent || '')
      setEntries((data.entries || data.folders || []) as { name: string; path: string }[])
      setShortcuts((data.shortcuts || []) as { name: string; path: string }[])
    })
  }

  return (
    <Dialog
      open={open}
      title={t('folder.title')}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => {
              onPick(path)
              onClose()
            }}
          >
            {t('folder.use')}
          </Button>
        </>
      }
    >
      <div className="mb-2 flex items-center gap-2 font-mono text-[11px]">
        <Button variant="outline" size="sm" disabled={!parent} onClick={() => go(parent)}>
          {t('folder.up')}
        </Button>
        <span className="truncate text-muted-foreground">{path}</span>
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {shortcuts.map((item) => (
          <Button key={item.path} variant="outline" size="sm" onClick={() => go(item.path)}>
            {item.name}
          </Button>
        ))}
      </div>
      <div className="max-h-64 overflow-auto border border-border">
        {entries.map((item) => (
          <button
            key={item.path}
            type="button"
            className="block w-full truncate border-b border-border/60 px-3 py-1.5 text-left font-mono text-xs hover:bg-accent/50"
            onClick={() => go(item.path)}
          >
            {item.name}
          </button>
        ))}
      </div>
    </Dialog>
  )
}
