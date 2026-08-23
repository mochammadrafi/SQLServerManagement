import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { secretKey, STORE_DIR } from "../config.js";

const STORE_PATH = join(STORE_DIR, "connections.json");
const PREFIX = "enc:v1:";

function encryptSecret(text: string): string {
  if (!text) return "";
  const key = secretKey();
  const data = Buffer.from(text, "utf8");
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data[i] ^ key[i % key.length];
  return PREFIX + out.toString("base64url");
}

export function decryptSecret(blob: string): string {
  if (!blob) return "";
  const text = String(blob);
  if (!text.startsWith(PREFIX)) return text;
  const key = secretKey();
  const data = Buffer.from(text.slice(PREFIX.length), "base64url");
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data[i] ^ key[i % key.length];
  return out.toString("utf8");
}

type Profile = Record<string, unknown>;

function load(): Profile[] {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    const items = Array.isArray(data) ? data : data.profiles;
    return Array.isArray(items) ? items.filter((item) => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

function save(items: Profile[]) {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify({ profiles: items }, null, 2));
  try {
    chmodSync(STORE_PATH, 0o600);
  } catch {
    /* ignore */
  }
}

function keyOf(item: Profile) {
  return [
    String(item.server || "").trim().toLowerCase(),
    String(item.port || 1433),
    String(item.instance || "").trim().toLowerCase(),
    String(item.auth || "sql"),
    String(item.username || "").trim().toLowerCase(),
    String(item.database || "master").trim().toLowerCase(),
  ].join("|");
}

export function publicProfile(item: Profile) {
  const auth = String(item.auth || "sql");
  let label = `${item.server || "server"} · ${item.database || "master"}`;
  if (item.instance) label = `${item.server}\\${item.instance} · ${item.database || "master"}`;
  if (auth === "windows") label += " · Windows";
  else if (item.username) label += ` · ${item.username}`;
  return {
    id: item.id,
    label,
    server: item.server || "",
    port: item.port || 1433,
    instance: item.instance || "",
    auth,
    username: item.username || "",
    database: item.database || "master",
    encrypt: Boolean(item.encrypt),
    has_password: Boolean(item.password),
    remember_password: Boolean(item.remember_password),
    last_used: item.last_used || "",
  };
}

export function listProfiles() {
  return load()
    .sort((a, b) => String(b.last_used || "").localeCompare(String(a.last_used || "")))
    .map(publicProfile);
}

export function getProfile(id: string) {
  return load().find((item) => item.id === id) || null;
}

export function readPassword(item: Profile) {
  return decryptSecret(String(item.password || ""));
}

export function upsertProfile(payload: Profile, rememberPassword = false) {
  const items = load();
  const incoming: Profile = {
    server: String(payload.server || "").trim(),
    port: Number(payload.port || 1433),
    instance: String(payload.instance || "").trim(),
    auth: payload.auth === "windows" ? "windows" : "sql",
    username: String(payload.username || "").trim(),
    database: String(payload.database || "master").trim() || "master",
    encrypt: Boolean(payload.encrypt),
    remember_password: rememberPassword,
    last_used: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
  const password = String(payload.password || "");
  let match = items.find((item) => keyOf(item) === keyOf(incoming));
  if (!match) {
    incoming.id = randomBytes(6).toString("hex");
    if (rememberPassword && password) incoming.password = encryptSecret(password);
    items.unshift(incoming);
    match = incoming;
  } else {
    Object.assign(match, incoming);
    if (rememberPassword) {
      if (password) match.password = encryptSecret(password);
    } else {
      delete match.password;
      match.remember_password = false;
    }
  }
  save(items);
  return publicProfile(match);
}

export function deleteProfile(id: string) {
  const items = load();
  const kept = items.filter((item) => item.id !== id);
  if (kept.length === items.length) return false;
  save(kept);
  return true;
}
