import sql from "mssql";
import { ClientError, explainError, isCancelled, isTransient } from "../errors.js";
import {
  assertDb,
  jsonSafe,
  keysetClause,
  limitSelectSql,
  qident,
  qname,
  splitBatches,
  validateWhere,
} from "./ident.js";
import { loadMsnodesqlv8, odbcConnectionString, pickOdbcDrivers } from "./odbc.js";

export type ConnectionConfig = {
  server: string;
  port: number;
  instance: string;
  auth: "sql" | "windows";
  username: string;
  password: string;
  database: string;
  encrypt: boolean;
};

export function serverAddress(cfg: ConnectionConfig): string {
  const host = (cfg.server || "").trim();
  if (!host) throw new ClientError("Server is required.", "Example: localhost or 127.0.0.1");
  const instance = (cfg.instance || "").trim();
  const port = Number(cfg.port || 1433);
  if (instance && port !== 1433) return `${host}\\${instance},${port}`;
  if (instance) return `${host}\\${instance}`;
  if (port !== 1433) return `${host},${port}`;
  return host;
}

export function publicConfig(cfg: ConnectionConfig) {
  return {
    server: cfg.server,
    port: cfg.port,
    instance: cfg.instance,
    auth: cfg.auth,
    username: cfg.auth === "sql" ? cfg.username : "",
    database: cfg.database || "master",
    encrypt: cfg.encrypt,
    display_server: serverAddress(cfg),
  };
}

function isLoginError(exc: unknown): boolean {
  const text = String(exc instanceof Error ? exc.message : exc || "").toLowerCase();
  return text.includes("login failed") || text.includes("cannot open database") || text.includes("18456") || text.includes("4060");
}

function tediousConfig(cfg: ConnectionConfig): sql.config {
  const host = (cfg.server || "").trim();
  const instance = (cfg.instance || "").trim();
  if (cfg.auth === "windows") {
    throw new ClientError(
      "Windows Authentication needs the ODBC driver (msnodesqlv8).",
      "On Windows Server 2012 R2 run npm install in this folder so msnodesqlv8 can load.",
    );
  }
  if (!(cfg.username || "").trim()) {
    throw new ClientError("SQL username is required.");
  }
  return {
    server: host,
    port: instance ? undefined : Number(cfg.port || 1433),
    user: cfg.username.trim(),
    password: cfg.password || "",
    database: cfg.database || undefined,
    options: {
      encrypt: Boolean(cfg.encrypt),
      trustServerCertificate: true,
      enableArithAbort: true,
      appName: "SQLSM",
      instanceName: instance || undefined,
      tdsVersion: "7_4",
      fallbackToDefaultDb: true,
      cryptoCredentialsDetails: cfg.encrypt ? { minVersion: "TLSv1" } : {},
    },
    connectionTimeout: 15000,
    requestTimeout: 300000,
  } as sql.config;
}

async function openPool(cfg: ConnectionConfig): Promise<{
  pool: sql.ConnectionPool;
  backend: string;
  driverName: string;
  sql: typeof sql;
}> {
  if (cfg.auth === "windows" && process.platform !== "win32") {
    throw new ClientError(
      "Windows Authentication is only available on Windows.",
      "From macOS/Linux use a SQL login.",
    );
  }
  if (cfg.auth === "sql" && !(cfg.username || "").trim()) {
    throw new ClientError("SQL username is required.");
  }

  if (process.platform === "win32") {
    const sqlv8 = loadMsnodesqlv8();
    const drivers = pickOdbcDrivers();
    if (sqlv8 && drivers.length) {
      let lastErr: unknown;
      for (const driver of drivers) {
        try {
          const pool = new sqlv8.ConnectionPool({
            connectionString: odbcConnectionString(cfg, driver, serverAddress(cfg)),
            connectionTimeout: 15000,
            requestTimeout: 300000,
          } as unknown as sql.config);
          await pool.connect();
          return { pool, backend: "msnodesqlv8", driverName: driver, sql: sqlv8 };
        } catch (err) {
          lastErr = err;
          if (isLoginError(err)) break;
        }
      }
      if (lastErr && (cfg.auth === "windows" || isLoginError(lastErr))) throw lastErr;
    }
  }

  const pool = new sql.ConnectionPool(tediousConfig(cfg));
  await pool.connect();
  return { pool, backend: "mssql/tedious", driverName: "tedious", sql };
}

function asInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asDicts(data: { columns: string[]; rows: unknown[][] }): Record<string, unknown>[] {
  const columns = data.columns.map((name) => String(name || "").toLowerCase());
  return data.rows.map((row) => {
    const item: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      item[column] = row[index];
    });
    return item;
  });
}

export class SqlServerClient {
  cfg: ConnectionConfig;
  pool: sql.ConnectionPool | null = null;
  backend = "mssql/tedious";
  driverName = "tedious";
  private busy = 0;
  private cancelFlag = false;
  private spid: number | null = null;

  constructor(cfg: ConnectionConfig) {
    this.cfg = cfg;
  }

  isOpen(): boolean {
    return Boolean(this.pool?.connected);
  }

  async connect(): Promise<void> {
    if (this.pool?.connected) return;
    try {
      const opened = await openPool(this.cfg);
      this.pool = opened.pool;
      this.backend = opened.backend;
      this.driverName = opened.driverName;
    } catch (exc) {
      const { message, hint } = explainError(exc);
      throw new ClientError(message, hint, isTransient(exc));
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.close();
    } catch {
      /* ignore */
    }
    this.pool = null;
  }

  private async request(): Promise<sql.Request> {
    if (!this.pool?.connected) await this.connect();
    this.cancelFlag = false;
    return this.pool!.request();
  }

  async cancelRunning(): Promise<{ cancelled: number; killed: number }> {
    this.cancelFlag = true;
    let killed = 0;
    if (this.spid) {
      try {
        const extra = (await openPool(this.cfg)).pool;
        try {
          await extra.request().query(`KILL ${this.spid}`);
          killed = 1;
        } finally {
          await extra.close();
        }
      } catch {
        /* ignore */
      }
    }
    return { cancelled: this.busy ? 1 : 0, killed };
  }

  async execute(
    sqlText: string,
    opts: { params?: unknown[]; maxRows?: number; database?: string | null } = {},
  ) {
    const text = (sqlText || "").trim();
    if (!text) throw new ClientError("SQL is empty.");
    let maxRows = opts.maxRows ?? 1000;
    if (maxRows < 1) maxRows = 1;
    if (maxRows > 100000) maxRows = 100000;
    this.busy += 1;
    try {
      const req = await this.request();
      if (opts.database) {
        await req.query(`USE ${qident(opts.database)}`);
      }
      try {
        const spidRs = await req.query("SELECT @@SPID AS spid");
        this.spid = Number(spidRs.recordset?.[0]?.spid) || this.spid;
      } catch {
        /* ignore */
      }
      const batches = splitBatches(text);
      const resultSets: {
        columns: string[];
        rows: unknown[][];
        row_count: number;
        truncated: boolean;
      }[] = [];
      const messages: string[] = [];
      for (const batch of batches) {
        if (this.cancelFlag) throw new ClientError("Command cancelled.");
        const toRun = opts.params ? batch : limitSelectSql(batch, maxRows);
        const batchReq = this.pool!.request();
        (opts.params || []).forEach((value, index) => {
          batchReq.input(`p${index}`, value as never);
        });
        const result = await batchReq.query(toRun);
        const recordsets = result.recordsets;
        const sets = Array.isArray(recordsets)
          ? recordsets
          : result.recordset
            ? [result.recordset]
            : [];
        if (!sets.length) {
          const affected = result.rowsAffected?.find((n) => n >= 0);
          if (affected != null) messages.push(`Done. Rows affected: ${affected}`);
          continue;
        }
        for (const recordset of sets) {
          const columns = (recordset.columns ? Object.keys(recordset.columns) : Object.keys(recordset[0] || {})) as string[];
          const rows: unknown[][] = [];
          let truncated = false;
          for (const row of recordset) {
            if (rows.length >= maxRows) {
              truncated = true;
              break;
            }
            rows.push(columns.map((name) => jsonSafe((row as Record<string, unknown>)[name])));
          }
          resultSets.push({
            columns,
            rows,
            row_count: rows.length,
            truncated,
          });
        }
      }
      if (!resultSets.length && !messages.length) messages.push("Command finished with no result set.");
      return {
        result_sets: resultSets,
        messages,
        database: opts.database || this.cfg.database || "master",
      };
    } catch (exc) {
      if (exc instanceof ClientError) throw exc;
      if (isCancelled(exc) || this.cancelFlag) throw new ClientError("Command cancelled.");
      const { message, hint } = explainError(exc);
      throw new ClientError(message, hint, isTransient(exc));
    } finally {
      this.busy -= 1;
    }
  }

