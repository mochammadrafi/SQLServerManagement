import { ClientError } from "../errors.js";

const IDENT = /^[\w.\- ]+$/u;
const GO_LINE = /^\s*GO\s*(?:--.*)?$/i;
const WHERE_BAD =
  /;|--|\/\*|\bGO\b|\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|BACKUP|RESTORE|SHUTDOWN|XP_|SP_CONFIGURE|SELECT|UNION|OPENROWSET|OPENDATASOURCE|WAITFOR|OPENQUERY)\b/i;

export function qident(name: string): string {
  const text = String(name ?? "").trim();
  if (!text) throw new ClientError("Object name is empty.");
  return `[${text.replaceAll("]", "]]")}]`;
}

export function qname(...parts: string[]): string {
  return parts.filter(Boolean).map(qident).join(".");
}

export function assertDb(database: string): string {
  const name = (database || "").trim();
  if (!name) throw new ClientError("Select a database.");
  if (!IDENT.test(name)) throw new ClientError("Invalid database name.");
  return name;
}

export function validateWhere(where?: string): string {
  const text = (where || "").trim();
  if (!text) return "";
  if (text.length > 4000) throw new ClientError("WHERE is too long.");
  if (WHERE_BAD.test(text)) {
    throw new ClientError(
      "Invalid WHERE.",
      "Filter only. No semicolons, comments, or other statements.",
    );
  }
  return text;
}

export function splitBatches(sql: string): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  for (const line of (sql || "").split(/\r?\n/)) {
    if (GO_LINE.test(line)) {
      const chunk = current.join("\n").trim();
      if (chunk) batches.push(chunk);
      current = [];
    } else {
      current.push(line);
    }
  }
  const chunk = current.join("\n").trim();
  if (chunk) batches.push(chunk);
  return batches;
}

const SELECT_HEAD = /^(\s*SELECT\s+)(DISTINCT\s+)?/i;
const HAS_TOP = /^\s*SELECT\s+(DISTINCT\s+)?TOP\b/i;
const HAS_OFFSET = /\bOFFSET\s+\d+\s+ROWS\b|\bFETCH\s+(FIRST|NEXT)\b/i;
const SELECT_INTO = /^\s*SELECT\b.+\bINTO\b/is;
const SET_OP = /\bUNION\b|\bEXCEPT\b|\bINTERSECT\b/i;
const HAS_HINT = /\bOPTION\s*\(|\bFOR\s+(XML|JSON)\b/i;

export function limitSelectSql(sql: string, maxRows: number): string {
  const text = sql || "";
  const stripped = text.replace(/^\s+/, "");
  if (!stripped || !/^SELECT\b/i.test(stripped)) return sql;
  if (HAS_OFFSET.test(text) || SELECT_INTO.test(text) || SET_OP.test(text)) return sql;
  let next = text;
  if (!HAS_TOP.test(text)) {
    const match = SELECT_HEAD.exec(text);
    if (!match) return sql;
    next = `${match[1]}${match[2] || ""}TOP ${maxRows} ${text.slice(match[0].length)}`;
  }
  if (HAS_HINT.test(next)) return next;
  let trimmed = next.replace(/\s+$/, "");
  if (trimmed.endsWith(";")) trimmed = trimmed.slice(0, -1).trimEnd();
  return `${trimmed} OPTION (FAST ${maxRows})`;
}

export function keysetClause(
  keys: string[],
  values: unknown[],
  inclusive = false,
): { sql: string; params: unknown[] } {
  if (!keys.length || keys.length !== values.length) {
    throw new ClientError("Incomplete paging key.");
  }
  const parts: string[] = [];
  const params: unknown[] = [];
  const last = keys.length - 1;
  for (let index = 0; index < keys.length; index += 1) {
    const eqs: string[] = [];
    for (let prev = 0; prev < index; prev += 1) {
      eqs.push(`${qident(keys[prev])} = @p${params.length}`);
      params.push(values[prev]);
    }
    const op = inclusive && index === last ? ">=" : ">";
    const gt = `${qident(keys[index])} ${op} @p${params.length}`;
    params.push(values[index]);
    parts.push(eqs.length ? `(${eqs.join(" AND ")} AND ${gt})` : `(${gt})`);
  }
  return { sql: `(${parts.join(" OR ")})`, params };
}

export function jsonSafe(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) {
    return value.toISOString().replace("T", " ").replace("Z", "");
  }
  if (Buffer.isBuffer(value)) {
    const preview = value.subarray(0, 64).toString("hex");
    return `0x${preview}${value.length > 64 ? "..." : ""}`;
  }
  if (typeof value === "object") return String(value);
  return String(value);
}

export function csvValue(value: unknown): string | number {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  return String(value);
}
