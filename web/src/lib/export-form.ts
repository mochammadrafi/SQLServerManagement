export const BATCH_KEY = 'sqlsm.export.batch_size'

export type ChunkMode = 'size' | 'rows' | 'none'

export const CHUNK_SIZE_OPTIONS = [
  { value: '1073741824', label: '1 GB' },
  { value: '2147483648', label: '2 GB' },
  { value: '5368709120', label: '5 GB' },
  { value: '10737418240', label: '10 GB' },
  { value: '21474836480', label: '20 GB' },
  { value: 'custom', label: 'custom (GB)' },
] as const

export const CHUNK_ROW_OPTIONS = [
  { value: '500000', label: '500,000' },
  { value: '1000000', label: '1,000,000' },
  { value: '2000000', label: '2,000,000' },
] as const

export const BACKUP_CHUNK_OPTIONS = [
  { value: '5368709120', label: '5 GB' },
  { value: '10737418240', label: '10 GB' },
  { value: '21474836480', label: '20 GB' },
  { value: '0', label: 'single file' },
] as const

export function readBatchSize(defaultValue = 10000) {
  const raw = localStorage.getItem(BATCH_KEY)
  const n = Number(raw)
  return Number.isFinite(n) && n >= 500 ? n : defaultValue
}

export function writeBatchSize(value: number) {
  localStorage.setItem(BATCH_KEY, String(value))
}

export function chunkFromForm(
  mode: ChunkMode,
  sizeValue: string,
  rowsValue: string,
  customGb: string,
): { chunk_rows: number; chunk_bytes: number } | null {
  if (mode === 'none') return { chunk_rows: 0, chunk_bytes: 0 }
  if (mode === 'rows') return { chunk_rows: Number(rowsValue || 0), chunk_bytes: 0 }
  if (sizeValue === 'custom') {
    const gb = Number(customGb)
    if (!Number.isFinite(gb) || gb < 1) return null
    return { chunk_rows: 0, chunk_bytes: Math.trunc(gb * 1024 * 1024 * 1024) }
  }
  return { chunk_rows: 0, chunk_bytes: Number(sizeValue || 0) }
}
