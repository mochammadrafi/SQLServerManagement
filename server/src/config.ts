import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STORE_DIR = join(homedir(), ".sqlsm");

function stripBytes(buf: Buffer): Buffer {
  let start = 0;
  let end = buf.length;
  const ws = (b: number) => b === 0x09 || b === 0x0a || b === 0x0b || b === 0x0c || b === 0x0d || b === 0x20;
  while (start < end && ws(buf[start])) start += 1;
  while (end > start && ws(buf[end - 1])) end -= 1;
  return buf.subarray(start, end);
}

function loadSecretFile(): Buffer {
  const path = join(STORE_DIR, "secret");
  try {
    if (existsSync(path)) {
      const raw = stripBytes(readFileSync(path));
      if (raw.length) return raw;
    }
    mkdirSync(STORE_DIR, { recursive: true });
    const raw = randomBytes(32);
    writeFileSync(path, raw);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
    return raw;
  } catch {
    return randomBytes(24);
  }
}

const secretFile = loadSecretFile();

export const settings = {
  appName: "SQL Server Management",
  host: process.env.SQLSM_HOST || "127.0.0.1",
  port: Number(process.env.SQLSM_PORT || 8000),
  secret: process.env.SQLSM_SECRET || secretFile.toString("hex"),
  idleSec: Number(process.env.SQLSM_IDLE_SEC || 7200),
  allowRemote: process.env.SQLSM_ALLOW_REMOTE === "1",
  exportDir:
    process.env.SQLSM_EXPORT_DIR ||
    (process.platform === "win32" ? "C:\\SQLSM-Data" : join(homedir(), "sqlsm-data")),
  maxWorkers: Number(process.env.SQLSM_MAX_WORKERS || 32),
  maxJobs: Number(process.env.SQLSM_MAX_JOBS || 24),
  defaultBatch: Number(process.env.SQLSM_EXPORT_BATCH || 10000),
  connectionTimeoutSec: Number(process.env.SQLSM_CONNECTION_TIMEOUT_SEC || 30),
  queryTimeoutSec: Number(process.env.SQLSM_QUERY_TIMEOUT_SEC || 600),
  exportQueryTimeoutSec: Number(process.env.SQLSM_EXPORT_QUERY_TIMEOUT_SEC || 86400),
};

export function secretKey(): Buffer {
  return createHash("sha256").update(secretFile).digest();
}
