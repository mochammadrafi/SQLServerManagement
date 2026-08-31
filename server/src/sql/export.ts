import { createWriteStream, mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync, chmodSync, statSync } from "node:fs";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { settings, STORE_DIR } from "../config.js";
import { ClientError } from "../errors.js";
import { type ConnectionConfig, SqlServerClient, connectClient } from "./client.js";
import { csvValue, qident, validateWhere } from "./ident.js";
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

type ExportTableState = {
  schema: string;
  name: string;
  status?: string;
  rows_written?: number;
  last_key?: Record<string, unknown> | null;
  keys?: string[];
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
  tables: ExportTableState[];
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
  backupFiles?: string[];
};

type JobSnapshot = {
  id: string;
  sid: string;
  kind: Job["kind"];
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
  tables: ExportTableState[];
  tablesDone: number;
  error: string | null;
  hint: string | null;
  startedAt: string;
  finishedAt: string;
  backupFiles?: string[];
  lastKey?: Record<string, unknown> | null;
  keys?: string[];
  skip?: string[];
};

const JOBS = new Map<string, Job>();
const PERSISTED = new Map<string, JobSnapshot>();
const ACTIVE_RUNS = new Set<string>();
const JOB_STORE_DIR = join(STORE_DIR, "export-jobs");
const CHECKPOINT_ROWS = 500;
const PART_FILE = /_part-\d+\.csv(\.gz)?$/i;

