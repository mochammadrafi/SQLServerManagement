import type { AiContextDb } from '@/lib/api'

export type MentionPick = {
  kind: 'database' | 'table' | 'column'
  ref: string
  label: string
  hint?: string
}

export type MentionTable = {
  database?: string
  schema: string
  name: string
}

export function parseMentionTables(text: string, defaultDb: string): MentionTable[] {
  const tables: MentionTable[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/@([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+){1,2})/g)) {
    const raw = match[1]
    if (!raw) continue
    const parts = raw.split('.')
    if (parts.length === 3) {
      const key = `${parts[0]}|${parts[1]}|${parts[2]}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      tables.push({ database: parts[0], schema: parts[1], name: parts[2] })
    } else if (parts.length === 2 && defaultDb) {
      const key = `${defaultDb}|${parts[0]}|${parts[1]}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      tables.push({ database: defaultDb, schema: parts[0], name: parts[1] })
    }
  }
  return tables
}

export function mentionFilterAt(value: string, cursor: number) {
  const before = value.slice(0, cursor)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const chunk = before.slice(at + 1)
  if (chunk.includes(' ') || chunk.includes('\n')) return null
  return { start: at, filter: chunk.toLowerCase() }
}

export function buildMentionSuggestions(
  filter: string,
  context: AiContextDb[] | undefined,
  databases: string[],
): MentionPick[] {
  const out: MentionPick[] = []
  const n = filter.trim().toLowerCase()
  const parts = n.split('.').filter(Boolean)

  for (const db of databases) {
    const dbLower = db.toLowerCase()
    if (!n || dbLower.includes(n) || dbLower.startsWith(parts[0] || '')) {
      out.push({ kind: 'database', ref: db, label: db, hint: 'database' })
    }
  }

  for (const db of context || []) {
    const dbLower = db.database.toLowerCase()
    if (parts[0] && parts[0] !== dbLower && !dbLower.startsWith(parts[0])) continue

    for (const obj of db.objects) {
      const tableRef = `${db.database}.${obj.schema}.${obj.name}`
      const shortRef = `${obj.schema}.${obj.name}`
      const tableLower = shortRef.toLowerCase()
      const fullLower = tableRef.toLowerCase()

      const tableMatch =
        !n ||
        fullLower.includes(n) ||
        tableLower.includes(n) ||
        tableLower.startsWith(parts[parts.length - 1] || '') ||
        (parts.length === 2 && obj.schema.toLowerCase().startsWith(parts[0]) && obj.name.toLowerCase().startsWith(parts[1]))

      if (tableMatch) {
        out.push({
          kind: 'table',
          ref: tableRef,
          label: shortRef,
          hint: `${db.database} · ${obj.kind}`,
        })
      }

      if (parts.length >= 2 || n.includes('.')) {
        for (const col of obj.columns) {
          const colLower = col.name.toLowerCase()
          const colFilter = parts[parts.length - 1] || n
          if (colFilter && !colLower.includes(colFilter) && !colLower.startsWith(colFilter)) continue
          out.push({
            kind: 'column',
            ref: `${tableRef}.${col.name}`,
            label: col.name,
            hint: `${shortRef} · ${col.type}`,
          })
        }
      }
    }
  }

  const rank = (item: MentionPick) => {
    const label = item.label.toLowerCase()
    if (label === n) return 0
    if (label.startsWith(n)) return 1
    if (item.ref.toLowerCase().includes(n)) return 2
    return 3
  }

  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 24)
}

export function insertMention(value: string, start: number, cursor: number, ref: string) {
  const insert = `@${ref} `
  return {
    nextValue: `${value.slice(0, start)}${insert}${value.slice(cursor)}`,
    nextCursor: start + insert.length,
  }
}