  private async queryDicts(sqlText: string, params?: unknown[], maxRows = 5000) {
    const data = await this.execute(sqlText, { params, maxRows });
    const first = data.result_sets[0] || { columns: [], rows: [] };
    return asDicts(first);
  }

  async serverInfo() {
    const rows = await this.queryDicts(
      `SELECT
    CAST(SERVERPROPERTY('MachineName') AS nvarchar(128)) AS machine_name,
    CAST(SERVERPROPERTY('ServerName') AS nvarchar(128)) AS server_name,
    CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS product_version,
    CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128)) AS product_level,
    CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
    CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition,
    CAST(SERVERPROPERTY('Collation') AS nvarchar(128)) AS collation,
    CAST(SERVERPROPERTY('IsIntegratedSecurityOnly') AS int) AS windows_auth_only,
    @@VERSION AS version_string,
    SUSER_SNAME() AS login_name,
    DB_NAME() AS current_database`,
      undefined,
      1,
    );
    if (!rows[0]) throw new ClientError("SQL Server returned no server info.");
    return rows[0];
  }

  async listDatabases() {
    const rows = await this.queryDicts(`
SELECT
    d.name,
    d.database_id,
    d.state_desc,
    d.compatibility_level,
    d.collation_name,
    d.recovery_model_desc
FROM sys.databases AS d
ORDER BY d.name`);
    const sizes = new Map<string, number>();
    try {
      const sizeRows = await this.queryDicts(`
SELECT d.database_id, d.name,
    CAST(SUM(CAST(mf.size AS bigint)) * 8.0 / 1024 AS decimal(18, 2)) AS size_mb
FROM sys.databases AS d
LEFT JOIN sys.master_files AS mf ON mf.database_id = d.database_id
GROUP BY d.database_id, d.name`);
      for (const item of sizeRows) {
        const mb = Number(item.size_mb);
        if (!Number.isFinite(mb)) continue;
        if (item.name != null) sizes.set(String(item.name).toLowerCase(), mb);
      }
    } catch {
      /* optional */
    }
    return rows.map((row) => ({
      ...row,
      size_mb: sizes.get(String(row.name || "").toLowerCase()) ?? null,
      is_system: ["master", "model", "msdb", "tempdb"].includes(String(row.name || "").toLowerCase()),
    }));
  }

  async listObjects(database: string, includeCounts = false) {
    const db = qident(assertDb(database));
    const schemas = await this.queryDicts(`
SELECT s.name AS schema_name,
    CASE WHEN s.name IN (
      'sys', 'INFORMATION_SCHEMA', 'guest',
      'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin',
      'db_backupoperator', 'db_datareader', 'db_datawriter',
      'db_denydatareader', 'db_denydatawriter'
    ) THEN 1 ELSE 0 END AS is_system
FROM ${db}.sys.schemas AS s
ORDER BY s.name`);
    const objects = await this.queryDicts(`
SELECT
    s.name AS schema_name,
    o.name AS object_name,
    CASE
        WHEN o.type = 'U' THEN 'table'
        WHEN o.type = 'V' THEN 'view'
        WHEN o.type = 'P' THEN 'procedure'
        ELSE 'function'
    END AS object_type,
    CAST(CASE WHEN o.is_ms_shipped = 1 THEN 1 ELSE 0 END AS int) AS is_system
FROM ${db}.sys.objects AS o
JOIN ${db}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF')
ORDER BY 1, 3, 2`, undefined, 50000);
    const metrics = includeCounts ? await this.tableMetrics(database).catch(() => new Map()) : new Map();
    const grouped: Record<string, Record<string, unknown>[]> = {
      tables: [],
      views: [],
      procedures: [],
      functions: [],
    };
    const keyMap: Record<string, string> = {
      table: "tables",
      view: "views",
      procedure: "procedures",
      function: "functions",
    };
    const seen = new Set<string>();
    for (const item of objects) {
      const bucket = keyMap[String(item.object_type || "")];
      if (!bucket) continue;
      const schema = String(item.schema_name || "");
      const name = String(item.object_name || "");
      seen.add(schema);
      const stat = metrics.get(`${schema}\0${name}`);
      grouped[bucket].push({
        schema,
        name,
        row_count: stat?.row_count ?? null,
        size_kb: stat?.size_kb ?? null,
        is_system: Boolean(item.is_system),
      });
    }
    const schemaList = schemas.map((item) => ({
      name: item.schema_name,
      is_system: Boolean(item.is_system),
    }));
    for (const name of seen) {
      if (name && !schemaList.some((entry) => entry.name === name)) {
        schemaList.push({ name, is_system: false });
      }
    }
    return { schemas: schemaList, objects: grouped };
  }

