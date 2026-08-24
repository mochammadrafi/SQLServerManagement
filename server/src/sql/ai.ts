import { ClientError } from "../errors.js";
import type { ConnectionConfig, SqlServerClient } from "./client.js";
import { chatOpenAi, openaiStatus } from "./openai.js";
import {
  cacheCatalogItems,
  isSchemaCacheFresh,
  readSchemaCache,
  type SchemaCacheEntry,
  type SchemaCacheTable,
} from "./schema-cache.js";

export type AiMode = "query" | "analyze";

export type AiAsk = {
  mode?: AiMode;
  message?: string;
  databases?: string[];
  tables?: { database?: string; schema: string; name: string }[];
  includeSamples?: boolean;
  sql?: string;
  history?: { role: "user" | "ai"; text?: string; used_objects?: string[] }[];
};

export type AiInferredLink = {
  from: string;
  to: string;
  columns: string[];
  source: "column_name";
};

export type AiStep = {
  id: string;
  label: string;
  detail?: string;
  ms?: number;
};

export type AiColumn = {
  name: string;
  type: string;
  nullable?: boolean;
};

export type AiForeignKey = {
  from: string;
  to: string;
  columns: string[];
  constraint?: string;
};

export type AiContextObject = {
  database: string;
  schema: string;
  name: string;
  kind: string;
  row_count?: number | null;
  size_kb?: number | null;
  pk?: string[];
  columns: AiColumn[];
  sample?: { columns: string[]; rows: unknown[][] };
  reason?: string;
};

export type AiContextDb = {
  database: string;
  object_count: number;
  fk_count: number;
  objects: AiContextObject[];
  foreign_keys: AiForeignKey[];
  inferred_links?: AiInferredLink[];
};

export type AiCatalogItem = {
  database: string;
  schema: string;
  name: string;
  kind: string;
  row_count?: number | null;
};

const SQL_CONTINUATION =
  /^(FROM|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|UNION)/i;

const SYSTEM = `You are a SQL Server 2012 T-SQL assistant inside a local admin console.
Return ONLY valid JSON with this shape:
{"explanation":"...","sql":["one complete T-SQL statement"],"notes":["..."],"used_objects":["db.schema.table"]}

Accuracy rules (critical):
- Target SQL Server 2012 only. Use TOP, ISNULL, CONVERT, CTEs. No STRING_AGG, OPENJSON, DROP IF EXISTS, GENERATE_SERIES.
- Use ONLY tables, views, and columns listed in the catalog context below.
- If the request needs objects not in context, explain what is missing in explanation and notes — do NOT invent names or columns.
- Use three-part names [database].[schema].[object] when more than one database appears in context.
- Default to SELECT. Write INSERT/UPDATE/DELETE only if the user explicitly asked.
- When the user asks about relationships, references, sekolah/pembimbing, or "where does X connect", explain the FK/inferred link graph in notes first, then write SQL that JOINs through lookup tables. Do NOT guess denormalized name columns unless they appear in context.
- When the user asks to check all/related tables or continue a schema study, stay on the same table cluster from conversation history — never jump to an unrelated table.
- When the request spans multiple tables, write JOINs using foreign keys, inferred links, and PKs from context. State assumptions in notes.
- Put ONE complete runnable statement in sql[0]. Do NOT split SELECT / FROM / JOIN across multiple array items.
- List every object you referenced in used_objects.`;

function systemDbs() {
  return new Set(["master", "model", "msdb", "tempdb"]);
}

function step(steps: AiStep[], id: string, label: string, detail?: string, started?: number) {
  steps.push({ id, label, detail, ms: started != null ? Date.now() - started : undefined });
}

function tokenize(text: string) {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((part) => part.length > 2))];
}

function wantsJoin(message: string, pinnedCount: number) {
  if (pinnedCount > 1) return true;
  return /\b(join|relasi|hubung|gabung|combine|link|inner|left|right|outer|cross)\b/i.test(message);
}