function createJobLock() {
  let tail = Promise.resolve();
  return {
    run<T>(fn: () => T | Promise<T>): Promise<T> {
      const run = tail.then(() => fn());
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

type JobLock = ReturnType<typeof createJobLock>;

function partNumber(name: string, prefix: string) {
  const base = safeName(prefix);
  const marker = `${base}_part-`;
  if (!name.startsWith(marker)) return 0;
  const num = Number.parseInt(name.slice(marker.length).split(".")[0] || "", 10);
  return Number.isFinite(num) ? num : 0;
}

function nextPartIndex(job: Job, prefix: string, scanDisk = false) {
  let max = 0;
  for (const part of job.parts) {
    max = Math.max(max, partNumber(part.name, prefix));
  }
  if (scanDisk) {
    try {
      for (const name of readdirSync(job.folder)) {
        max = Math.max(max, partNumber(name, prefix));
      }
    } catch {
      /* folder missing */
    }
  }
  return max + 1;
}

function adoptFolderParts(parts: Job["parts"], folder: string) {
  const known = new Set(parts.map((part) => part.name));
  let added = false;
  try {
    for (const name of readdirSync(folder)) {
      if (known.has(name) || !PART_FILE.test(name)) continue;
      const path = join(folder, name);
      if (!existsSync(path)) continue;
      let bytes = 0;
      try {
        bytes = statSync(path).size;
      } catch {
        continue;
      }
      parts.push({ name, rows: 0, bytes, path });
      known.add(name);
      added = true;
    }
  } catch {
    /* folder missing */
  }
  if (added) parts.sort((a, b) => a.name.localeCompare(b.name));
  return added;
}

function endPartStreams(
  gzip: ReturnType<typeof createGzip> | null,
  file: ReturnType<typeof createWriteStream>,
) {
  return new Promise<void>((resolve, reject) => {
    if (file.destroyed || file.writableEnded) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    file.once("error", fail);
    file.once("finish", finish);
    if (gzip) {
      gzip.once("error", fail);
      gzip.end();
    } else {
      file.end();
    }
  });
}

async function writeStream(stream: NodeJS.WritableStream, data: string) {
  if (stream.write(data)) return;
  await Promise.race([
    once(stream, "drain"),
    once(stream, "error").then((args) => {
      throw args[0];
    }),
  ]);
}

function migrateLegacyTableKeys(job: Job) {
  if (job.kind !== "export_db" || !job.lastKey) return;
  const open = job.tables.filter(
    (table) =>
      table.status !== "done" &&
      table.status !== "cancelled" &&
      !job.skip.has(`${table.schema}\0${table.name}`),
  );
  if (open.some((table) => table.last_key)) return;
  const running = open.filter((table) => table.status === "running");
  const target = running.length === 1 ? running[0] : open.length === 1 ? open[0] : null;
  if (!target) return;
  target.last_key = job.lastKey;
  if (job.keys.length) target.keys = [...job.keys];
}

function pickNextTable(job: Job): ExportTableState | null {
  for (const table of job.tables) {
    if (job.skip.has(`${table.schema}\0${table.name}`)) continue;
    if (table.status === "done" || table.status === "cancelled" || table.status === "running") continue;
    return table;
  }
  return null;
}

function refreshCurrentObject(job: Job) {
  const labels = job.tables.filter((table) => table.status === "running").map((table) => `${table.schema}.${table.name}`);
  if (!labels.length) {
    job.current = undefined;
    return;
  }
  job.current = labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 3).join(", ")} +${labels.length - 3}`;
}

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function jobStamp() {
  const d = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function exportDestFolder(root: string, name: string) {
  const base = ensureWritableDir(root || settings.exportDir);
  const dest = join(base, `${safeName(name)}_${jobStamp()}`);
  mkdirSync(dest, { recursive: true });
  return dest;
}

function clampBatchSize(value: number) {
  const limits = exportLimits();
  return Math.min(limits.max_batch_size, Math.max(limits.min_batch_size, Math.trunc(value || limits.batch_size)));
}

function normalizeChunks(chunkRows: number, chunkBytes: number) {
  let rows = Math.max(0, Math.trunc(chunkRows || 0));
  let bytes = Math.max(0, Math.trunc(chunkBytes || 0));
  if (rows > 5_000_000) rows = 5_000_000;
  if (bytes && bytes < 64 * 1024 * 1024) {
    throw new ClientError("Split size is too small.", "Minimum 64 MB to avoid thousands of tiny files.");
  }
  return { chunkRows: rows, chunkBytes: bytes };
}

function canResumeStatus(status: JobStatus) {
  return ["paused", "error", "cancelled"].includes(status);
}

function publicJobFromSnapshot(snap: JobSnapshot): JobPublic {
  adoptFolderParts(snap.parts, snap.folder);
  const folder = snap.folder.replace(/[\\/]+$/, "");
  return {
    id: snap.id,
    status: snap.status,
    database: snap.database,
    schema: snap.schema,
    table: snap.table,
    kind: snap.kind,
    folder: folder.split(/[\\/]/).pop() || "",
    rows_written: snap.rowsWritten,
    bytes_written: snap.bytesWritten,
    row_count_estimate: snap.rowCountEstimate,
    parts: snap.parts.map((part) => ({ name: part.name, rows: part.rows, bytes: part.bytes })),
    error: snap.error,
    hint: snap.hint,
    started_at: snap.startedAt,
    finished_at: snap.finishedAt,
    tables_total: snap.kind === "export_db" ? snap.tables.length : null,
    tables_done: snap.tablesDone,
    current_object: undefined,
    can_pause: false,
    can_resume: canResumeStatus(snap.status),
    can_cancel: false,
    gzip: snap.gzip,
    workers: snap.workers,
    columns: snap.columns,
    where: snap.where,
  };
}

function snapshotFromJob(job: Job): JobSnapshot {
  return {
    id: job.id,
    sid: job.sid,
    kind: job.kind,
    status: job.status,
    database: job.database,
    schema: job.schema,
    table: job.table,
    columns: job.columns,
    where: job.where,
    folder: job.folder,
    gzip: job.gzip,
    nolock: job.nolock,
    chunkRows: job.chunkRows,
    chunkBytes: job.chunkBytes,
    batchSize: job.batchSize,
    filePrefix: job.filePrefix,
    workers: job.workers,
    rowsWritten: job.rowsWritten,
    bytesWritten: job.bytesWritten,
    rowCountEstimate: job.rowCountEstimate,
    parts: job.parts.map((part) => ({ ...part })),
    tables: job.tables.map((table) => ({ ...table })),
    tablesDone: job.tablesDone,
    error: job.error,
    hint: job.hint,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    backupFiles: job.backupFiles ? [...job.backupFiles] : undefined,
    lastKey: job.lastKey,
    keys: [...job.keys],
    skip: [...job.skip],
  };
}

function hydrateJob(snap: JobSnapshot, cfg: ConnectionConfig): Job {
  const job: Job = {
    id: snap.id,
    sid: snap.sid,
    cfg,
    kind: snap.kind,
    status: snap.status,
    database: snap.database,
    schema: snap.schema,
    table: snap.table,
    columns: [...snap.columns],
    where: snap.where,
    folder: snap.folder,
    gzip: snap.gzip,
    nolock: snap.nolock,
    chunkRows: snap.chunkRows,
    chunkBytes: snap.chunkBytes,
    batchSize: snap.batchSize,
    filePrefix: snap.filePrefix,
    workers: snap.workers,
    rowsWritten: snap.rowsWritten,
    bytesWritten: snap.bytesWritten,
    rowCountEstimate: snap.rowCountEstimate,
    parts: snap.parts.map((part) => ({ ...part })),
    tables: snap.tables.map((table) => ({ ...table })),
    tablesDone: snap.tablesDone,
    error: snap.error,
    hint: snap.hint,
    startedAt: snap.startedAt,
    finishedAt: snap.finishedAt,
    lastKey: snap.lastKey ?? null,
    keys: [...(snap.keys || [])],
    pause: false,
    cancel: false,
    skip: new Set(snap.skip || []),
    backupFiles: snap.backupFiles ? [...snap.backupFiles] : undefined,
  };
  migrateLegacyTableKeys(job);
  adoptFolderParts(job.parts, job.folder);
  return job;
}

function persistJob(job: Job) {
  const snap = snapshotFromJob(job);
  mkdirSync(JOB_STORE_DIR, { recursive: true });
  const path = join(JOB_STORE_DIR, `${snap.id}.json`);
  writeFileSync(path, JSON.stringify(snap));
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
  PERSISTED.set(snap.id, snap);
}

function loadPersistedJobs() {
  mkdirSync(JOB_STORE_DIR, { recursive: true });
  for (const name of readdirSync(JOB_STORE_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      const snap = JSON.parse(readFileSync(join(JOB_STORE_DIR, name), "utf8")) as JobSnapshot;
      if (!snap?.id) continue;
      if (["running", "queued", "paused", "cancelling"].includes(snap.status)) {
        snap.status = "error";
        snap.error = "Server restarted while this job was active.";
        snap.hint = "Use Retry to continue from the last saved progress.";
        snap.finishedAt = snap.finishedAt || now();
        writeFileSync(join(JOB_STORE_DIR, `${snap.id}.json`), JSON.stringify(snap));
      }
      PERSISTED.set(snap.id, snap);
    } catch {
      /* ignore corrupt snapshot */
    }
  }
}

function findJob(sid: string, id: string) {
  const live = JOBS.get(id);
  if (live?.sid === sid) return { live, snap: snapshotFromJob(live) };
  const snap = PERSISTED.get(id);
  if (snap?.sid === sid) return { live: undefined, snap };
  throw new ClientError("Export job not found.");
}

function publicJobLive(job: Job): JobPublic {
  adoptFolderParts(job.parts, job.folder);
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
    can_resume: canResumeStatus(job.status),
    can_cancel: ["queued", "running", "paused", "cancelling"].includes(job.status),
    gzip: job.gzip,
    workers: job.workers,
    columns: job.columns,
    where: job.where,
  };
}

export function publicJob(job: Job): JobPublic {
  return publicJobLive(job);
}

function saveMeta(job: Job) {
  writeFileSync(join(job.folder, "meta.json"), JSON.stringify(publicJob(job), null, 2));
  persistJob(job);
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
  const seen = new Set<string>();
  const rows: JobPublic[] = [];
  for (const job of JOBS.values()) {
    if (job.sid !== sid) continue;
    seen.add(job.id);
    rows.push(publicJob(job));
  }
  for (const snap of PERSISTED.values()) {
    if (snap.sid !== sid || seen.has(snap.id)) continue;
    rows.push(publicJobFromSnapshot(snap));
  }
  return rows.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
}

export function getJobPublic(sid: string, id: string) {
  const hit = findJob(sid, id);
  return hit.live ? publicJob(hit.live) : publicJobFromSnapshot(hit.snap!);
}

export function getJob(sid: string, id: string) {
  const job = JOBS.get(id);
  if (!job || job.sid !== sid) throw new ClientError("Export job not found.");
  return job;
}

export function jobPartPath(sid: string, id: string, name: string) {
  const hit = findJob(sid, id);
  const parts = hit.live?.parts || hit.snap?.parts || [];
  const part = parts.find((item) => item.name === name);
  if (part && existsSync(part.path)) return part.path;
  const folder = hit.live?.folder || hit.snap?.folder;
  if (folder && PART_FILE.test(name) && !/[\\/]/.test(name)) {
    const fallback = join(folder, name);
    if (existsSync(fallback)) return fallback;
  }
  throw new ClientError("Export file not found.");
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
  opts: {
    lock?: JobLock;
    tableEntry?: ExportTableState;
    orderKeys: string[];
    startKey?: Record<string, unknown> | null;
  },
) {
  const lock = opts.lock;
  const tableEntry = opts.tableEntry;
  const orderKeys = opts.orderKeys;
  let lastKey = opts.startKey ?? null;
  const scanDisk = Boolean(opts.startKey) || job.parts.length > 0;
  if (lock) await lock.run(() => adoptFolderParts(job.parts, job.folder));
  else adoptFolderParts(job.parts, job.folder);
  let partIndex = lock
    ? await lock.run(() => nextPartIndex(job, prefix, scanDisk))
    : nextPartIndex(job, prefix, scanDisk);
  let rowsInPart = 0;
  let bytesInPart = 0;
  let rowsSinceCheckpoint = 0;
  let tableRows = 0;
  const ext = job.gzip ? ".csv.gz" : ".csv";
  const openPart = () => {
    const name = `${safeName(prefix)}_part-${String(partIndex).padStart(5, "0")}${ext}`;
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
  let finalized = false;
  const pushPart = async () => {
    const part = { name: current.name, rows: rowsInPart, bytes: bytesInPart, path: current.path };
    const apply = () => {
      const existing = job.parts.find((item) => item.name === part.name);
      if (existing) {
        existing.rows = part.rows;
        existing.bytes = part.bytes;
        existing.path = part.path;
      } else {
        job.parts.push(part);
      }
    };
    if (lock) await lock.run(apply);
    else apply();
  };
  const finalizeCurrent = async () => {
    if (finalized) return;
    finalized = true;
    try {
      await endPartStreams(current.gzip, current.file);
    } catch {
      /* still register the file so it does not vanish from the job */
    }
    if (rowsInPart || !job.parts.length) await pushPart();
  };
  const rotate = async () => {
    await finalizeCurrent();
    partIndex += 1;
    current = openPart();
    finalized = false;
  };
  const checkpoint = async (force = false) => {
    if (!force && rowsSinceCheckpoint < CHECKPOINT_ROWS) return;
    rowsSinceCheckpoint = 0;
    const snapshotKey = lastKey;
    const flush = () => {
      if (tableEntry) {
        tableEntry.last_key = snapshotKey;
        tableEntry.keys = [...orderKeys];
        tableEntry.rows_written = tableRows;
      }
      job.lastKey = snapshotKey;
      job.keys = [...orderKeys];
      saveMeta(job);
    };
    if (lock) await lock.run(flush);
    else flush();
  };
  try {
    for await (const batch of client.iterTableRows(job.database, schema, table, columns, {
      where: job.where,
      orderKeys,
      nolock: job.nolock,
      batchSize: job.batchSize,
      after: lastKey,
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
          await rotate();
        }
        await writeStream(current.target, line);
        rowsInPart += 1;
        bytesInPart += size;
        tableRows += 1;
        rowsSinceCheckpoint += 1;
        const applyCounts = () => {
          job.rowsWritten += 1;
          job.bytesWritten += size;
        };
        if (lock) await lock.run(applyCounts);
        else applyCounts();
        if (orderKeys.length) {
          lastKey = Object.fromEntries(
            orderKeys.map((key) => {
              const index = columns.indexOf(key);
              return [key, index >= 0 ? row[index] : undefined];
            }),
          );
        }
        await checkpoint();
      }
      await checkpoint(true);
    }
  } finally {
    await finalizeCurrent();
    if (tableEntry) {
      const done = () => {
        tableEntry.rows_written = tableRows;
        tableEntry.last_key = lastKey;
      };
      if (lock) await lock.run(done);
      else done();
    }
  }
}

async function exportDatabaseTable(
  job: Job,
  client: SqlServerClient,
  table: ExportTableState,
  lock: JobLock,
) {
  refreshCurrentObject(job);
  await lock.run(() => saveMeta(job));

  const cols = await client.listColumns(job.database, table.schema, table.name);
  const names = cols.map((col) => String(col.name || "")).filter(Boolean);
  let orderKeys = table.keys?.length ? [...table.keys] : [];
  if (!orderKeys.length) {
    const stats = await client.tableStats(job.database, table.schema, table.name);
    orderKeys = stats.keys;
    table.keys = [...orderKeys];
  }

  const startKey = table.last_key ?? null;

  const prefix = job.filePrefix
    ? `${job.filePrefix}_${table.schema}.${table.name}`
    : `${table.schema}.${table.name}`;

  await writeCsvPart(job, client, table.schema, table.name, names, prefix, {
    lock,
    tableEntry: table,
    orderKeys,
    startKey,
  });

  await lock.run(() => {
    if (job.cancel || job.skip.has(`${table.schema}\0${table.name}`)) {
      table.status = "cancelled";
    } else {
      table.status = "done";
      table.last_key = null;
      job.tablesDone += 1;
    }
    refreshCurrentObject(job);
    saveMeta(job);
  });
}

async function runExportDatabase(job: Job) {
  migrateLegacyTableKeys(job);
  const pending = job.tables.filter(
    (table) =>
      !job.skip.has(`${table.schema}\0${table.name}`) &&
      table.status !== "done" &&
      table.status !== "cancelled",
  ).length;
  const workerCount = Math.min(job.workers, Math.max(1, pending));
  const lock = createJobLock();
  let firstError: unknown = null;

  const worker = async () => {
    const client = await connectClient(job.cfg, settings.exportQueryTimeoutSec);
    try {
      while (!job.cancel && !firstError) {
        await waitIfPaused(job);
        if (job.cancel || firstError) break;

        const table = await lock.run(() => {
          const next = pickNextTable(job);
          if (!next) return null;
          next.status = "running";
          refreshCurrentObject(job);
          return next;
        });
        if (!table) break;

        try {
          await exportDatabaseTable(job, client, table, lock);
        } catch (exc) {
          await lock.run(() => {
            table.status = "running";
            if (!firstError) {
              firstError = exc;
              job.cancel = true;
            }
            refreshCurrentObject(job);
            saveMeta(job);
          });
        }
      }
    } finally {
      await client.close();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
}

async function runExport(job: Job) {
  if (ACTIVE_RUNS.has(job.id)) return;
  ACTIVE_RUNS.add(job.id);
  job.status = "running";
  job.startedAt = job.startedAt || now();
  saveMeta(job);
  try {
    if (job.kind === "backup") {
      const client = await connectClient(job.cfg, settings.exportQueryTimeoutSec);
      try {
        job.current = job.database;
        job.parts = [];
        const files = job.backupFiles || [];
        if (!files.length) throw new ClientError("Backup file list is empty.");
        const disks = files.map((file) => `DISK = N'${file.replaceAll("'", "''")}'`).join(", ");
        const dbSql = qident(job.database);
        let sqlText = `BACKUP DATABASE ${dbSql} TO ${disks} WITH INIT, STATS = 10`;
        if (job.gzip) sqlText += ", COMPRESSION";
        try {
          await client.execute(sqlText, { maxRows: 1, database: "master" });
        } catch (exc) {
          const text = String(exc instanceof Error ? exc.message : exc || "").toLowerCase();
          if (job.gzip && text.includes("compression")) {
            await client.execute(`BACKUP DATABASE ${dbSql} TO ${disks} WITH INIT, STATS = 10`, {
              maxRows: 1,
              database: "master",
            });
          } else {
            throw exc;
          }
        }
        for (const file of files) {
          job.parts.push({
            name: file.split(/[\\/]/).pop() || "backup.bak",
            rows: 0,
            bytes: 0,
            path: file,
          });
        }
      } finally {
        await client.close();
      }
    } else if (job.kind === "export_db") {
      await runExportDatabase(job);
    } else {
      const client = await connectClient(job.cfg, settings.exportQueryTimeoutSec);
      try {
        job.current = `${job.schema}.${job.table}`;
        await writeCsvPart(job, client, job.schema, job.table, job.columns, job.filePrefix, {
          orderKeys: job.keys,
          startKey: job.lastKey,
        });
      } finally {
        await client.close();
      }
    }
    job.status = job.cancel ? "cancelled" : "done";
  } catch (exc) {
    job.status = job.cancel ? "cancelled" : "error";
    job.error = exc instanceof Error ? exc.message : String(exc);
    job.hint = exc instanceof ClientError ? exc.hint || null : null;
  } finally {
    job.finishedAt = now();
    job.current = undefined;
    ACTIVE_RUNS.delete(job.id);
    saveMeta(job);
  }
}