  async tableMetrics(database: string) {
    const db = qident(assertDb(database));
    const rows = await this.queryDicts(
      `SELECT
    s.name AS schema_name,
    o.name AS object_name,
    SUM(CASE WHEN p.index_id IN (0, 1) THEN CAST(p.rows AS bigint) ELSE 0 END) AS row_count,
    SUM(CAST(a.used_pages AS bigint)) * 8 AS size_kb
FROM ${db}.sys.partitions AS p
JOIN ${db}.sys.allocation_units AS a ON a.container_id = p.partition_id
JOIN ${db}.sys.objects AS o ON o.object_id = p.object_id
JOIN ${db}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.type = N'U'
GROUP BY s.name, o.name`,
      undefined,
      100000,
    );
    const result = new Map<string, { row_count: number; size_kb: number | null }>();
    for (const item of rows) {
      const schema = String(item.schema_name || "");
      const name = String(item.object_name || "");
      result.set(`${schema}\0${name}`, {
        row_count: asInt(item.row_count) ?? 0,
        size_kb: asInt(item.size_kb),
      });
    }
    return result;
  }

  async listColumns(database: string, schema: string, table: string) {
    return this.queryDicts(
      `SELECT
    c.ORDINAL_POSITION AS ordinal,
    c.COLUMN_NAME AS name,
    c.DATA_TYPE AS data_type,
    c.CHARACTER_MAXIMUM_LENGTH AS max_length,
    c.NUMERIC_PRECISION AS numeric_precision,
    c.NUMERIC_SCALE AS numeric_scale,
    c.IS_NULLABLE AS is_nullable,
    c.COLUMN_DEFAULT AS column_default
FROM ${qident(assertDb(database))}.INFORMATION_SCHEMA.COLUMNS AS c
WHERE c.TABLE_SCHEMA = @p0 AND c.TABLE_NAME = @p1
ORDER BY c.ORDINAL_POSITION`,
      [schema, table],
      2000,
    );
  }

  async listSessions() {
    return this.queryDicts(
      `SELECT
    s.session_id,
    s.login_name,
    s.host_name,
    s.program_name,
    s.status,
    DB_NAME(s.database_id) AS database_name,
    s.cpu_time,
    s.memory_usage,
    s.login_time
FROM sys.dm_exec_sessions AS s
WHERE s.is_user_process = 1
ORDER BY s.session_id`,
      undefined,
      2000,
    );
  }

