export class ClientError extends Error {
  hint?: string;
  retryable: boolean;
  status: number;

  constructor(message: string, hint?: string, retryable = false, status = 400) {
    super(message);
    this.name = "ClientError";
    this.hint = hint;
    this.retryable = retryable;
    this.status = retryable ? 503 : status;
  }
}

const TRANSIENT = [
  "busy with results",
  "another command",
  "communication link failure",
  "connection is not available",
  "connection reset",
  "broken pipe",
  "08s01",
  "08s02",
  "10054",
  "tcp provider",
  "server has gone away",
  "not connected",
  "connection is closed",
];

export function isCancelled(exc: unknown): boolean {
  const text = String(exc || "").toLowerCase();
  return (
    text.includes("dibatalkan") ||
    text.includes("cancelled") ||
    text.includes("canceled") ||
    text.includes("hy008") ||
    text.includes("operation canceled")
  );
}

export function isTransient(exc: unknown): boolean {
  if (isCancelled(exc)) return false;
  if (exc instanceof ClientError && exc.retryable) return true;
  const text = String(exc || "").toLowerCase();
  if (text.includes("login failed") || text.includes("login timeout")) return false;
  return TRANSIENT.some((token) => text.includes(token));
}

export function explainError(exc: unknown): { message: string; hint?: string } {
  const message = String(exc instanceof Error ? exc.message : exc || "SQL error");
  const lower = message.toLowerCase();
  let hint: string | undefined;
  if (lower.includes("cannot open database") || lower.includes("4060") || lower.includes("default database")) {
    hint = "This login cannot open that database. Set DATABASE to the login default (not master unless the login can use it).";
  } else if (lower.includes("login failed")) {
    hint = "Wrong password, or the login cannot open the selected database. Re-type the password even if a saved profile is selected.";
  } else if (lower.includes("connection refused") || lower.includes("econnrefused")) {
    hint = "SQL Server is not accepting connections. Enable TCP/IP and open port 1433.";
  } else if (lower.includes("query timeout")) {
    hint = "Query took too long. For large databases, raise SQLSM_QUERY_TIMEOUT_SEC (default 600) and retry. Schema cache skips row counts and uses fast TOP 3 samples.";
  } else if (lower.includes("timeout") || lower.includes("etimeout")) {
    hint = "Timeout. Check firewall, IP, port, or named instance / SQL Browser.";
  } else if (lower.includes("ssl") || lower.includes("certificate") || lower.includes("encrypt")) {
    hint = "Turn off TLS encryption for SQL Server 2012, or install a certificate.";
  } else if (isCancelled(exc)) {
    hint = "The command was stopped.";
  } else if (isTransient(exc)) {
    hint = "The session dropped or is busy. Try again.";
  }
  return { message, hint };
}