function splitMentionParts(raw: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let bracket = false;
  for (const ch of raw) {
    if (ch === "[") {
      bracket = true;
      cur += ch;
      continue;
    }
    if (ch === "]") {
      bracket = false;
      cur += ch;
      continue;
    }
    if (ch === "." && !bracket) {
      parts.push(unquoteMentionPart(cur));
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(unquoteMentionPart(cur));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function unquoteMentionPart(part: string) {
  const text = part.trim();
  if (text.startsWith("[") && text.endsWith("]")) return text.slice(1, -1);
  return text;
}

function mentionTables(message: string, databases: string[]) {
  const defaultDb = databases[0] || "";
  const tables: { database?: string; schema: string; name: string }[] = [];
  const seen = new Set<string>();
  const re = /@((?:\[[^\]]+\]|[^.@\s]+)(?:\.(?:\[[^\]]+\]|[^.@\s]+)){0,2})/g;
  for (const match of message.matchAll(re)) {
    const raw = match[1];
    if (!raw) continue;
    const parts = splitMentionParts(raw);
    if (parts.length === 3) {
      const key = `${parts[0]}|${parts[1]}|${parts[2]}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tables.push({ database: parts[0], schema: parts[1], name: parts[2] });
    } else if (parts.length === 2 && defaultDb) {
      const key = `${defaultDb}|${parts[0]}|${parts[1]}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tables.push({ database: defaultDb, schema: parts[0], name: parts[1] });
    }
  }
  return tables;
}

function mergeFocusTables(ask: AiAsk, databases: string[]) {
  const defaultDb = databases[0] || "";
  const seen = new Set<string>();
  const out: NonNullable<AiAsk["tables"]> = [];
  const push = (item: { database?: string; schema: string; name: string }) => {
    const db = item.database || defaultDb;
    if (!db) return;
    const key = `${db}|${item.schema}|${item.name}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ database: db, schema: item.schema, name: item.name });
  };
  for (const item of ask.tables || []) push(item);
  for (const item of mentionTables(String(ask.message || ""), databases)) push(item);
  for (const turn of ask.history || []) {
    if (turn.role === "user") {
      for (const item of mentionTables(String(turn.text || ""), databases)) push(item);
    }
    for (const ref of turn.used_objects || []) {
      const parsed = parseObjectRef(String(ref || ""), defaultDb);
      if (parsed) push(parsed);
    }
  }
  return out;
}

function parseObjectRef(ref: string, defaultDb: string) {
  const parts = ref
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 3) return { database: parts[0], schema: parts[1], name: parts[2] };
  if (parts.length === 2 && defaultDb) return { database: defaultDb, schema: parts[0], name: parts[1] };
  return null;
}

function wantsSchemaExplore(message: string, history: AiAsk["history"]) {
  const blob = [message, ...(history || []).map((item) => String(item.text || ""))].join("\n").toLowerCase();
  return /\b(semua\s+tabel|all\s+tables?|cek\s+di|relasi|referensi|foreign\s*key|hubung|nyambung|kemana|pembimbing|sekolah|struktur|schema|mapping|cocokkan|pelajari|lengkap|erd|diagram|jejak|lookup)\b/i.test(
    blob,
  );
}

type CatalogEntry = {
  schema: string;
  name: string;
  kind: string;
  row_count?: number | null;
  size_kb?: number | null;
};

function expandFkNeighbors(
  roots: Set<string>,
  foreignKeys: AiForeignKey[],
  maxHops: number,
  maxTables: number,
) {
  const adj = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const fk of foreignKeys) {
    addEdge(fk.from.toLowerCase(), fk.to.toLowerCase());
  }
  const picked = new Set<string>(roots);
  let frontier = [...roots];
  for (let hop = 0; hop < maxHops && picked.size < maxTables && frontier.length; hop += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of adj.get(node) || []) {
        if (picked.has(neighbor)) continue;
        picked.add(neighbor);
        next.push(neighbor);
        if (picked.size >= maxTables) break;
      }
      if (picked.size >= maxTables) break;
    }
    frontier = next;
  }
  return picked;
}

function inferColumnLinks(objects: AiContextObject[]): AiInferredLink[] {
  const pkOwners = new Map<string, { schema: string; name: string; pk: string }>();
  for (const obj of objects) {
    for (const pk of obj.pk || []) {
      pkOwners.set(pk.toLowerCase(), { schema: obj.schema, name: obj.name, pk });
    }
  }
  const links: AiInferredLink[] = [];
  const seen = new Set<string>();
  for (const obj of objects) {
    for (const col of obj.columns) {
      const colName = col.name.toLowerCase();
      if (!colName.startsWith("id_")) continue;
      const owner = pkOwners.get(colName);
      if (!owner) continue;
      const from = `${obj.schema}.${obj.name}`;
      const to = `${owner.schema}.${owner.name}`;
      if (from.toLowerCase() === to.toLowerCase()) continue;
      const key = `${from}->${to}:${colName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        from,
        to,
        columns: [`${col.name}->${owner.pk}`],
        source: "column_name",
      });
    }
  }
  return links.slice(0, 100);
}

