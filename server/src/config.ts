import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STORE_DIR = join(homedir(), ".sqlsm");

function loadSecret(): string {
  const env = process.env.SQLSM_SECRET;
  if (env) return env;
  const path = join(STORE_DIR, "secret");
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path);
      if (raw.length) return raw.toString("utf8");
    }
    mkdirSync(STORE_DIR, { recursive: true });
    const raw = randomBytes(32);
    writeFileSync(path, raw);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
    return raw.toString("hex");
  } catch {
    return randomBytes(24).toString("hex");
  }
}

export const settings = {
  appName: "SQL Server Management",
  host: process.env.SQLSM_HOST || "127.0.0.1",
  port: Number(process.env.SQLSM_PORT || 8000),
  secret: loadSecret(),
  idleSec: Number(process.env.SQLSM_IDLE_SEC || 7200),
  allowRemote: process.env.SQLSM_ALLOW_REMOTE === "1",
  exportDir:
    process.env.SQLSM_EXPORT_DIR ||
    (process.platform === "win32" ? "C:\\SQLSM-Data" : join(homedir(), "sqlsm-data")),
  maxWorkers: Number(process.env.SQLSM_MAX_WORKERS || 32),
  maxJobs: Number(process.env.SQLSM_MAX_JOBS || 24),
  defaultBatch: Number(process.env.SQLSM_EXPORT_BATCH || 10000),
};

export function secretKey(): Buffer {
  return createHash("sha256").update(settings.secret).digest();
}
