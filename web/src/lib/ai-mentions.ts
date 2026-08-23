import type { AiCatalogItem, AiContextDb } from '@/lib/api'

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

const MENTION_IN_TEXT = /@((?:\[[^\]]+\]|[^.@\s]+)(?:\.(?:\[[^\]]+\]|[^.@\s]+)){0,2})/g

export function quoteMentionPart(part: string) {
  return /[^A-Za-z0-9_]/.test(part) ? `[${part}]` : part
}

export function formatMentionRef(database: string, schema: string, name: string) {
  return `${quoteMentionPart(database)}.${quoteMentionPart(schema)}.${quoteMentionPart(name)}`
}

export function splitMentionParts(raw: string): string[] {
  const parts: string[] = []
  let cur = ''
  let bracket = false
  for (const ch of raw) {
    if (ch === '[') {
      bracket = true
      cur += ch
      continue
    }
    if (ch === ']') {
      bracket = false
      cur += ch
      continue
    }
    if (ch === '.' && !bracket) {
      parts.push(unquoteMentionPart(cur))
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur) parts.push(unquoteMentionPart(cur))
  return parts.map((part) => part.trim()).filter(Boolean)
}

export function unquoteMentionPart(part: string) {
  const text = part.trim()
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1)
  return text
}

function matchesLoose(haystack: string, needle: string) {
  const h = haystack.toLowerCase()
  const n = needle.trim().toLowerCase()
  if (!n) return true
  if (h.includes(n)) return true
  const words = n.split(/\s+/).filter(Boolean)
  if (!words.length) return true
  let pos = 0
  for (const word of words) {
    const idx = h.indexOf(word, pos)
    if (idx < 0) return false
    pos = idx + word.length
  }
  return true
}

export function parseMentionTables(text: string, defaultDb: string): MentionTable[] {
  const tables: MentionTable[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_IN_TEXT)) {
    const raw = match[1]
    if (!raw) continue
    const parts = splitMentionParts(raw)
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
  if (chunk.includes('\n')) return null
  return { start: at, filter: chunk }
}

function rankMention(label: string, ref: string, filter: string) {
  const labelLower = label.toLowerCase()
  const refLower = ref.toLowerCase()
  const n = filter.trim().toLowerCase()
  if (!n) return 4
  if (labelLower === n || refLower === n) return 0
  if (labelLower.startsWith(n) || refLower.startsWith(n)) return 1
  const parts = splitMentionParts(filter)
  const last = parts[parts.length - 1]?.toLowerCase() || n
  if (labelLower.startsWith(last)) return 2
  if (labelLower.includes(n) || refLower.includes(n)) return 3
  return 5
}

function matchCatalogItem(item: AiCatalogItem, filter: string) {
  const parts = splitMentionParts(filter)
  const db = item.database
  const schema = item.schema
  const name = item.name
  if (parts.length >= 3) {
    return (
      matchesLoose(db, parts[0]) &&
      matchesLoose(schema, parts[1]) &&
      matchesLoose(name, parts.slice(2).join('.'))
    )
  }
  if (parts.length === 2) {
    return matchesLoose(schema, parts[0]) && matchesLoose(name, parts[1])
  }
  return (
    matchesLoose(name, filter) ||
    matchesLoose(`${schema}.${name}`, filter) ||
    matchesLoose(`${db}.${schema}.${name}`, filter) ||
    matchesLoose(db, filter)
  )
}

export function buildMentionSuggestions(
  filter: string,
  catalog: AiCatalogItem[] | undefined,
  context: AiContextDb[] | undefined,
  databases: string[],
  limit = 80,
) {
  const out: MentionPick[] = []
  const parts = splitMentionParts(filter)
  const dbPrefix = parts.length >= 1 && filter.includes('.') ? parts[0] : ''

  for (const db of databases) {
    if (dbPrefix && !db.toLowerCase().includes(dbPrefix.toLowerCase())) continue
    if (!filter.trim() || matchesLoose(db, filter)) {
      out.push({ kind: 'database', ref: quoteMentionPart(db), label: db, hint: 'database' })
    }
  }

  const catalogItems = catalog || []
  for (const item of catalogItems) {
    if (dbPrefix && !item.database.toLowerCase().includes(dbPrefix.toLowerCase())) continue
    if (!matchCatalogItem(item, filter)) continue
    const ref = formatMentionRef(item.database, item.schema, item.name)
    out.push({
      kind: 'table',
      ref,
      label: `${item.schema}.${item.name}`,
      hint: `${item.database} · ${item.kind}${item.row_count != null ? ` · ${item.row_count.toLocaleString()}` : ''}`,
    })
  }

  if (parts.length >= 2 || filter.includes('.')) {
    for (const db of context || []) {
      for (const obj of db.objects) {
        const tableRef = formatMentionRef(db.database, obj.schema, obj.name)
        const shortRef = `${obj.schema}.${obj.name}`
        if (!matchCatalogItem({ database: db.database, schema: obj.schema, name: obj.name, kind: obj.kind }, filter)) {
          continue
        }
        for (const col of obj.columns) {
          if (!matchesLoose(col.name, parts[parts.length - 1] || filter)) continue
          out.push({
            kind: 'column',
            ref: `${tableRef}.${quoteMentionPart(col.name)}`,
            label: col.name,
            hint: `${shortRef} · ${col.type}`,
          })
        }
      }
    }
  }

  const seen = new Set<string>()
  return out
    .filter((item) => {
      const key = `${item.kind}:${item.ref}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => rankMention(a.label, a.ref, filter) - rankMention(b.label, b.ref, filter))
    .slice(0, limit)
}

export function insertMention(value: string, start: number, cursor: number, ref: string) {
  const insert = `@${ref} `
  return {
    nextValue: `${value.slice(0, start)}${insert}${value.slice(cursor)}`,
    nextCursor: start + insert.length,
  }
}
