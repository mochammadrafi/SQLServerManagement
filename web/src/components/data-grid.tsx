import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef, useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useLocale } from '@/lib/i18n'

function cellText(value: unknown) {
  if (value == null || value === '') return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function DataGrid({
  columns,
  rows,
}: {
  columns: string[] | { name: string }[]
  rows: unknown[][] | Record<string, unknown>[]
}) {
  const { t } = useLocale()
  const names = useMemo(
    () => columns.map((col) => (typeof col === 'string' ? col : col.name)),
    [columns],
  )
  const data = useMemo(() => {
    return rows.map((row, index) => {
      if (Array.isArray(row)) {
        const item: Record<string, unknown> = { __i: index }
        names.forEach((name, i) => {
          item[name] = row[i]
        })
        return item
      }
      return { __i: index, ...row }
    })
  }, [rows, names])
  const defs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      names.map((name) => ({
        id: name,
        header: name.toUpperCase(),
        accessorFn: (row) => cellText(row[name]),
      })),
    [names],
  )
  const table = useReactTable({ data, columns: defs, getCoreRowModel: getCoreRowModel() })
  const parentRef = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: table.getRowModel().rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 16,
  })
  const [open, setOpen] = useState<Record<string, unknown> | null>(null)

  if (!names.length) {
    return <div className="p-5 font-mono text-xs text-muted-foreground">{t('sql.empty')}</div>
  }

  return (
    <>
      <div ref={parentRef} className="min-h-[240px] flex-1 overflow-auto">
        <table className="w-full min-w-[640px] text-left font-mono text-[11px]">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((h) => (
                  <th key={h.id} className="px-4 py-2 tracking-widest text-muted-foreground">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {virtual.getVirtualItems().length === 0
              ? table.getRowModel().rows.slice(0, 80).map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-b border-border/60 hover:bg-accent/40"
                    onDoubleClick={() => setOpen(row.original)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="max-w-64 truncate px-4 py-1.5">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              : virtual.getVirtualItems().map((item) => {
              const row = table.getRowModel().rows[item.index]
              return (
                <tr
                  key={row.id}
                  className="cursor-pointer border-b border-border/60 hover:bg-accent/40"
                  style={{ height: item.size }}
                  onDoubleClick={() => setOpen(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="max-w-64 truncate px-4 py-1.5">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <Dialog
        open={Boolean(open)}
        title={t('detail.title')}
        onClose={() => setOpen(null)}
        wide
        footer={
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(null)}>
            {t('common.close')}
          </Button>
        }
      >
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
          {JSON.stringify(
            Object.fromEntries(Object.entries(open || {}).filter(([key]) => key !== '__i')),
            null,
            2,
          )}
        </pre>
      </Dialog>
    </>
  )
}