async function buildPkColumnIndex(client: SqlServerClient, database: string) {
  try {
    const rows = await client.listPrimaryKeyIndex(database);
    const pkByTable = new Map<string, string[]>();
    const tableByPkColumn = new Map<string, { schema: string; name: string }[]>();
    for (const row of rows) {
      const schema = String(row.table_schema || "dbo");
      const table = String(row.table_name || "");
      const column = String(row.column_name || "");
      if (!table || !column) continue;
      const tableKey = fkKey(schema, table);
      const cols = pkByTable.get(tableKey) || [];
      cols.push(column);
      pkByTable.set(tableKey, cols);
      const owners = tableByPkColumn.get(column.toLowerCase()) || [];
      owners.push({ schema, name: table });
      tableByPkColumn.set(column.toLowerCase(), owners);
    }
    return { pkByTable, tableByPkColumn };
  } catch {
    return { pkByTable: new Map<string, string[]>(), tableByPkColumn: new Map<string, { schema: string; name: string }[]>() };
  }
}

async function expandByIdColumns(
  client: SqlServerClient,
  database: string,
  seedKeys: Set<string>,
  catalogMap: Map<string, CatalogEntry>,
  pickedNames: Set<string>,
  maxAdd: number,
) {
  if (!seedKeys.size) return;
  const { tableByPkColumn } = await buildPkColumnIndex(client, database);
  let added = 0;
  for (const key of seedKeys) {
    const entry = catalogMap.get(key);
    if (!entry) continue;
    let columns: AiColumn[] = [];
    try {
      const cols = await client.listColumns(database, entry.schema, entry.name);
      columns = cols.slice(0, 64).map((col) => formatColumn(col));
    } catch {
      continue;
    }
    for (const col of columns) {
      if (added >= maxAdd) return;
      const colName = col.name.toLowerCase();
      if (!colName.startsWith("id_")) continue;
      for (const owner of tableByPkColumn.get(colName) || []) {
        const target = fkKey(owner.schema, owner.name);
        if (target === key || pickedNames.has(target)) continue;
        if (!catalogMap.has(target)) continue;
        pickedNames.add(target);
        added += 1;
        if (added >= maxAdd) return;
      }
    }
  }
}

function scoreObject(
  database: string,
  schema: string,
  name: string,
  kind: string,
  rowCount: number | null | undefined,
  message: string,
  joinMode: boolean,
) {
  const msg = message.toLowerCase();
  const full = `${schema}.${name}`.toLowerCase();
  const dbFull = `${database}.${schema}.${name}`.toLowerCase();
  let score = kind === "table" ? 1 : 0;
  if (msg.includes(dbFull) || msg.includes(`@${dbFull}`)) score += 30;
  if (msg.includes(full) || msg.includes(`@${full}`)) score += 20;
  if (msg.includes(name.toLowerCase()) || msg.includes(`@${name.toLowerCase()}`)) score += 12;
  for (const word of tokenize(message.replace(/@/g, " "))) {
    if (name.toLowerCase().includes(word)) score += 6;
    if (word.length > 4 && full.includes(word)) score += 4;
  }
  if (joinMode && kind === "table") score += 2;
  if (rowCount != null && rowCount > 0) score += Math.min(5, Math.log10(rowCount + 1));
  return score;
}

function reasonFor(score: number, wanted: boolean, joinMode: boolean) {
  if (wanted) return "selected";
  if (score >= 20) return "match";
  if (joinMode) return "fk";
  if (score >= 8) return "match";
  return "top";
}

function formatColumn(col: { name?: unknown; data_type?: unknown; is_nullable?: unknown }) {
  const name = String(col.name || "");
  const type = String(col.data_type || "unknown");
  const nullable = String(col.is_nullable || "").toUpperCase() === "YES";
  return { name, type, nullable };
}

function formatColumnLine(col: AiColumn) {
  const nullTag = col.nullable ? " NULL" : "";
  return `${col.name} ${col.type}${nullTag}`;
}

function fkKey(schema: string, table: string) {
  return `${schema}.${table}`.toLowerCase();
}

async function expandByIdColumnsFromCache(
  cache: SchemaCacheEntry,
  seedKeys: Set<string>,
  catalogMap: Map<string, CatalogEntry>,
  pickedNames: Set<string>,
  maxAdd: number,
) {
  const tableByPkColumn = new Map<string, { schema: string; name: string }[]>();
  for (const table of cache.tables) {
    for (const pk of table.pk || []) {
      const owners = tableByPkColumn.get(pk.toLowerCase()) || [];
      owners.push({ schema: table.schema, name: table.name });
      tableByPkColumn.set(pk.toLowerCase(), owners);
    }
  }
  let added = 0;
  for (const key of seedKeys) {
    const table = cache.tables.find((row) => fkKey(row.schema, row.name) === key);
    if (!table) continue;
    for (const col of table.columns) {
      if (added >= maxAdd) return;
      const colName = col.name.toLowerCase();
      if (!colName.startsWith("id_")) continue;
      for (const owner of tableByPkColumn.get(colName) || []) {
        const target = fkKey(owner.schema, owner.name);
        if (target === key || pickedNames.has(target)) continue;
        if (!catalogMap.has(target)) continue;
        pickedNames.add(target);
        added += 1;
        if (added >= maxAdd) return;
      }
    }
  }
}

