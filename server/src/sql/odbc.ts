import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import type sql from "mssql";
import { settings } from "../config.js";

const require = createRequire(import.meta.url);

export const PREFERRED_DRIVERS = [
  "ODBC Driver 17 for SQL Server",
  "ODBC Driver 13 for SQL Server",
  "ODBC Driver 11 for SQL Server",
  "SQL Server Native Client 11.0",
  "SQL Server Native Client 10.0",
  "SQL Server",
];

export function listOdbcDrivers(): string[] {
  if (process.platform !== "win32") return [];
  const keys = [
    "HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers",
    "HKLM\\SOFTWARE\\WOW6432Node\\ODBC\\ODBCINST.INI\\ODBC Drivers",
  ];
  const found = new Set<string>();
  for (const key of keys) {
    try {
      const out = execSync(`reg query "${key}"`, { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        const match = line.match(/^\s+(.+?)\s+REG_SZ\s+/);
        if (match?.[1]) found.add(match[1].trim());
      }
    } catch {
      /* registry key missing */
    }
  }
  return [...found];
}

export function pickOdbcDrivers(): string[] {
  const available = listOdbcDrivers();
  const ranked = PREFERRED_DRIVERS.filter((name) => available.includes(name));
  for (const name of available) {
    if (name.includes("SQL Server") && !ranked.includes(name)) ranked.push(name);
  }
  return ranked;
}

export function odbcConnectionString(
  cfg: {
    database: string;
    auth: string;
    username: string;
    password: string;
    encrypt: boolean;
  },
  driver: string,
  server: string,
  queryTimeoutSec = settings.queryTimeoutSec,
): string {
  const parts = [
    `Driver={${driver}}`,
    `Server=${server}`,
    `Database=${cfg.database || "master"}`,
    `Connection Timeout=${settings.connectionTimeoutSec}`,
    `Query Timeout=${queryTimeoutSec}`,
    "APP=SQLSM",
  ];
  if (cfg.auth === "windows") {
    parts.push("Trusted_Connection=yes");
  } else {
    parts.push(`UID=${cfg.username.trim()}`);
    parts.push(`PWD=${cfg.password || ""}`);
  }
  const modern = driver.startsWith("ODBC Driver") || driver.includes("Native Client");
  if (modern) {
    parts.push("MARS_Connection=yes");
    if (cfg.encrypt) {
      parts.push("Encrypt=yes");
      parts.push("TrustServerCertificate=yes");
    } else {
      parts.push("Encrypt=no");
    }
  }
  return `${parts.join(";")};`;
}

export function loadMsnodesqlv8(): typeof sql | null {
  try {
    require.resolve("msnodesqlv8");
    return require("mssql/msnodesqlv8") as typeof sql;
  } catch {
    return null;
  }
}
