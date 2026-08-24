import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ClientError } from "./errors.js";
import { fail, ok } from "./responses.js";
import {
  activeItem,
  addConnection,
  clientOf,
  csrfToken,
  disconnect,
  publicConnection,
  sessionPayload,
  sidOf,
  switchConnection,
  verifyCsrf,
} from "./store.js";
import { type ConnectionConfig, connectClient } from "./sql/client.js";
import { listOdbcDrivers, loadMsnodesqlv8, pickOdbcDrivers } from "./sql/odbc.js";
import {
  cancelJob,
  exportLimits,
  getJob,
  jobPartPath,
  listJobs,
  pauseJob,
  publicJob,
  resumeJob,
  skipCurrent,
  startBackup,
  startDatabaseExport,
  startExport,
} from "./sql/export.js";
import { existingStartDir, listFolders, pickFolder } from "./sql/fs.js";
import { deleteProfile, getProfile, listProfiles, readPassword, upsertProfile } from "./sql/profiles.js";
import { askAi, listCatalogIndex, previewAiContext } from "./sql/ai.js";
import { openaiStatus, saveOpenAiKey } from "./sql/openai.js";
import { listSchemaCacheStatuses, startSchemaCacheBuild } from "./sql/schema-cache.js";

function body<T>(request: FastifyRequest): T {
  return (request.body || {}) as T;
}