function isActiveStatus(status: JobStatus) {
  return ["queued", "running", "paused", "cancelling"].includes(status);
}

function activeJobs(sid: string, exceptId?: string) {
  return [...JOBS.values()].filter((item) => item.sid === sid && item.id !== exceptId && isActiveStatus(item.status));
}

function jobWorkerCost(job: Pick<Job, "kind" | "workers">) {
  return job.kind === "backup" ? 1 : Math.max(1, job.workers);
}

function usedWorkers(sid: string, exceptId?: string) {
  return activeJobs(sid, exceptId).reduce((sum, job) => sum + jobWorkerCost(job), 0);
}

function takeWorkers(sid: string, wanted: number, exceptId?: string) {
  const remaining = settings.maxWorkers - usedWorkers(sid, exceptId);
  if (remaining < 1) {
    throw new ClientError(
      "Export worker limit reached.",
      `At most ${settings.maxWorkers} workers can run at once. Pause or cancel a job, then start another.`,
    );
  }
  return Math.min(Math.max(1, wanted), remaining);
}

function assertCanStart(sid: string, exceptId?: string) {
  if (activeJobs(sid, exceptId).length >= settings.maxJobs) {
    throw new ClientError(
      "Too many concurrent jobs.",
      `At most ${settings.maxJobs} export jobs can run at once. Pause or cancel one first.`,
    );
  }
}