  async keyColumns(database: string, schema: string, table: string): Promise<string[]> {
    const db = qident(assertDb(database));
    const chosen = await this.queryDicts(
      `SELECT TOP 1 i.index_id, i.is_primary_key, i.type AS index_type
FROM ${db}.sys.indexes AS i
JOIN ${db}.sys.objects AS o ON o.object_id = i.object_id
JOIN ${db}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = @p0 AND o.name = @p1
  AND i.is_hypothetical = 0
  AND (i.is_primary_key = 1 OR i.type = 1 OR EXISTS (
    SELECT 1 FROM ${db}.sys.columns AS c
    WHERE c.object_id = i.object_id AND c.is_identity = 1
  ))
ORDER BY i.is_primary_key DESC, CASE WHEN i.type = 1 THEN 0 ELSE 1 END, i.index_id`,
      [schema, table],
      1,
    );
    if (chosen[0]) {
      const cols = await this.queryDicts(
        `SELECT c.name AS name, ic.key_ordinal
FROM ${db}.sys.indexes AS i
JOIN ${db}.sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN ${db}.sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN ${db}.sys.objects AS o ON o.object_id = i.object_id
JOIN ${db}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = @p0 AND o.name = @p1 AND i.index_id = @p2
  AND ic.is_included_column = 0
ORDER BY ic.key_ordinal`,
        [schema, table, chosen[0].index_id],
        32,
      );
      const names = cols.map((item) => item.name).filter(Boolean) as string[];
      if (names.length) return names;
    }
    const ident = await this.queryDicts(
      `SELECT c.name AS name
FROM ${db}.sys.columns AS c
JOIN ${db}.sys.objects AS o ON o.object_id = c.object_id
JOIN ${db}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = @p0 AND o.name = @p1 AND c.is_identity = 1`,
      [schema, table],
      1,
    );
    if (ident[0]?.name) return [String(ident[0].name)];
    return [];
  }

  async tableStats(database: string, schema: string, table: string) {
    const keys = await this.keyColumns(database, schema, table);
    const db = qident(assertDb(database));
    let rowCount: number | null = null;
    try {
      const rows = await this.queryDicts(
        `SELECT SUM(CAST(p.rows AS bigint)) AS row_count
FROM ${db}.sys.partitions AS p
JOIN ${db}.sys.objects AS o ON o.object_id = p.object_id
JOIN ${db}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = @p0 AND o.name = @p1 AND p.index_id IN (0, 1)`,
        [schema, table],
        1,
      );
      rowCount = asInt(rows[0]?.row_count);
    } catch {
      /* optional */
    }
    return {
      database,
      schema,
      name: table,
      row_count: rowCount,
      keys,
      paging: keys.length ? "keyset" : "offset",
    };
  }

  async pageTable(
    database: string,
    schema: string,
    table: string,
    opts: {
      pageSize?: number;
      after?: Record<string, unknown> | null;
      seek?: Record<string, unknown> | null;
      offset?: number;
      where?: string;
    } = {},
  ) {
    let pageSize = Math.trunc(opts.pageSize || 200);
    if (pageSize < 1) pageSize = 1;
    if (pageSize > 1000) pageSize = 1000;
    let offset = Math.trunc(opts.offset || 0);
    if (offset < 0) offset = 0;
    const userWhere = validateWhere(opts.where);
    const keys = await this.keyColumns(database, schema, table);
    const params: unknown[] = [];
    const tableSql = `${qname(database, schema, table)} WITH (NOLOCK)`;
    const parts: string[] = [];
    if (userWhere) parts.push(`(${userWhere})`);
    let paging = keys.length ? "keyset" : "offset";
    if (keys.length && (opts.after || opts.seek)) {
      const source = opts.after || opts.seek || {};
      const values = keys.map((key) => source[key]);
      if (values.some((value) => value == null)) {
        throw new ClientError(`Incomplete paging key. Fill: ${keys.join(", ")}`);
      }
      const clause = keysetClause(keys, values, Boolean(opts.seek) && !opts.after);
      parts.push(`(${clause.sql})`);
      params.push(...clause.params);
    }
    const whereSql = parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
    let sqlText: string;
    if (userWhere && !opts.after && !opts.seek) {
      sqlText = `SELECT TOP ${pageSize} * FROM ${tableSql}${whereSql} OPTION (FAST ${pageSize})`;
      paging = "filter";
    } else if (keys.length) {
      sqlText = `SELECT TOP ${pageSize} * FROM ${tableSql}${whereSql} ORDER BY ${keys.map(qident).join(", ")} OPTION (FAST ${pageSize})`;
    } else {
      paging = "offset";
      if (offset > 100000) {
        throw new ClientError(
          "OFFSET is too deep for a heap.",
          "Add a primary key / identity, or use Export.",
        );
      }
      sqlText = `SELECT * FROM ${tableSql}${whereSql} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`;
    }
    const data = await this.execute(sqlText, { params: params.length ? params : undefined, maxRows: pageSize });
    const first = data.result_sets[0] || { columns: [], rows: [] };
    const columns = first.columns || [];
    const rows = first.rows || [];
    let lastKey: Record<string, unknown> | null = null;
    if (rows.length && keys.length) {
      lastKey = {};
      const lower = new Map(columns.map((name, index) => [String(name).toLowerCase(), index]));
      for (const key of keys) {
        const index = lower.get(key.toLowerCase());
        lastKey[key] = index != null ? rows[rows.length - 1][index] : null;
      }
    }
    return {
      columns,
      rows,
      page_size: pageSize,
      keys,
      paging,
      last_key: lastKey,
      has_more: rows.length >= pageSize,
      offset,
      sql: sqlText,
    };
  }

