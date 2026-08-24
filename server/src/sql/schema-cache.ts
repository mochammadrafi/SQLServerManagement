import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { STORE_DIR } from "../config.js";
import type { ConnectionConfig, SqlServerClient } from "./client.js";

const CACHE_ROOT = join(STORE_DIR, "schema-cache");
const CACHE_VERSION = 1;
const TTL_MS = Number(process.env.SQLSM_SCHEMA_CACHE_TTL_SEC || 86400) * 1000;
const SAMPLE_SIZE = 3;
const SAMPLE_CONCURRENCY = 6;

export type SchemaCacheColumn = {
  name: string;
  type: string;
  nullable?: boolean;
};

export type SchemaCacheTable = {
  schema: string;
  name: string;
  kind: "table" | "view";
  row_count?: number | null;
  size_kb?: number | null;
  pk?: string[];
  columns: SchemaCacheColumn[];
  sample?: { columns: string[]; rows: unknown[][] };
};

export type SchemaCacheForeignKey = {
  from: string;
  to: string;
  columns: string[];
  constraint?: string;
};

export type SchemaCacheEntry = {
  version: typeof CACHE_VERSION;
  database: string;
  built_at: string;
  tables: SchemaCacheTable[];
  foreign_keys: SchemaCacheForeignKey[];
};

export type SchemaCacheStatus = {
  database: string;
  ready: boolean;
  building: boolean;
  built_at?: string;
  age_sec?: number;
  tables: number;
  columns: number;
  samples: number;
  foreign_keys: number;
  progress?: number;
  error?: string | null;
};

type BuildJob = {
  status: "running" | "done" | "error";
  database: string;
  tables_total: number;
  tables_done: number;
  started_at: number;
  error?: string;
};

const BUILD_JOBS = new Map<string, BuildJob>();

function tableKey(schema: string, name: string) {
  return `${schema}.${name}`.toLowerCase();
}

function safeDbName(database: string) {
  return database.replace(/[^A-Za-z0-9_-]+/g, "_");
}

