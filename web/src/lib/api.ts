export type Envelope<T> = {
  success: boolean
  message: string
  results: T
}

export type Connection = {
  id: string
  label: string
  server: string
  port: number
  instance: string
  auth: string
  username: string
  database: string
  encrypt: boolean
  display_server?: string
  backend?: string
  driver_name?: string
}

export type Profile = {
  id: string
  label: string
  server: string
  port: number
  instance: string
  auth: string
  username: string
  database: string
  encrypt: boolean
  has_password: boolean
  remember_password: boolean
}

export type Meta = {
  platform: string
  windows: boolean
  odbc_drivers: string[]
  preferred_driver: string | null
  default_folder: string
  profiles: Profile[]
  csrf_token: string
  export_limits: {
    max_workers: number
    max_jobs: number
    max_total_workers: number
    batch_size: number
    min_batch_size: number
    max_batch_size: number
  }
}

export type Session = {
  connected: boolean
  connection?: Connection
  connection_id?: string
  connections: Connection[]
  backend?: string
  driver_name?: string
  csrf_token?: string
}

export type DatabaseRow = {
  name: string
  is_system?: boolean
  state?: string
  size_mb?: number
}

export type CatalogObject = {
  schema: string
  name: string
  kind?: string
  is_system?: boolean
  row_count?: number | null
  size_mb?: number | null
}

export type TablePage = {
  columns: { name: string; type?: string }[] | string[]
  rows: unknown[][] | Record<string, unknown>[]
  last_key?: Record<string, unknown> | null
  paging?: string
  elapsed_ms?: number
  row_count?: number | null
  truncated?: boolean
  has_more?: boolean
}

export type Job = {
  id: string
  status: string
  database: string
  schema: string
  table: string
  kind: string
  folder: string
  rows_written: number
  bytes_written: number
  row_count_estimate?: number | null
  parts: { name: string; rows?: number; bytes?: number }[]
  error?: string | null
  hint?: string | null
  started_at?: string
  finished_at?: string
  tables_total?: number | null
  tables_done?: number | null
  current_object?: string | null
  can_pause?: boolean
  can_resume?: boolean
  can_cancel?: boolean
  gzip?: boolean
  workers?: number
}

let csrf = ''

export function setCsrf(token: string) {
  csrf = token
}

async function parse<T>(res: Response): Promise<T> {
  const header = res.headers.get('X-SQLSM-Token')
  if (header) csrf = header
  const body = (await res.json()) as Envelope<T>
  if (!res.ok || !body.success) {
    const hint =
      body.results && typeof body.results === 'object' && 'hint' in body.results
        ? String((body.results as { hint?: string }).hint || '')
        : ''
    throw new Error(hint ? `${body.message} — ${hint}` : body.message || `HTTP ${res.status}`)
  }
  return body.results
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (csrf && !headers.has('X-SQLSM-Token')) {
    headers.set('X-SQLSM-Token', csrf)
  }
  const res = await fetch(path, { ...options, headers, credentials: 'include' })
  return parse<T>(res)
}