  selectScript(schema: string, table: string, pageSize = 200, keys?: string[], database?: string) {
    const source = database ? qname(database, schema, table) : qname(schema, table);
    let sqlText = `SELECT TOP ${pageSize} *\nFROM ${source}`;
    if (keys?.length) sqlText += `\nORDER BY ${keys.map(qident).join(", ")}`;
    return `${sqlText};`;
  }

  async *iterTableRows(
    database: string,
    schema: string,
    table: string,
    columns: string[],
    opts: {
      where?: string;
      orderKeys?: string[];
      nolock?: boolean;
      batchSize?: number;
      after?: Record<string, unknown> | null;
      shouldStop?: () => boolean;
    } = {},
  ) {
    if (!columns.length) throw new ClientError("Pick at least one column to export.");
    const whereSql = validateWhere(opts.where);
    let tableSql = qname(database, schema, table);
    if (opts.nolock !== false) tableSql += " WITH (NOLOCK)";
    let fetchN = Math.trunc(opts.batchSize || 10000);
    if (fetchN < 1) fetchN = 1;
    const keys = (opts.orderKeys || []).filter(Boolean);
    let after = opts.after && typeof opts.after === "object" ? opts.after : null;
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (whereSql) clauses.push(`(${whereSql})`);
    if (after && keys.length) {
      const values = keys.map((key) => after![key]);
      if (values.some((value) => value == null || value === "")) {
        after = null;
      } else {
        const clause = keysetClause(keys, values);
        clauses.push(clause.sql);
        params.push(...clause.params);
      }
    }
    let sqlText = `SELECT ${columns.map(qident).join(", ")} FROM ${tableSql}`;
    if (clauses.length) sqlText += ` WHERE ${clauses.join(" AND ")}`;
    if (keys.length && (after || !whereSql)) {
      sqlText += ` ORDER BY ${keys.map(qident).join(", ")}`;
    } else if (whereSql && !after) {
      sqlText += ` OPTION (FAST ${fetchN})`;
    }
    if (!this.pool?.connected) await this.connect();
    const request = this.pool!.request();
    request.stream = true;
    params.forEach((value, index) => request.input(`p${index}`, value as never));
    const queue: unknown[][] = [];
    let done = false;
    let error: unknown = null;
    request.on("row", (row: Record<string, unknown>) => {
      queue.push(columns.map((name) => row[name]));
    });
    request.on("error", (err) => {
      error = err;
      done = true;
    });
    request.on("done", () => {
      done = true;
    });
    request.query(sqlText).catch((err) => {
      error = err;
      done = true;
    });
    while (!done || queue.length) {
      if (opts.shouldStop?.() || this.cancelFlag) {
        request.cancel();
        throw new ClientError("Command cancelled.");
      }
      if (queue.length) {
        const batch = queue.splice(0, fetchN);
        yield batch;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (error) {
      if (isCancelled(error)) throw new ClientError("Command cancelled.");
      const { message, hint } = explainError(error);
      throw new ClientError(message, hint, isTransient(error));
    }
  }
}

export async function connectClient(cfg: ConnectionConfig): Promise<SqlServerClient> {
  const client = new SqlServerClient(cfg);
  await client.connect();
  return client;
}
