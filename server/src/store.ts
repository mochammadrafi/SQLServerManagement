import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { settings } from "./config.js";
import { ClientError } from "./errors.js";
import { type ConnectionConfig, type SqlServerClient, connectClient, publicConfig } from "./sql/client.js";
import { cancelJob, listJobs } from "./sql/export.js";

type StoreItem = {
  id: string;
  cfg: ConnectionConfig;
  client: SqlServerClient | null;
};

type SessionStore = {
  connections: Record<string, StoreItem>;
  active: string | null;
  last: number;
};

const STORE = new Map<string, SessionStore>();

export function sidOf(request: FastifyRequest): string {
  const session = request.session as { sid?: string };
  if (!session.sid) session.sid = randomBytes(16).toString("hex");
  return session.sid;
}

export function csrfToken(request: FastifyRequest): string {
  const session = request.session as { csrf?: string };
  if (!session.csrf) session.csrf = randomBytes(16).toString("hex");
  return session.csrf;
}

export function verifyCsrf(request: FastifyRequest, token?: string): boolean {
  return Boolean(token && token === csrfToken(request));
}

function touch(sid: string) {
  const store = STORE.get(sid);
  if (store) store.last = Date.now();
  const now = Date.now();
  for (const [key, value] of STORE) {
    if (now - value.last <= settings.idleSec * 1000) continue;
    for (const item of Object.values(value.connections)) {
      void item.client?.close();
    }
    STORE.delete(key);
  }
}

export function publicConnection(item: StoreItem) {
  const data = publicConfig(item.cfg);
  let label = `${data.display_server} · ${data.database}`;
  if (data.auth === "sql" && data.username) label += ` · ${data.username}`;
  else if (data.auth === "windows") label += " · Windows";
  return {
    ...data,
    id: item.id,
    backend: item.client?.backend || "",
    driver_name: item.client?.driverName || "",
    label,
  };
}

export function ensureStore(request: FastifyRequest): SessionStore | null {
  const sid = sidOf(request);
  touch(sid);
  return STORE.get(sid) || null;
}

export function activeItem(request: FastifyRequest): StoreItem | null {
  const store = ensureStore(request);
  if (!store?.active) return null;
  return store.connections[store.active] || null;
}

export async function clientOf(request: FastifyRequest): Promise<SqlServerClient> {
  const item = activeItem(request);
  if (!item) throw new ClientError("Not connected to SQL Server.", "Open the connection screen.");
  if (item.client?.isOpen()) return item.client;
  item.client = await connectClient(item.cfg);
  return item.client;
}

export async function addConnection(request: FastifyRequest, cfg: ConnectionConfig, client: SqlServerClient) {
  const sid = sidOf(request);
  let store = STORE.get(sid);
  if (!store) {
    store = { connections: {}, active: null, last: Date.now() };
    STORE.set(sid, store);
  }
  const id = randomBytes(6).toString("hex");
  store.connections[id] = { id, cfg, client };
  store.active = id;
  store.last = Date.now();
  return store.connections[id];
}

export async function disconnect(request: FastifyRequest, target = "", closeAll = false) {
  const sid = sidOf(request);
  const store = STORE.get(sid);
  if (!store) return { connected: false, connections: [] };
  const remaining = { ...store.connections };
  if (closeAll) {
    await Promise.all(Object.values(remaining).map((item) => item.client?.close()));
    store.connections = {};
    store.active = null;
  } else if (target && remaining[target]) {
    await remaining[target].client?.close();
    delete remaining[target];
    store.connections = remaining;
  }
  const left = Object.values(store.connections);
  if (left.length) {
    if (!store.active || !store.connections[store.active]) store.active = left[0].id;
    const item = store.connections[store.active];
    return {
      connected: true,
      connection: publicConnection(item),
      connection_id: item.id,
      connections: left.map(publicConnection),
    };
  }
  for (const job of listJobs(sid)) {
    if (["queued", "running", "cancelling", "paused"].includes(job.status)) {
      try {
        cancelJob(sid, job.id);
      } catch {
        /* ignore */
      }
    }
  }
  STORE.delete(sid);
  return { connected: false, connections: [] };
}

export function switchConnection(request: FastifyRequest, id: string) {
  const store = ensureStore(request);
  if (!store?.connections[id]) throw new ClientError("Connection not found.");
  store.active = id;
  const item = store.connections[id];
  return {
    connection: publicConnection(item),
    connection_id: id,
    connections: Object.values(store.connections).map(publicConnection),
    backend: item.client?.backend || "",
    driver_name: item.client?.driverName || "",
  };
}

export function sessionPayload(request: FastifyRequest) {
  const store = ensureStore(request);
  const item = activeItem(request);
  if (!store || !item) return { connected: false, connections: [] as ReturnType<typeof publicConnection>[] };
  return {
    connected: true,
    connection: publicConnection(item),
    connection_id: item.id,
    connections: Object.values(store.connections).map(publicConnection),
    backend: item.client?.backend || "",
    driver_name: item.client?.driverName || "",
    csrf_token: csrfToken(request),
  };
}
