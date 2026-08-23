import { createWriteStream, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { settings } from "../config.js";
import { ClientError } from "../errors.js";
import { type ConnectionConfig, SqlServerClient, connectClient } from "./client.js";
import { csvValue } from "./ident.js";
import { ensureWritableDir, safeName } from "./fs.js";

type JobStatus = "queued" | "running" | "paused" | "cancelling" | "cancelled" | "error" | "done";

export type JobPublic = {
  id: string;
  status: JobStatus;
  database: string;
  schema: string;
  table: string;
  kind: string;
  folder: string;
  rows_written: number;
  bytes_written: number;
  row_count_estimate: number | null;
  parts: { name: string; rows?: number; bytes?: number }[];
  error?: string | null;
  hint?: string | null;
  started_at?: string;
  finished_at?: string;
  tables_total?: number | null;
  tables_done?: number | null;
  current_object?: string | null;
  can_pause?: boolean;
  can_resume?: boolean;
  can_cancel?: boolean;
  gzip?: boolean;
  workers?: number;
  columns?: string[];
  where?: string;
};

type Job = {
  id: string;
  sid: string;
  cfg: ConnectionConfig;
  kind: "export" | "export_db" | "backup";
  status: JobStatus;
  database: string;
  schema: string;
  table: string;
  columns: string[];
  where: string;
  folder: string;
  gzip: boolean;
  nolock: boolean;
  chunkRows: number;
  chunkBytes: number;
  batchSize: number;
  filePrefix: string;
  workers: number;
  rowsWritten: number;
  bytesWritten: number;
  rowCountEstimate: number | null;
  parts: { name: string; rows: number; bytes: number; path: string }[];
  tables: { schema: string; name: string; status?: string; rows_written?: number }[];
  tablesDone: number;
  error: string | null;
  hint: string | null;
  startedAt: string;
  finishedAt: string;
  lastKey: Record<string, unknown> | null;
  keys: string[];
  pause: boolean;
  cancel: boolean;
  skip: Set<string>;
  current?: string;
};

const JOBS = new Map<string, Job>();

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function jobFolder(root: string, name: string) {
  const dest = join(ensureWritableDir(root), `${safeName(name)}-${randomBytes(3).toString("hex")}`);
  mkdirSync(dest, { recursive: true });
  return dest;
}

export function publicJob(job: Job): JobPublic {
  const folder = job.folder.replace(/[\\/]+$/, "");
  return {
    id: job.id,
    status: job.status,
    database: job.database,
    schema: job.schema,
    table: job.table,
    kind: job.kind,
    folder: folder.split(/[\\/]/).pop() || "",
    rows_written: job.rowsWritten,
    bytes_written: job.bytesWritten,
    row_count_estimate: job.rowCountEstimate,
    parts: job.parts.map((part) => ({ name: part.name, rows: part.rows, bytes: part.bytes })),
    error: job.error,
    hint: job.hint,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    tables_total: job.kind === "export_db" ? job.tables.length : null,
    tables_done: job.tablesDone,
    current_object: job.current || null,
    can_pause: job.kind !== "backup" && ["queued", "running"].includes(job.status),
    can_resume:
      job.status === "paused" ||
      (job.kind !== "backup" && ["error", "cancelled"].includes(job.status) && Boolean(job.lastKey || job.parts.length)),
    can_cancel: ["queued", "running", "paused", "cancelling"].includes(job.status),
    gzip: job.gzip,
    workers: job.workers,
    columns: job.columns,
    where: job.where,
  };
}

function saveMeta(job: Job) {
  writeFileSync(join(job.folder, "meta.json"), JSON.stringify(publicJob(job), null, 2));
}

export function exportLimits() {
  return {
    max_workers: settings.maxWorkers,
    max_jobs: settings.maxJobs,
    max_total_workers: settings.maxWorkers,
    batch_size: settings.defaultBatch,
    min_batch_size: 500,
    max_batch_size: 100000,
  };
}

export function listJobs(sid: string) {
  return [...JOBS.values()].filter((job) => job.sid === sid).map(publicJob);
}

export function getJob(sid: string, id: string) {
  const job = JOBS.get(id);
  if (!job || job.sid !== sid) throw new ClientError("Export job not found.");
  return job;
}

export function jobPartPath(sid: string, id: string, name: string) {
  const job = getJob(sid, id);
  const part = job.parts.find((item) => item.name === name);
  if (!part || !existsSync(part.path)) throw new ClientError("Export file not found.");
  return part.path;
}

function waitIfPaused(job: Job) {
  return new Promise<void>((resolve) => {
    const tick = () => {
      if (!job.pause || job.cancel) return resolve();
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function writeCsvPart(
  job: Job,
  client: SqlServerClient,
  schema: string,
  table: string,
  columns: string[],
  prefix: string,
) {
  let partIndex = job.parts.length + 1;
  let rowsInPart = 0;
  let bytesInPart = 0;
  const ext = job.gzip ? ".csv.gz" : ".csv";
  const openPart = () => {
    const name = `${safeName(prefix)}-part-${String(partIndex).padStart(5, "0")}${ext}`;
    const path = join(job.folder, name);
    const file = createWriteStream(path);
    const gzip = job.gzip ? createGzip() : null;
    if (gzip) gzip.pipe(file);
    const header = `${columns.join(",")}\n`;
    const target = gzip || file;
    target.write(header);
    bytesInPart = Buffer.byteLength(header);
    rowsInPart = 0;
    return { name, path, file, gzip, target };
  };
  let current = openPart();
  const rotate = () => {
    current.target.end();
    job.parts.push({ name: current.name, rows: rowsInPart, bytes: bytesInPart, path: current.path });
    partIndex += 1;
    current = openPart();
  };
  for await (const batch of client.iterTableRows(job.database, schema, table, columns, {
    where: job.where,
    orderKeys: job.keys,
    nolock: job.nolock,
    batchSize: job.batchSize,
    after: job.lastKey,
    shouldStop: () => job.cancel || job.skip.has(`${schema}\0${table}`),
  })) {
    await waitIfPaused(job);
    if (job.cancel || job.skip.has(`${schema}\0${table}`)) break;
    for (const row of batch) {
      const line = `${row.map((value) => {
        const text = String(csvValue(value));
        return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      }).join(",")}\n`;
      const size = Buffer.byteLength(line);
      if (
        (job.chunkRows && rowsInPart >= job.chunkRows) ||
        (job.chunkBytes && bytesInPart + size >= job.chunkBytes)
      ) {
        rotate();
      }
      current.target.write(line);
      rowsInPart += 1;
      bytesInPart += size;
      job.rowsWritten += 1;
      job.bytesWritten += size;
      if (job.keys.length) {
        job.lastKey = Object.fromEntries(job.keys.map((key, index) => [key, row[columns.indexOf(key)] ?? row[index]]));
      }
    }
    saveMeta(job);
  }
  current.target.end();
  if (rowsInPart || !job.parts.length) {
    job.parts.push({ name: current.name, rows: rowsInPart, bytes: bytesInPart, path: current.path });
  }
}

async function runExport(job: Job) {
  job.status = "running";
  job.startedAt = job.startedAt || now();
  saveMeta(job);
  const client = await connectClient(job.cfg);
  try {
    if (job.kind === "backup") {
      job.current = job.database;
      const file = join(job.folder, `${safeName(job.database)}.bak`);
      const compress = job.gzip ? ", COMPRESSION" : "";
      await client.execute(
        `BACKUP DATABASE ${job.database.includes("[") ? job.database : `[${job.database}]`} TO DISK = N'${file.replaceAll("'", "''")}' WITH INIT${compress}`,
        { maxRows: 1 },
      );
      job.parts.push({ name: `${safeName(job.database)}.bak`, rows: 0, bytes: 0, path: file });
    } else if (job.kind === "export_db") {
      for (const table of job.tables) {
        if (job.cancel) break;
        if (job.skip.has(`${table.schema}\0${table.name}`)) continue;
        await waitIfPaused(job);
        job.current = `${table.schema}.${table.name}`;
        table.status = "running";
        const cols = await client.listColumns(job.database, table.schema, table.name);
        const names = cols.map((col) => String(col.name || "")).filter(Boolean);
        const stats = await client.tableStats(job.database, table.schema, table.name);
        job.keys = stats.keys;
        await writeCsvPart(job, client, table.schema, table.name, names, `${table.schema}.${table.name}`);
        table.status = job.cancel ? "cancelled" : "done";
        job.tablesDone += 1;
        saveMeta(job);
      }
    } else {
      job.current = `${job.schema}.${job.table}`;
      await writeCsvPart(job, client, job.schema, job.table, job.columns, job.filePrefix);
    }
    job.status = job.cancel ? "cancelled" : "done";
  } catch (exc) {
    job.status = job.cancel ? "cancelled" : "error";
    job.error = exc instanceof Error ? exc.message : String(exc);
    job.hint = exc instanceof ClientError ? exc.hint || null : null;
  } finally {
    job.finishedAt = now();
    job.current = undefined;
    saveMeta(job);
    await client.close();
  }
}

function register(sid: string, job: Job) {
  const active = [...JOBS.values()].filter((item) => item.sid === sid && ["queued", "running", "paused"].includes(item.status));
  if (active.length >= settings.maxJobs) {
    throw new ClientError("Too many concurrent jobs.");
  }
  JOBS.set(job.id, job);
  void runExport(job);
  return job;
}

export async function startExport(
  sid: string,
  cfg: ConnectionConfig,
  body: {
    database: string;
    schema: string;
    table: string;
    columns?: string[];
    where?: string;
    chunk_rows?: number;
    chunk_bytes?: number;
    gzip?: boolean;
    nolock?: boolean;
    folder?: string;
    batch_size?: number;
    file_name?: string;
  },
) {
  const probe = await connectClient(cfg);
  try {
    const allowed = (await probe.listColumns(body.database, body.schema, body.table)).map((col) => String(col.name || ""));
    const map = new Map(allowed.map((name) => [name.toLowerCase(), name]));
    const picked = (body.columns?.length ? body.columns : allowed)
      .map((name) => map.get(String(name).toLowerCase()))
      .filter(Boolean) as string[];
    if (!picked.length) throw new ClientError("Pick at least one column.");
    const stats = await probe.tableStats(body.database, body.schema, body.table);
    const dest = jobFolder(body.folder || settings.exportDir, body.table);
    const job: Job = {
      id: randomBytes(8).toString("hex"),
      sid,
      cfg,
      kind: "export",
      status: "queued",
      database: body.database,
      schema: body.schema,
      table: body.table,
      columns: picked,
      where: body.where || "",
      folder: dest,
      gzip: body.gzip !== false,
      nolock: body.nolock !== false,
      chunkRows: Number(body.chunk_rows || 0),
      chunkBytes: Number(body.chunk_bytes || 0),
      batchSize: Number(body.batch_size || settings.defaultBatch),
      filePrefix: body.file_name || body.table,
      workers: 1,
      rowsWritten: 0,
      bytesWritten: 0,
      rowCountEstimate: stats.row_count,
      parts: [],
      tables: [],
      tablesDone: 0,
      error: null,
      hint: null,
      startedAt: "",
      finishedAt: "",
      lastKey: null,
      keys: stats.keys,
      pause: false,
      cancel: false,
      skip: new Set(),
    };
    return publicJob(register(sid, job));
  } finally {
    await probe.close();
  }
}

export async function startDatabaseExport(
  sid: string,
  cfg: ConnectionConfig,
  body: {
    database: string;
    tables?: { schema: string; name: string }[];
    include_views?: boolean;
    gzip?: boolean;
    nolock?: boolean;
    folder?: string;
    workers?: number;
    chunk_rows?: number;
    chunk_bytes?: number;
    batch_size?: number;
    file_name?: string;
  },
) {
  const probe = await connectClient(cfg);
  try {
    const catalog = await probe.listObjects(body.database, true);
    const available = [
      ...(catalog.objects.tables || []),
      ...(body.include_views ? catalog.objects.views || [] : []),
    ];
    const byKey = new Map(available.map((item) => [`${item.schema}\0${item.name}`, item]));
    const picked = body.tables?.length
      ? body.tables.map((item) => {
          const found = byKey.get(`${item.schema}\0${item.name}`);
          if (!found) throw new ClientError(`Table not found: ${item.schema}.${item.name}`);
          return found;
        })
      : available.filter((item) => !item.is_system);
    if (!picked.length) throw new ClientError("No tables to export.");
    const dest = jobFolder(body.folder || settings.exportDir, body.database);
    const job: Job = {
      id: randomBytes(8).toString("hex"),
      sid,
      cfg,
      kind: "export_db",
      status: "queued",
      database: body.database,
      schema: "",
      table: body.database,
      columns: [],
      where: "",
      folder: dest,
      gzip: body.gzip !== false,
      nolock: body.nolock !== false,
      chunkRows: Number(body.chunk_rows || 0),
      chunkBytes: Number(body.chunk_bytes || 0),
      batchSize: Number(body.batch_size || settings.defaultBatch),
      filePrefix: body.file_name || "",
      workers: Number(body.workers || 3),
      rowsWritten: 0,
      bytesWritten: 0,
      rowCountEstimate: picked.reduce((sum, item) => sum + Number(item.row_count || 0), 0),
      parts: [],
      tables: picked.map((item) => ({ schema: String(item.schema), name: String(item.name), status: "queued" })),
      tablesDone: 0,
      error: null,
      hint: null,
      startedAt: "",
      finishedAt: "",
      lastKey: null,
      keys: [],
      pause: false,
      cancel: false,
      skip: new Set(),
    };
    return publicJob(register(sid, job));
  } finally {
    await probe.close();
  }
}

export async function startBackup(
  sid: string,
  cfg: ConnectionConfig,
  body: { database: string; folder?: string; compress?: boolean; chunk_bytes?: number },
) {
  const dest = jobFolder(body.folder || settings.exportDir, body.database);
  const job: Job = {
    id: randomBytes(8).toString("hex"),
    sid,
    cfg,
    kind: "backup",
    status: "queued",
    database: body.database,
    schema: "",
    table: body.database,
    columns: [],
    where: "",
    folder: dest,
    gzip: body.compress !== false,
    nolock: true,
    chunkRows: 0,
    chunkBytes: Number(body.chunk_bytes || 0),
    batchSize: settings.defaultBatch,
    filePrefix: body.database,
    workers: 1,
    rowsWritten: 0,
    bytesWritten: 0,
    rowCountEstimate: null,
    parts: [],
    tables: [],
    tablesDone: 0,
    error: null,
    hint: null,
    startedAt: "",
    finishedAt: "",
    lastKey: null,
    keys: [],
    pause: false,
    cancel: false,
    skip: new Set(),
  };
  return publicJob(register(sid, job));
}

export function cancelJob(sid: string, id: string) {
  const job = getJob(sid, id);
  job.cancel = true;
  job.pause = false;
  if (["queued", "running", "paused"].includes(job.status)) job.status = "cancelling";
  saveMeta(job);
  return publicJob(job);
}

export function pauseJob(sid: string, id: string) {
  const job = getJob(sid, id);
  if (job.kind === "backup") throw new ClientError("Backup cannot be paused.");
  if (!["queued", "running"].includes(job.status)) throw new ClientError("Job cannot be paused.");
  job.pause = true;
  job.status = "paused";
  saveMeta(job);
  return publicJob(job);
}

export function resumeJob(sid: string, id: string, cfg?: ConnectionConfig) {
  const job = getJob(sid, id);
  if (cfg) job.cfg = cfg;
  job.pause = false;
  job.cancel = false;
  if (["paused", "error", "cancelled"].includes(job.status)) {
    job.status = "queued";
    job.error = null;
    void runExport(job);
  }
  saveMeta(job);
  return publicJob(job);
}

export function skipCurrent(sid: string, id: string, schema: string, name: string) {
  const job = getJob(sid, id);
  if (job.kind !== "export_db") return cancelJob(sid, id);
  if (!name) throw new ClientError("Invalid table to skip.");
  job.skip.add(`${schema}\0${name}`);
  return publicJob(job);
}