async function loadDatabaseSources(
  client: SqlServerClient,
  cfg: ConnectionConfig | undefined,
  database: string,
  steps: AiStep[],
  dbStarted: number,
) {
  const schemaCache = cfg ? readSchemaCache(cfg, database) : null;
  if (schemaCache && isSchemaCacheFresh(schemaCache)) {
    step(steps, `cache-${database}`, `Cache · ${database}`, `${schemaCache.tables.length} cached table(s)`, dbStarted);
    const catalogMap = new Map<string, CatalogEntry>();
    const cacheTableMap = new Map<string, SchemaCacheTable>();
    for (const table of schemaCache.tables) {
      const key = fkKey(table.schema, table.name);
      catalogMap.set(key, {
        schema: table.schema,
        name: table.name,
        kind: table.kind,
        row_count: table.row_count ?? null,
        size_kb: table.size_kb ?? null,
      });
      cacheTableMap.set(key, table);
    }
    return {
      catalogMap,
      foreignKeys: schemaCache.foreign_keys as AiForeignKey[],
      cacheFresh: true,
      cacheTableMap,
      schemaCache,
    };
  }

  const catalog = await client.listObjects(database, true);
  const catalogMap = new Map<string, CatalogEntry>();
  for (const bucket of ["tables", "views"] as const) {
    for (const item of (catalog.objects[bucket] || []) as {
      schema?: string;
      name?: string;
      is_system?: boolean;
      row_count?: number | null;
      size_kb?: number | null;
    }[]) {
      if (item.is_system) continue;
      const schema = String(item.schema || "dbo");
      const name = String(item.name || "");
      if (!name) continue;
      catalogMap.set(fkKey(schema, name), {
        schema,
        name,
        kind: bucket === "tables" ? "table" : "view",
        row_count: item.row_count ?? null,
        size_kb: item.size_kb ?? null,
      });
    }
  }

  let foreignKeys: AiForeignKey[] = [];
  try {
    const fkRows = await client.listForeignKeys(database);
    const grouped = new Map<string, AiForeignKey>();
    for (const row of fkRows) {
      const fromSchema = String(row.from_schema || "dbo");
      const fromTable = String(row.from_table || "");
      const toSchema = String(row.to_schema || "dbo");
      const toTable = String(row.to_table || "");
      const fromColumn = String(row.from_column || "");
      if (!fromTable || !toTable || !fromColumn) continue;
      const from = `${fromSchema}.${fromTable}`;
      const to = `${toSchema}.${toTable}`;
      const key = `${from}->${to}:${String(row.constraint_name || "")}`;
      const hit = grouped.get(key) || {
        from,
        to,
        columns: [],
        constraint: String(row.constraint_name || ""),
      };
      hit.columns.push(`${fromColumn}->${String(row.to_column || "")}`);
      grouped.set(key, hit);
    }
    foreignKeys = [...grouped.values()];
  } catch {
    foreignKeys = [];
  }

  return {
    catalogMap,
    foreignKeys,
    cacheFresh: false,
    cacheTableMap: new Map<string, SchemaCacheTable>(),
    schemaCache: null as SchemaCacheEntry | null,
    liveCatalog: catalog,
  };
}

