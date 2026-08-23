import type { AiCatalogItem, AiContextDb, AiStep, TablePage } from '@/lib/api'

export type View = 'browse' | 'sql' | 'ai' | 'jobs' | 'server'

export type AiChatItem = {
  role: 'user' | 'ai'
  text: string
  sql?: string[]
  notes?: string[]
  warnings?: string[]
  used_objects?: string[]
  context?: AiContextDb[]
  steps?: AiStep[]
  model?: string
}

export type AiMode = 'query' | 'analyze'

export type AiChatSession = {
  id: string
  title: string
  updatedAt: number
  mode: AiMode
  message: string
  sql: string
  items: AiChatItem[]
  detailContext: AiContextDb[]
  detailSteps: AiStep[]
  error: string | null
}

export type AiShellState = {
  selected: string[]
  samples: boolean
  catalog: AiCatalogItem[]
  showPanel: boolean
  sessions: AiChatSession[]
  activeSessionId: string
}

/** @deprecated Legacy flat AI state kept for migration only. */
export type LegacyAiShellState = Partial<AiShellState> & {
  mode?: AiMode
  message?: string
  sql?: string
  items?: AiChatItem[]
  detailContext?: AiContextDb[]
  detailSteps?: AiStep[]
  error?: string | null
}

export type SqlTabState = {
  id: string
  title: string
  sql: string
  database: string
  result: (TablePage & { messages?: string[] }) | null
  error: string | null
}

export type ShellState = {
  view: View
  sqlTabs: SqlTabState[]
  sqlActiveId: string
  ai: AiShellState
}

let tabSeq = 0
let chatSeq = 0

function nextTabId() {
  tabSeq += 1
  return `sql-${tabSeq}`
}

function nextChatId() {
  chatSeq += 1
  return `chat-${chatSeq}`
}

export function sqlTabTitle(sql: string, index: number) {
  const line = sql
    .split('\n')
    .map((row) => row.trim())
    .find(Boolean)
  if (!line) return `Query ${index}`
  const trimmed = line.length > 28 ? `${line.slice(0, 28)}…` : line
  return trimmed
}

export function chatSessionTitle(items: AiChatItem[], fallback: string) {
  const first = items.find((item) => item.role === 'user' && item.text.trim())
  if (!first) return fallback
  const text = first.text.trim()
  return text.length > 36 ? `${text.slice(0, 36)}…` : text
}

export function createSqlTab(sql = 'SELECT TOP 100 * FROM sys.databases;', database = 'master'): SqlTabState {
  const id = nextTabId()
  return {
    id,
    title: sqlTabTitle(sql, 1),
    sql,
    database,
    result: null,
    error: null,
  }
}

export function createChatSession(index = 1): AiChatSession {
  return {
    id: nextChatId(),
    title: `Chat ${index}`,
    updatedAt: Date.now(),
    mode: 'query',
    message: '',
    sql: '',
    items: [],
    detailContext: [],
    detailSteps: [],
    error: null,
  }
}

export function createDefaultAiState(): AiShellState {
  const session = createChatSession()
  return {
    selected: [],
    samples: true,
    catalog: [],
    showPanel: true,
    sessions: [session],
    activeSessionId: session.id,
  }
}

export function normalizeAiState(ai?: LegacyAiShellState | AiShellState): AiShellState {
  const base = createDefaultAiState()
  if (!ai) return base

  if (ai.sessions?.length) {
    const sessions = ai.sessions
    const activeSessionId = sessions.some((session) => session.id === ai.activeSessionId)
      ? ai.activeSessionId!
      : sessions[0].id
    return {
      ...base,
      selected: ai.selected || [],
      samples: ai.samples ?? true,
      catalog: ai.catalog || [],
      showPanel: ai.showPanel ?? true,
      sessions,
      activeSessionId,
    }
  }

  const legacy = ai as LegacyAiShellState
  if (
    legacy.items?.length ||
    legacy.message ||
    legacy.sql ||
    legacy.mode ||
    legacy.detailContext?.length ||
    legacy.error
  ) {
    const session = createChatSession()
    session.items = legacy.items || []
    session.mode = legacy.mode || 'query'
    session.message = legacy.message || ''
    session.sql = legacy.sql || ''
    session.detailContext = legacy.detailContext || []
    session.detailSteps = legacy.detailSteps || []
    session.error = legacy.error || null
    session.title = chatSessionTitle(session.items, session.title)
    session.updatedAt = Date.now()
    return {
      selected: legacy.selected || [],
      samples: legacy.samples ?? true,
      catalog: legacy.catalog || [],
      showPanel: legacy.showPanel ?? true,
      sessions: [session],
      activeSessionId: session.id,
    }
  }

  return {
    ...base,
    selected: ai.selected || [],
    samples: ai.samples ?? true,
    catalog: ai.catalog || [],
    showPanel: ai.showPanel ?? true,
  }
}

export function getActiveSession(ai: AiShellState): AiChatSession {
  return ai.sessions.find((session) => session.id === ai.activeSessionId) || ai.sessions[0] || createChatSession()
}

export function patchActiveSession(
  ai: AiShellState,
  patch: Partial<AiChatSession> | ((session: AiChatSession) => AiChatSession),
): AiShellState {
  const activeId = ai.activeSessionId
  const sessions = ai.sessions.map((session) => {
    if (session.id !== activeId) return session
    const next = typeof patch === 'function' ? patch(session) : { ...session, ...patch }
    return { ...next, updatedAt: Date.now() }
  })
  return { ...ai, sessions }
}

export function addChatSession(ai: AiShellState): AiShellState {
  const session = createChatSession(ai.sessions.length + 1)
  return {
    ...ai,
    sessions: [session, ...ai.sessions],
    activeSessionId: session.id,
  }
}

export function switchChatSession(ai: AiShellState, id: string): AiShellState {
  if (!ai.sessions.some((session) => session.id === id)) return ai
  return { ...ai, activeSessionId: id }
}

export function removeChatSession(ai: AiShellState, id: string): AiShellState {
  if (ai.sessions.length <= 1) {
    const session = createChatSession()
    return { ...ai, sessions: [session], activeSessionId: session.id }
  }
  const sessions = ai.sessions.filter((session) => session.id !== id)
  const activeSessionId = ai.activeSessionId === id ? sessions[0].id : ai.activeSessionId
  return { ...ai, sessions, activeSessionId }
}

export function createDefaultShell(): ShellState {
  const tab = createSqlTab()
  return {
    view: 'browse',
    sqlTabs: [tab],
    sqlActiveId: tab.id,
    ai: createDefaultAiState(),
  }
}

export function openSqlInShell(shell: ShellState, sql: string, database: string): ShellState {
  const tab = createSqlTab(sql, database)
  tab.title = sqlTabTitle(sql, shell.sqlTabs.length + 1)
  return {
    ...shell,
    view: 'sql',
    sqlTabs: [...shell.sqlTabs, tab],
    sqlActiveId: tab.id,
  }
}

export function patchSqlTabs(
  shell: ShellState,
  tabs: SqlTabState[],
  activeTabId: string,
): ShellState {
  return {
    ...shell,
    sqlTabs: tabs.length ? tabs : [createSqlTab()],
    sqlActiveId: tabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : tabs[0]?.id || createSqlTab().id,
  }
}

export function patchAiState(
  shell: ShellState,
  patch: Partial<AiShellState> | ((current: AiShellState) => AiShellState),
): ShellState {
  const nextAi = typeof patch === 'function' ? patch(shell.ai) : { ...shell.ai, ...patch }
  return { ...shell, ai: normalizeAiState(nextAi) }
}