export async function registerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const token = String(request.headers["x-sqlsm-token"] || "");
      if (!verifyCsrf(request, token)) {
        return reply.code(403).send(fail("Invalid request.", { hint: "Refresh the page, then try again." }));
      }
    }
  });

  app.get("/health", async () => ok("Service healthy", { status: "healthy" }));

  app.get("/api/v1/meta", async (request) =>
    ok("Ready", {
      platform: process.platform,
      windows: process.platform === "win32",
      odbc_drivers: listOdbcDrivers(),
      preferred_driver:
        process.platform === "win32"
          ? pickOdbcDrivers()[0] || (loadMsnodesqlv8() ? "msnodesqlv8" : "tedious")
          : "tedious",
      default_folder: existingStartDir(""),
      profiles: listProfiles(),
      csrf_token: csrfToken(request),
      export_limits: exportLimits(),
      openai: openaiStatus(),
    }),
  );

  app.get("/api/v1/session", async (request) => ok("Session", sessionPayload(request)));

  app.get("/api/v1/profiles", async () => ok("Profiles", { profiles: listProfiles() }));

  app.delete("/api/v1/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deleteProfile(id)) return reply.code(400).send(fail("Connection profile not found."));
    return ok("Profile deleted", { profiles: listProfiles() });
  });

  app.post("/api/v1/connect", async (request) => {
    const payload = body<{
      server?: string;
      port?: number;
      instance?: string;
      auth?: string;
      username?: string;
      password?: string;
      database?: string;
      encrypt?: boolean;
      remember_password?: boolean;
      profile_id?: string;
    }>(request);
    let password = payload.password || "";
    if (!password && payload.profile_id) {
      const saved = getProfile(payload.profile_id);
      if (saved) password = readPassword(saved);
    }
    const cfg: ConnectionConfig = {
      server: String(payload.server || "").trim(),
      port: Number(payload.port || 1433),
      instance: String(payload.instance || "").trim(),
      auth: payload.auth === "windows" ? "windows" : "sql",
      username: String(payload.username || "").trim(),
      password,
      database: String(payload.database || "master").trim() || "master",
      encrypt: Boolean(payload.encrypt),
    };
    const client = await connectClient(cfg);
    const info = await client.serverInfo();
    const item = await addConnection(request, cfg, client);
    try {
      upsertProfile({ ...cfg, password: cfg.password }, Boolean(payload.remember_password));
    } catch {
      /* ignore */
    }
    return ok("Connected", {
      connection: publicConnection(item),
      connection_id: item.id,
      connections: sessionPayload(request).connections,
      server: info,
      backend: client.backend,
      driver_name: client.driverName,
      csrf_token: csrfToken(request),
    });
  });

  app.post("/api/v1/disconnect", async (request) => {
    const payload = body<{ id?: string; all?: boolean }>(request);
    return ok("Disconnected", await disconnect(request, payload.id || "", Boolean(payload.all)));
  });

  app.post("/api/v1/connections/switch", async (request) => {
    const payload = body<{ id?: string }>(request);
    return ok("Switched", switchConnection(request, String(payload.id || "")));
  });

  app.get("/api/v1/server", async (request) => {
    const client = await clientOf(request);
    let sessions: Record<string, unknown>[] = [];
    let sessionsError: string | null = null;
    try {
      sessions = await client.listSessions();
    } catch (exc) {
      sessionsError = exc instanceof Error ? exc.message : String(exc);
    }
    const item = activeItem(request);
    return ok("Server", {
      server: await client.serverInfo(),
      sessions,
      sessions_error: sessionsError,
      backend: item?.client?.backend || "",
      driver_name: item?.client?.driverName || "",
    });
  });

  app.get("/api/v1/databases", async (request) =>
    ok("Databases", { databases: await (await clientOf(request)).listDatabases() }),
  );

  app.get("/api/v1/objects", async (request) => {
    const q = request.query as { database?: string; counts?: string };
    const catalog = await (await clientOf(request)).listObjects(q.database || "", q.counts === "1" || q.counts === "true");
    return ok("Objects", { database: q.database || "", ...catalog });
  });

  app.get("/api/v1/columns", async (request) => {
    const q = request.query as { database?: string; schema?: string; table?: string };
    return ok("Columns", {
      columns: await (await clientOf(request)).listColumns(q.database || "", q.schema || "", q.table || ""),
    });
  });

  app.get("/api/v1/table/stats", async (request) => {
    const q = request.query as { database?: string; schema?: string; table?: string };
    return ok("Stats", await (await clientOf(request)).tableStats(q.database || "", q.schema || "", q.table || ""));
  });

  app.get("/api/v1/table/page", async (request) => {
    const q = request.query as {
      database?: string;
      schema?: string;
      table?: string;
      page_size?: string;
      offset?: string;
      after?: string;
      seek?: string;
      where?: string;
    };
    let after: Record<string, unknown> | null = null;
    let seek: Record<string, unknown> | null = null;
    if (q.after) {
      try {
        after = JSON.parse(q.after);
      } catch {
        throw new ClientError("Invalid after parameter.");
      }
    }
    if (q.seek) {
      try {
        seek = JSON.parse(q.seek);
      } catch {
        throw new ClientError("Invalid seek parameter.");
      }
    }
    const started = Date.now();
    const data = await (
      await clientOf(request)
    ).pageTable(q.database || "", q.schema || "", q.table || "", {
      pageSize: Number(q.page_size || 200),
      offset: Number(q.offset || 0),
      after,
      seek,
      where: q.where || "",
    });
    return ok("Page", { ...data, elapsed_ms: Date.now() - started });
  });

  app.get("/api/v1/script/select", async (request) => {
    const q = request.query as { schema?: string; table?: string; database?: string };
    return ok("Script", {
      sql: (await clientOf(request)).selectScript(q.schema || "", q.table || "", 200, undefined, q.database),
    });
  });

  app.post("/api/v1/query", async (request) => {
    const payload = body<{ sql?: string; database?: string; max_rows?: number }>(request);
    const started = Date.now();
    const data = await (await clientOf(request)).execute(payload.sql || "", {
      maxRows: payload.max_rows || 1000,
      database: payload.database || null,
    });
    return ok("Query completed", { ...data, elapsed_ms: Date.now() - started });
  });

  app.post("/api/v1/cancel", async (request) => {
    const item = activeItem(request);
    let cancelled = 0;
    if (item?.client) {
      try {
        cancelled = (await item.client.cancelRunning()).cancelled;
      } catch {
        /* ignore */
      }
    }
    return ok("Cancelled", { cancelled });
  });

  app.post("/api/v1/export", async (request) =>
    ok("Export started", {
      job: await startExport(sidOf(request), needCfg(request), body(request)),
    }),
  );

  app.post("/api/v1/export/database", async (request) =>
    ok("Database export started", {
      job: await startDatabaseExport(sidOf(request), needCfg(request), body(request)),
    }),
  );

  app.post("/api/v1/backup", async (request) =>
    ok("Backup started", {
      job: await startBackup(sidOf(request), needCfg(request), body(request)),
    }),
  );

  app.get("/api/v1/exports", async (request) => ok("Exports", { jobs: listJobs(sidOf(request)) }));

  app.get("/api/v1/export/:id", async (request) => {
    const { id } = request.params as { id: string };
    return ok("Export", { job: publicJob(getJob(sidOf(request), id)) });
  });

  app.post("/api/v1/export/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    return ok("Cancelled", { job: cancelJob(sidOf(request), id) });
  });
  app.post("/api/v1/export/:id/pause", async (request) => {
    const { id } = request.params as { id: string };
    return ok("Paused", { job: pauseJob(sidOf(request), id) });
  });
  app.post("/api/v1/export/:id/resume", async (request) => {
    const { id } = request.params as { id: string };
    return ok("Resumed", { job: resumeJob(sidOf(request), id, needCfg(request)) });
  });
  app.post("/api/v1/export/:id/skip", async (request) => {
    const { id } = request.params as { id: string };
    const payload = body<{ schema?: string; name?: string; table?: string }>(request);
    return ok("Skipped", { job: skipCurrent(sidOf(request), id, payload.schema || "", payload.name || payload.table || "") });
  });

  app.get("/api/v1/export/:id/parts/:name", async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const path = jobPartPath(sidOf(request), id, name);
    const job = getJob(sidOf(request), id);
    return reply.header("Content-Disposition", `attachment; filename="${job.table}_${name}"`).send(createReadStream(path));
  });

  app.get("/api/v1/fs", async (request) => {
    const q = request.query as { path?: string };
    return ok("Folders", listFolders(q.path || ""));
  });
  app.post("/api/v1/fs/pick", async (request) => ok("Folder selected", pickFolder(body<{ path?: string }>(request).path || "")));

  app.get("/api/v1/ai/settings", async () => ok("AI settings", openaiStatus()));
  app.post("/api/v1/ai/settings", async (request) => {
    const payload = body<{ api_key?: string; model?: string }>(request);
    return ok("AI settings saved", saveOpenAiKey(String(payload.api_key || ""), payload.model));
  });
  app.post("/api/v1/ai/catalog", async (request) => {
    const client = await clientOf(request);
    const cfg = needCfg(request);
    const payload = body<{ databases?: string[] }>(request);
    return ok("Catalog ready", { catalog: await listCatalogIndex(client, payload.databases, cfg) });
  });
  app.post("/api/v1/ai/context", async (request) => {
    const client = await clientOf(request);
    const cfg = needCfg(request);
    const payload = body<{
      message?: string;
      databases?: string[];
      tables?: { database?: string; schema: string; name: string }[];
      include_samples?: boolean;
    }>(request);
    const result = await previewAiContext(
      client,
      {
        message: payload.message,
        databases: payload.databases,
        tables: payload.tables,
        includeSamples: payload.include_samples,
        mode: "query",
      },
      cfg,
    );
    return ok("Context ready", result);
  });
  app.post("/api/v1/ai/ask", async (request) => {
    const client = await clientOf(request);
    const cfg = needCfg(request);
    const payload = body<{
      mode?: "query" | "analyze";
      message?: string;
      databases?: string[];
      tables?: { database?: string; schema: string; name: string }[];
      include_samples?: boolean;
      sql?: string;
      history?: { role: "user" | "ai"; text?: string; used_objects?: string[] }[];
    }>(request);
    return ok(
      "AI ready",
      await askAi(
        client,
        {
          mode: payload.mode,
          message: payload.message,
          databases: payload.databases,
          tables: payload.tables,
          includeSamples: payload.include_samples,
          sql: payload.sql,
          history: payload.history,
        },
        cfg,
      ),
    );
  });
  app.post("/api/v1/schema/cache/status", async (request) => {
    const cfg = needCfg(request);
    const payload = body<{ databases?: string[] }>(request);
    const databases = (payload.databases || []).map((name) => String(name || "").trim()).filter(Boolean);
    return ok("Schema cache status", { caches: listSchemaCacheStatuses(cfg, databases) });
  });
  app.post("/api/v1/schema/cache/build", async (request) => {
    const client = await clientOf(request);
    const cfg = needCfg(request);
    const payload = body<{ databases?: string[] }>(request);
    const databases = (payload.databases || []).map((name) => String(name || "").trim()).filter(Boolean);
    return ok("Schema cache build started", { caches: startSchemaCacheBuild(cfg, client, databases) });
  });
}

function needCfg(request: FastifyRequest): ConnectionConfig {
  const item = activeItem(request);
  if (!item) throw new ClientError("Not connected to SQL Server.");
  return item.cfg;
}