export function connectionCacheKey(cfg: ConnectionConfig) {
  const raw = [
    String(cfg.server || "").trim().toLowerCase(),
    String(cfg.port || 1433),
    String(cfg.instance || "").trim().toLowerCase(),
    String(cfg.auth || "sql"),
    String(cfg.username || "").trim().toLowerCase(),
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function cachePath(cfg: ConnectionConfig, database: string) {
  return join(CACHE_ROOT, connectionCacheKey(cfg), `${safeDbName(database)}.json`);
}

function buildJobKey(cfg: ConnectionConfig, database: string) {
  return `${connectionCacheKey(cfg)}:${database.toLowerCase()}`;
}

function formatColumn(col: { name?: unknown; data_type?: unknown; is_nullable?: unknown }): SchemaCacheColumn {
  return {
    name: String(col.name || ""),
    type: String(col.data_type || "unknown"),
    nullable: String(col.is_nullable || "").toUpperCase() === "YES",
  };
}

export function readSchemaCache(cfg: ConnectionConfig, database: string): SchemaCacheEntry | null {
  const path = cachePath(cfg, database);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as SchemaCacheEntry;
    if (entry.version !== CACHE_VERSION || entry.database.toLowerCase() !== database.toLowerCase()) return null;
    return entry;
  } catch {
    return null;
  }
}

export function isSchemaCacheFresh(entry: SchemaCacheEntry | null) {
  if (!entry?.built_at) return false;
  const age = Date.now() - Date.parse(entry.built_at);
  return Number.isFinite(age) && age >= 0 && age < TTL_MS;
}

function writeSchemaCache(cfg: ConnectionConfig, entry: SchemaCacheEntry) {
  const path = cachePath(cfg, entry.database);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(entry));
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

export function schemaCacheStatus(cfg: ConnectionConfig, database: string): SchemaCacheStatus {
  const job = BUILD_JOBS.get(buildJobKey(cfg, database));
  const entry = readSchemaCache(cfg, database);
  const columns = entry?.tables.reduce((sum, table) => sum + table.columns.length, 0) || 0;
  const samples = entry?.tables.filter((table) => table.sample?.rows?.length).length || 0;
  const ageSec = entry?.built_at ? Math.round((Date.now() - Date.parse(entry.built_at)) / 1000) : undefined;
  return {
    database,
    ready: Boolean(entry && isSchemaCacheFresh(entry)),
    building: job?.status === "running",
    built_at: entry?.built_at,
    age_sec: ageSec,
    tables: entry?.tables.length || 0,
    columns,
    samples,
    foreign_keys: entry?.foreign_keys.length || 0,
    progress:
      job?.status === "running" && job.tables_total
        ? Math.min(100, Math.round((job.tables_done / job.tables_total) * 100))
        : undefined,
    error: job?.status === "error" ? job.error || "build failed" : null,
  };
}

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      out[current] = await worker(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return out;
}

export async function buildSchemaCache(cfg: ConnectionConfig, client: SqlServerClient, database: string) {
  const jobKey = buildJobKey(cfg, database);
  const existing = BUILD_JOBS.get(jobKey);
  if (existing?.status === "running") return readSchemaCache(cfg, database);

  const job: BuildJob = {
    status: "running",
    database,
    tables_total: 0,
    tables_done: 0,
    started_at: Date.now(),
  };
  BUILD_JOBS.set(jobKey, job);

  try {
    const [catalog, foreignKeys, allColumns] = await Promise.all([
      client.listObjects(database, true),
      client.listForeignKeys(database),
      client.listAllColumns(database),
    ]);

    const groupedFk = new Map<string, SchemaCacheForeignKey>();
    for (const row of foreignKeys) {
      const fromSchema = String(row.from_schema || "dbo");
      const fromTable = String(row.from_table || "");
      const toSchema = String(row.to_schema || "dbo");
      const toTable = String(row.to_table || "");
      const fromColumn = String(row.from_column || "");
      if (!fromTable || !toTable || !fromColumn) continue;
      const from = `${fromSchema}.${fromTable}`;
      const to = `${toSchema}.${toTable}`;
      const key = `${from}->${to}:${String(row.constraint_name || "")}`;
      const hit = groupedFk.get(key) || { from, to, columns: [], constraint: String(row.constraint_name || "") };
      hit.columns.push(`${fromColumn}->${String(row.to_column || "")}`);
      groupedFk.set(key, hit);
    }

    const columnsByTable = new Map<string, SchemaCacheColumn[]>();
    for (const col of allColumns) {
      const schema = String(col.table_schema || "dbo");
      const table = String(col.table_name || "");
      const key = tableKey(schema, table);
      const list = columnsByTable.get(key) || [];
      list.push(formatColumn(col));
      columnsByTable.set(key, list);
    }

    const tables: SchemaCacheTable[] = [];
    for (const bucket of ["tables", "views"] as const) {
      const kind = bucket === "tables" ? "table" : "view";
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
        tables.push({
          schema,
          name,
          kind,
          row_count: item.row_count ?? null,
          size_kb: item.size_kb ?? null,
          columns: columnsByTable.get(tableKey(schema, name)) || [],
        });
      }
    }

    job.tables_total = tables.length;

    await mapPool(tables, SAMPLE_CONCURRENCY, async (table) => {
      try {
        table.pk = table.kind === "table" ? await client.keyColumns(database, table.schema, table.name) : [];
      } catch {
        table.pk = [];
      }
      if (table.kind === "table") {
        try {
          const page = await client.pageTable(database, table.schema, table.name, { pageSize: SAMPLE_SIZE });
          table.sample = {
            columns: (page.columns || []).map((name) => String(name)),
            rows: (page.rows || []).slice(0, SAMPLE_SIZE),
          };
        } catch {
          /* skip sample */
        }
      }
      job.tables_done += 1;
    });

    const entry: SchemaCacheEntry = {
      version: CACHE_VERSION,
      database,
      built_at: new Date().toISOString(),
      tables,
      foreign_keys: [...groupedFk.values()],
    };
    writeSchemaCache(cfg, entry);
    job.status = "done";
    return entry;
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function startSchemaCacheBuild(cfg: ConnectionConfig, client: SqlServerClient, databases: string[]) {
  const unique = [...new Set(databases.map((name) => String(name || "").trim()).filter(Boolean))];
  for (const database of unique) {
    void buildSchemaCache(cfg, client, database).catch(() => undefined);
  }
  return unique.map((database) => schemaCacheStatus(cfg, database));
}

export function listSchemaCacheStatuses(cfg: ConnectionConfig, databases: string[]) {
  return databases.map((database) => schemaCacheStatus(cfg, database));
}

export function cacheCatalogItems(entry: SchemaCacheEntry) {
  return entry.tables.map((table) => ({
    database: entry.database,
    schema: table.schema,
    name: table.name,
    kind: table.kind,
    row_count: table.row_count ?? null,
  }));
}