function register(sid: string, job: Job) {
  assertCanStart(sid);
  job.workers = takeWorkers(sid, job.workers);
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
  const where = validateWhere(body.where);
  const chunks = normalizeChunks(Number(body.chunk_rows || 0), Number(body.chunk_bytes || 0));
  const probe = await connectClient(cfg);
  try {
    const allowed = (await probe.listColumns(body.database, body.schema, body.table)).map((col) => String(col.name || ""));
    const map = new Map(allowed.map((name) => [name.toLowerCase(), name]));
    const picked = (body.columns?.length ? body.columns : allowed)
      .map((name) => map.get(String(name).toLowerCase()))
      .filter(Boolean) as string[];
    if (!picked.length) throw new ClientError("Pick at least one column.");
    const stats = await probe.tableStats(body.database, body.schema, body.table);
    const dest = exportDestFolder(body.folder || settings.exportDir, body.table);
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
      where,
      folder: dest,
      gzip: body.gzip !== false,
      nolock: body.nolock !== false,
      chunkRows: chunks.chunkRows,
      chunkBytes: chunks.chunkBytes,
      batchSize: clampBatchSize(Number(body.batch_size || settings.defaultBatch)),
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
  const chunks = normalizeChunks(Number(body.chunk_rows || 0), Number(body.chunk_bytes || 0));
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
    const dest = exportDestFolder(body.folder || settings.exportDir, body.database);
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
      chunkRows: chunks.chunkRows,
      chunkBytes: chunks.chunkBytes,
      batchSize: clampBatchSize(Number(body.batch_size || settings.defaultBatch)),
      filePrefix: body.file_name || "",
      workers: Math.min(settings.maxWorkers, Math.max(1, Number(body.workers || 3))),
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
  const database = String(body.database || "").trim();
  if (!database) throw new ClientError("Select a database for backup.");
  const chunks = normalizeChunks(0, Number(body.chunk_bytes || 0));
  const dest = ensureWritableDir(body.folder || settings.exportDir);
  const probe = await connectClient(cfg);
  let sizeBytes = 0;
  try {
    const dbs = (await probe.listDatabases()) as Array<{ name?: string; size_mb?: number | null }>;
    for (const item of dbs) {
      if (String(item.name || "") === database) {
        sizeBytes = Math.trunc(Number(item.size_mb || 0) * 1024 * 1024);
        break;
      }
    }
  } finally {
    await probe.close();
  }
  let partsN = 1;
  if (chunks.chunkBytes && sizeBytes) partsN = Math.ceil(sizeBytes / chunks.chunkBytes);
  else if (chunks.chunkBytes) partsN = 4;
  partsN = Math.min(64, Math.max(1, partsN));
  const stamp = jobStamp();
  const files = Array.from({ length: partsN }, (_, index) =>
    join(dest, `${safeName(database)}_${stamp}_${String(index + 1).padStart(2, "0")}.bak`),
  );
  const job: Job = {
    id: randomBytes(8).toString("hex"),
    sid,
    cfg,
    kind: "backup",
    status: "queued",
    database,
    schema: "",
    table: database,
    columns: [],
    where: "",
    folder: dest,
    gzip: body.compress !== false,
    nolock: true,
    chunkRows: 0,
    chunkBytes: chunks.chunkBytes,
    batchSize: settings.defaultBatch,
    filePrefix: database,
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
    backupFiles: files,
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
  if (!cfg) throw new ClientError("Not connected to SQL Server.", "Reconnect and try again.");
  assertCanStart(sid, id);

  let job = JOBS.get(id);
  if (!job || job.sid !== sid) {
    const snap = PERSISTED.get(id);
    if (!snap || snap.sid !== sid) throw new ClientError("Export job not found.");
    if (!canResumeStatus(snap.status)) throw new ClientError("Job cannot be resumed.");
    job = hydrateJob(snap, cfg);
    JOBS.set(job.id, job);
  } else {
    job.cfg = cfg;
  }

  if (!canResumeStatus(job.status)) throw new ClientError("Job cannot be resumed.");

  const liveRun = ACTIVE_RUNS.has(job.id);
  job.workers = liveRun ? job.workers : takeWorkers(sid, job.workers, job.id);
  job.pause = false;
  job.cancel = false;
  job.error = null;
  job.hint = null;
  job.finishedAt = "";

  if (!liveRun) {
    adoptFolderParts(job.parts, job.folder);
    if (job.kind === "backup") {
      job.parts = [];
    } else if (job.kind === "export_db") {
      for (const table of job.tables) {
        if (table.status === "running") table.status = "queued";
      }
    } else if (job.kind === "export" && !job.lastKey) {
      job.parts = [];
      job.rowsWritten = 0;
      job.bytesWritten = 0;
    }
  }

  if (liveRun) {
    job.status = "running";
    saveMeta(job);
    return publicJob(job);
  }

  job.status = "queued";
  saveMeta(job);
  void runExport(job);
  return publicJob(job);
}

export function skipCurrent(sid: string, id: string, schema: string, name: string) {
  const job = getJob(sid, id);
  if (job.kind !== "export_db") return cancelJob(sid, id);
  if (!name) throw new ClientError("Invalid table to skip.");
  job.skip.add(`${schema}\0${name}`);
  return publicJob(job);
}

loadPersistedJobs();