export const api = {
  meta: () => request<Meta>('/api/v1/meta'),
  session: () => request<Session>('/api/v1/session'),
  connect: (body: Record<string, unknown>) =>
    request<Session & { server?: Record<string, unknown> }>('/api/v1/connect', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  disconnect: (id?: string, all = false) =>
    request<Session>('/api/v1/disconnect', {
      method: 'POST',
      body: JSON.stringify({ id: id || '', all }),
    }),
  switchConnection: (id: string) =>
    request<Session>('/api/v1/connections/switch', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  deleteProfile: (id: string) =>
    request<{ profiles: Profile[] }>(`/api/v1/profiles/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  server: () =>
    request<{
      server: Record<string, unknown>
      sessions: Record<string, unknown>[]
      sessions_error?: string | null
      backend?: string
      driver_name?: string
    }>('/api/v1/server'),
  databases: () => request<{ databases: DatabaseRow[] }>('/api/v1/databases'),
  objects: (database: string, counts = false) =>
    request<{
      database: string
      schemas: { name: string; is_system?: boolean }[]
      objects: Record<string, CatalogObject[]>
    }>(`/api/v1/objects?database=${encodeURIComponent(database)}&counts=${counts ? '1' : '0'}`),
  columns: (database: string, schema: string, table: string) =>
    request<{ columns: { name: string; type?: string }[] }>(
      `/api/v1/columns?database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`,
    ),
  tableStats: (database: string, schema: string, table: string) =>
    request<{ keys: string[]; row_count: number | null; paging: string }>(
      `/api/v1/table/stats?database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`,
    ),
  tablePage: (params: {
    database: string
    schema: string
    table: string
    page_size: number
    after?: Record<string, unknown> | null
    seek?: Record<string, unknown> | null
    offset?: number
    where?: string
  }) => {
    const q = new URLSearchParams({
      database: params.database,
      schema: params.schema,
      table: params.table,
      page_size: String(params.page_size),
    })
    if (params.after) q.set('after', JSON.stringify(params.after))
    if (params.seek) q.set('seek', JSON.stringify(params.seek))
    if (params.offset) q.set('offset', String(params.offset))
    if (params.where) q.set('where', params.where)
    return request<TablePage>(`/api/v1/table/page?${q}`)
  },
  query: (sql: string, database: string, maxRows = 1000) =>
    request<
      TablePage & {
        messages?: string[]
        result_sets?: { columns: string[]; rows: unknown[][] }[]
      }
    >('/api/v1/query', { method: 'POST', body: JSON.stringify({ sql, database, max_rows: maxRows }) }),
  cancel: () => request<{ cancelled: number }>('/api/v1/cancel', { method: 'POST', body: '{}' }),
  scriptSelect: (schema: string, table: string, database?: string) =>
    request<{ sql: string }>(
      `/api/v1/script/select?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}${database ? `&database=${encodeURIComponent(database)}` : ''}`,
    ),
  exports: () => request<{ jobs: Job[] }>('/api/v1/exports'),
  startExport: (body: Record<string, unknown>) =>
    request<{ job: Job }>('/api/v1/export', { method: 'POST', body: JSON.stringify(body) }),
  startDatabaseExport: (body: Record<string, unknown>) =>
    request<{ job: Job }>('/api/v1/export/database', { method: 'POST', body: JSON.stringify(body) }),
  startBackup: (body: Record<string, unknown>) =>
    request<{ job: Job }>('/api/v1/backup', { method: 'POST', body: JSON.stringify(body) }),
  cancelJob: (id: string) =>
    request<{ job: Job }>(`/api/v1/export/${id}/cancel`, { method: 'POST', body: '{}' }),
  pauseJob: (id: string) =>
    request<{ job: Job }>(`/api/v1/export/${id}/pause`, { method: 'POST', body: '{}' }),
  resumeJob: (id: string) =>
    request<{ job: Job }>(`/api/v1/export/${id}/resume`, { method: 'POST', body: '{}' }),
  skipJob: (id: string, schema: string, name: string) =>
    request<{ job: Job }>(`/api/v1/export/${id}/skip`, {
      method: 'POST',
      body: JSON.stringify({ schema, name }),
    }),
  partUrl: (jobId: string, name: string) =>
    `/api/v1/export/${encodeURIComponent(jobId)}/parts/${encodeURIComponent(name)}`,
  fs: (path: string) =>
    request<{
      path: string
      parent?: string
      folders?: { name: string; path: string }[]
      entries?: { name: string; path: string }[]
      shortcuts?: { name: string; path: string }[]
    }>(`/api/v1/fs?path=${encodeURIComponent(path)}`),
  fsPick: (path: string) =>
    request<{ path: string }>('/api/v1/fs/pick', { method: 'POST', body: JSON.stringify({ path }) }),
}