export async function gatherContext(client: SqlServerClient, ask: AiAsk, cfg?: ConnectionConfig) {
  const steps: AiStep[] = [];
  const started = Date.now();
  const message = String(ask.message || "");

  let databases = (ask.databases || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (!databases.length) {
    const all = await client.listDatabases();
    databases = all
      .filter((row) => !systemDbs().has(String((row as { name?: string }).name || "").toLowerCase()))
      .map((row) => String((row as { name?: string }).name || ""));
  }
  databases = databases.slice(0, 8);

  const focus = mergeFocusTables(ask, databases);
  const wanted = new Set(focus.map((item) => `${item.database || ""}|${item.schema}|${item.name}`.toLowerCase()));
  const exploreMode = wantsSchemaExplore(message, ask.history);
  const joinMode = wantsJoin(message, wanted.size) || exploreMode || wanted.size > 1;

  step(
    steps,
    "scope",
    "Scope",
    `${databases.length} database(s): ${databases.join(", ")} · focus ${wanted.size} · ${exploreMode ? "explore" : joinMode ? "join" : "lookup"}`,
    started,
  );

  const context: AiContextDb[] = [];
  let sampleBudget = ask.includeSamples === false ? 0 : 12;
  let sampleUsed = 0;

  for (const database of databases) {
    const dbStarted = Date.now();
    const sources = await loadDatabaseSources(client, cfg, database, steps, dbStarted);
    const { catalogMap, foreignKeys, cacheFresh, cacheTableMap, schemaCache } = sources;
    const liveCatalog = "liveCatalog" in sources ? sources.liveCatalog : null;

    const candidates: {
      schema: string;
      name: string;
      kind: string;
      row_count?: number | null;
      size_kb?: number | null;
      score: number;
      wanted: boolean;
    }[] = [];

    if (cacheFresh) {
      for (const entry of catalogMap.values()) {
        const isWanted =
          wanted.has(`${database}|${entry.schema}|${entry.name}`.toLowerCase()) ||
          wanted.has(`|${entry.schema}|${entry.name}`.toLowerCase());
        if (wanted.size && !exploreMode && !isWanted) continue;
        candidates.push({
          ...entry,
          score:
            scoreObject(database, entry.schema, entry.name, entry.kind, entry.row_count, message, joinMode) +
            (isWanted ? 100 : 0),
          wanted: isWanted,
        });
      }
    } else {
      const push = (items: { schema?: string; name?: string; is_system?: boolean }[], kind: string) => {
        for (const item of items || []) {
          if (item.is_system) continue;
          const schema = String(item.schema || "dbo");
          const name = String(item.name || "");
          if (!name) continue;
          const isWanted =
            wanted.has(`${database}|${schema}|${name}`.toLowerCase()) ||
            wanted.has(`|${schema}|${name}`.toLowerCase());
          if (wanted.size && !exploreMode && !isWanted) continue;
          const stat = catalogMap.get(fkKey(schema, name));
          candidates.push({
            schema,
            name,
            kind,
            row_count: stat?.row_count ?? null,
            size_kb: stat?.size_kb ?? null,
            score: scoreObject(database, schema, name, kind, stat?.row_count, message, joinMode) + (isWanted ? 100 : 0),
            wanted: isWanted,
          });
        }
      };
      push((liveCatalog!.objects.tables || []) as { schema?: string; name?: string; is_system?: boolean }[], "table");
      push((liveCatalog!.objects.views || []) as { schema?: string; name?: string; is_system?: boolean }[], "view");
    }

    const fkLimit = cacheFresh ? foreignKeys.length : exploreMode ? 200 : 80;
    const trimmedForeignKeys = foreignKeys.slice(0, fkLimit);

    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    const pickedNames = new Set<string>();
    for (const item of ranked) {
      if (!item.wanted) continue;
      pickedNames.add(fkKey(item.schema, item.name));
    }
    if (!pickedNames.size && focus.length) {
      for (const item of focus) {
        if ((item.database || database).toLowerCase() !== database.toLowerCase()) continue;
        pickedNames.add(fkKey(item.schema, item.name));
      }
    }

    const rootKeys = new Set<string>();
    for (const key of pickedNames) rootKeys.add(key);
    if (!rootKeys.size && exploreMode) {
      for (const item of ranked.slice(0, 12)) rootKeys.add(fkKey(item.schema, item.name));
    }
    if (joinMode || exploreMode) {
      const expanded = expandFkNeighbors(
        rootKeys,
        trimmedForeignKeys,
        exploreMode ? 4 : 2,
        cacheFresh ? 150 : exploreMode ? 55 : 35,
      );
      for (const key of expanded) pickedNames.add(key);
    }
    if (exploreMode || (joinMode && rootKeys.size)) {
      if (cacheFresh && schemaCache) {
        expandByIdColumnsFromCache(
          schemaCache,
          rootKeys,
          catalogMap,
          pickedNames,
          exploreMode ? 80 : 40,
        );
      } else {
        await expandByIdColumns(client, database, rootKeys, catalogMap, pickedNames, exploreMode ? 40 : 24);
      }
    }
    if (exploreMode) {
      for (const fk of trimmedForeignKeys) {
        if (pickedNames.size >= (cacheFresh ? 150 : 55)) break;
        for (const part of [fk.from, fk.to]) {
          const [schema, name] = part.split(".");
          if (schema && name) pickedNames.add(fkKey(schema, name));
        }
      }
    }

    const limit = cacheFresh
      ? exploreMode
        ? Math.min(150, catalogMap.size)
        : wanted.size
          ? 80
          : 60
      : exploreMode
        ? 55
        : wanted.size
          ? 40
          : joinMode
            ? 30
            : 25;
    if (pickedNames.size < limit) {
      for (const item of ranked) {
        if (pickedNames.size >= limit) break;
        pickedNames.add(fkKey(item.schema, item.name));
      }
    }

    const resolveCandidate = (key: string) => {
      const rankedHit = ranked.find((row) => fkKey(row.schema, row.name) === key);
      if (rankedHit) return rankedHit;
      const cat = catalogMap.get(key);
      if (!cat) return null;
      return {
        ...cat,
        score: 0,
        wanted: wanted.has(`${database}|${cat.schema}|${cat.name}`.toLowerCase()),
      };
    };

    step(
      steps,
      `catalog-${database}`,
      `Catalog · ${database}`,
      `${candidates.length} candidate object(s), ${trimmedForeignKeys.length} FK(s), sending ${pickedNames.size}${cacheFresh ? " · cache" : ""}`,
      dbStarted,
    );

    const objects: AiContextObject[] = [];
    const colStarted = Date.now();
    for (const key of pickedNames) {
      const item = resolveCandidate(key);
      if (!item) continue;
      const cached = cacheTableMap.get(key);
      if (cacheFresh && cached) {
        objects.push({
          database,
          schema: cached.schema,
          name: cached.name,
          kind: cached.kind,
          row_count: cached.row_count,
          size_kb: cached.size_kb,
          pk: cached.pk,
          columns: cached.columns.slice(0, 48).map((col) => ({
            name: col.name,
            type: col.type,
            nullable: col.nullable,
          })),
          sample: cached.sample,
          reason: reasonFor(item.score, item.wanted, joinMode),
        });
        if (cached.sample?.rows?.length) sampleUsed += 1;
        continue;
      }
      let columns: AiColumn[] = [];
      try {
        const cols = await client.listColumns(database, item.schema, item.name);
        columns = cols.slice(0, 48).map((col) => formatColumn(col));
      } catch {
        columns = [];
      }
      let pk: string[] = [];
      if (item.kind === "table") {
        try {
          pk = await client.keyColumns(database, item.schema, item.name);
        } catch {
          pk = [];
        }
      }
      let sample: AiContextObject["sample"];
      if (sampleBudget > 0 && item.kind === "table") {
        try {
          const page = await client.pageTable(database, item.schema, item.name, { pageSize: 3 });
          sample = {
            columns: (page.columns || []).map((name) => String(name)),
            rows: (page.rows || []).slice(0, 3),
          };
          sampleBudget -= 1;
          sampleUsed += 1;
        } catch {
          /* skip sample */
        }
      }
      objects.push({
        database,
        schema: item.schema,
        name: item.name,
        kind: item.kind,
        row_count: item.row_count,
        size_kb: item.size_kb,
        pk,
        columns,
        sample,
        reason: reasonFor(item.score, item.wanted, joinMode),
      });
    }
    const inferredLinks = inferColumnLinks(objects);
    step(
      steps,
      `columns-${database}`,
      `Columns · ${database}`,
      `${objects.length} object(s), ${sampleUsed} sample(s), ${inferredLinks.length} inferred link(s)`,
      colStarted,
    );

    context.push({
      database,
      object_count: objects.length,
      fk_count: trimmedForeignKeys.length,
      objects,
      foreign_keys: exploreMode
        ? trimmedForeignKeys
        : trimmedForeignKeys.filter((fk) => {
            const from = fk.from.split(".")[1];
            const to = fk.to.split(".")[1];
            return objects.some((obj) => obj.name === from) || objects.some((obj) => obj.name === to) || joinMode;
          }),
      inferred_links: inferredLinks,
    });
  }

  if (sampleUsed) {
    step(steps, "samples", "Samples", `${sampleUsed} table(s) with TOP 3 rows`, started);
  }

  return { context, steps };
}

export async function listCatalogIndex(client: SqlServerClient, databases?: string[], cfg?: ConnectionConfig) {
  let dbs = (databases || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (!dbs.length) {
    const all = await client.listDatabases();
    dbs = all
      .filter((row) => !systemDbs().has(String((row as { name?: string }).name || "").toLowerCase()))
      .map((row) => String((row as { name?: string }).name || ""));
  }
  dbs = dbs.slice(0, 8);
  const catalog: AiCatalogItem[] = [];
  for (const database of dbs) {
    const cached = cfg ? readSchemaCache(cfg, database) : null;
    if (cached && isSchemaCacheFresh(cached)) {
      catalog.push(...cacheCatalogItems(cached));
      continue;
    }
    const listed = await client.listObjects(database, true);
    for (const bucket of ["tables", "views"] as const) {
      const kind = bucket === "tables" ? "table" : "view";
      for (const item of (listed.objects[bucket] || []) as {
        schema?: string;
        name?: string;
        is_system?: boolean;
        row_count?: number | null;
      }[]) {
        if (item.is_system) continue;
        const name = String(item.name || "");
        if (!name) continue;
        catalog.push({
          database,
          schema: String(item.schema || "dbo"),
          name,
          kind,
          row_count: item.row_count ?? null,
        });
      }
    }
  }
  return catalog;
}

export async function previewAiContext(client: SqlServerClient, ask: AiAsk, cfg?: ConnectionConfig) {
  const databases = (ask.databases || []).map((name) => String(name || "").trim()).filter(Boolean).slice(0, 8);
  const [catalog, gathered] = await Promise.all([
    listCatalogIndex(client, databases, cfg),
    gatherContext(client, ask, cfg),
  ]);
  return { ...gathered, catalog };
}

function compactContextText(context: AiContextDb[]) {
  const chunks: string[] = [];
  for (const db of context) {
    chunks.push(`## Database: ${db.database} (${db.object_count} objects, ${db.fk_count} FKs)`);
    if (db.foreign_keys.length) {
      chunks.push(
        "Foreign keys:\n" +
          db.foreign_keys
            .slice(0, 100)
            .map((fk) => `- ${fk.from} -> ${fk.to} (${fk.columns.join(", ")})`)
            .join("\n"),
      );
    }
    if (db.inferred_links?.length) {
      chunks.push(
        "Inferred links (id_* column matches another table PK — verify in DB):\n" +
          db.inferred_links
            .slice(0, 60)
            .map((link) => `- ${link.from} -> ${link.to} (${link.columns.join(", ")})`)
            .join("\n"),
      );
    }
    for (const obj of db.objects) {
      const size =
        obj.row_count != null
          ? `${obj.row_count.toLocaleString("en-US")} rows`
          : obj.size_kb != null
            ? `${obj.size_kb} KB`
            : "size unknown";
      const pk = obj.pk?.length ? ` PK: ${obj.pk.join(", ")}` : "";
      chunks.push(
        `### [${db.database}].[${obj.schema}].[${obj.name}] (${obj.kind}, ${size}${pk}, reason: ${obj.reason || "top"})`,
      );
      chunks.push(`Columns: ${obj.columns.map((col) => formatColumnLine(col)).join("; ")}`);
      if (obj.sample?.rows?.length) {
        chunks.push(`Sample rows: ${JSON.stringify(obj.sample.rows)}`);
      }
    }
  }
  return chunks.join("\n\n");
}

function normalizeSql(blocks: string[]) {
  const trimmed = blocks.map((item) => item.trim()).filter(Boolean);
  if (trimmed.length <= 1) return trimmed;

  const first = trimmed[0];
  if (/^(\s*)(SELECT|WITH)\b/i.test(first)) {
    const rest = trimmed.slice(1);
    const fragmentTail = rest.every(
      (block) =>
        SQL_CONTINUATION.test(block) ||
        !/^(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|EXEC)\b/i.test(block),
    );
    if (fragmentTail) return [trimmed.join("\n")];
  }

  const out: string[] = [];
  let buf: string[] = [];
  for (const block of trimmed) {
    if (!buf.length) {
      buf.push(block);
      continue;
    }
    if (SQL_CONTINUATION.test(block) || (!/^(SELECT|WITH)\b/i.test(block) && buf.length)) {
      buf.push(block);
      continue;
    }
    out.push(buf.join("\n"));
    buf = [block];
  }
  if (buf.length) out.push(buf.join("\n"));
  return out.length ? out : trimmed;
}

function parseModelJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(raw) as {
      explanation?: string;
      sql?: string[];
      notes?: string[];
      used_objects?: string[];
    };
    const sql = normalizeSql(
      Array.isArray(parsed.sql) ? parsed.sql.map((item) => String(item || "").trim()).filter(Boolean) : [],
    );
    return {
      explanation: String(parsed.explanation || "").trim() || text,
      sql,
      notes: Array.isArray(parsed.notes) ? parsed.notes.map((item) => String(item || "").trim()).filter(Boolean) : [],
      used_objects: Array.isArray(parsed.used_objects)
        ? parsed.used_objects.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
    };
  } catch {
    const blocks = normalizeSql([...text.matchAll(/```sql\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()));
    return {
      explanation: text.replace(/```[\s\S]*?```/g, "").trim() || text,
      sql: blocks,
      notes: [] as string[],
      used_objects: [] as string[],
    };
  }
}

function knownRefs(context: AiContextDb[]) {
  const set = new Set<string>();
  for (const db of context) {
    for (const obj of db.objects) {
      set.add(`${db.database}.${obj.schema}.${obj.name}`.toLowerCase());
      set.add(`${obj.schema}.${obj.name}`.toLowerCase());
      set.add(obj.name.toLowerCase());
    }
  }
  return set;
}

function validateSql(sqlBlocks: string[], context: AiContextDb[]) {
  const refs = knownRefs(context);
  const warnings: string[] = [];
  const objectPattern = /\[([^\]]+)\]\.\[([^\]]+)\]\.\[([^\]]+)\]/gi;
  const twoPartPattern = /\[([^\]]+)\]\.\[([^\]]+)\]/gi;

  for (const block of sqlBlocks) {
    let match: RegExpExecArray | null;
    objectPattern.lastIndex = 0;
    while ((match = objectPattern.exec(block))) {
      const ref = `${match[1]}.${match[2]}.${match[3]}`.toLowerCase();
      if (!refs.has(ref)) warnings.push(`Unknown object referenced: [${match[1]}].[${match[2]}].[${match[3]}]`);
    }
    twoPartPattern.lastIndex = 0;
    while ((match = twoPartPattern.exec(block))) {
      const ref = `${match[1]}.${match[2]}`.toLowerCase();
      if (block.includes(`[${match[1]}].[${match[2]}].[`)) continue;
      if (!refs.has(ref)) warnings.push(`Unknown object referenced: [${match[1]}].[${match[2]}]`);
    }
  }
  return [...new Set(warnings)];
}

function userPrompt(ask: AiAsk, context: AiContextDb[]) {
  const mode = ask.mode || "query";
  const task =
    mode === "analyze"
      ? "Analyze the SQL the user pasted against the catalog. Explain it, flag mismatches, and improve it if needed."
      : wantsSchemaExplore(String(ask.message || ""), ask.history)
        ? "Map relationships from the focus tables and catalog. Explain FK/inferred links in notes, then write SQL that joins lookup tables for school, program, mentor, etc. Do NOT pick an unrelated table."
        : "Write accurate T-SQL that answers the user request, including JOINs when multiple tables are involved. Return one complete statement in sql[0].";
  return [
    `Mode: ${mode}`,
    `Task: ${task}`,
    ask.message ? `Latest user request: ${ask.message}` : "",
    ask.sql ? `SQL to analyze:\n${ask.sql}` : "",
    compactContextText(context),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function askAi(client: SqlServerClient, ask: AiAsk, cfg?: ConnectionConfig) {
  const mode = ask.mode || "query";
  if (mode === "analyze") {
    if (!(ask.sql || "").trim()) throw new ClientError("Paste SQL to analyze.");
  } else if (!(ask.message || "").trim()) {
    throw new ClientError("Write what you want the AI to do.");
  }

  const { context, steps } = await gatherContext(client, ask, cfg);
  const tables = context.reduce((sum, db) => sum + db.objects.length, 0);
  if (!tables) {
    throw new ClientError("No tables found in the selected databases.");
  }

  const modelStarted = Date.now();
  const status = openaiStatus();
  const chatMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM },
  ];
  for (const item of (ask.history || []).slice(-8)) {
    const text = String(item.text || "").trim();
    if (!text) continue;
    const suffix = item.used_objects?.length ? `\n[objects: ${item.used_objects.join(", ")}]` : "";
    chatMessages.push({
      role: item.role === "user" ? "user" : "assistant",
      content: text + suffix,
    });
  }
  chatMessages.push({ role: "user", content: userPrompt(ask, context) });
  const content = await chatOpenAi(chatMessages, { json: true, temperature: 0.1 });
  step(steps, "model", "OpenAI", status.model, modelStarted);

  const parsed = parseModelJson(content);
  const validateStarted = Date.now();
  const warnings = validateSql(parsed.sql, context);
  if (parsed.used_objects.length) {
    for (const ref of parsed.used_objects) {
      const lower = ref.toLowerCase();
      if (!knownRefs(context).has(lower) && !knownRefs(context).has(lower.split(".").slice(-2).join("."))) {
        warnings.push(`Model cited object not in context: ${ref}`);
      }
    }
  }
  step(
    steps,
    "validate",
    "Validate",
    warnings.length ? `${warnings.length} warning(s)` : "SQL references look consistent",
    validateStarted,
  );

  return {
    explanation: parsed.explanation,
    sql: parsed.sql,
    notes: parsed.notes,
    warnings,
    used_objects: parsed.used_objects,
    context,
    steps,
    model: status.model,
    scanned: context.map((db) => ({
      database: db.database,
      tables: db.objects.length,
      objects: db.objects.map((item) => `${item.schema}.${item.name}`),
    })),
    mode,
  };
}
