import { ClientError } from "../errors.js";
import type { SqlServerClient } from "./client.js";
import { chatOpenAi, openaiStatus } from "./openai.js";

export type AiMode = "query" | "analyze";

export type AiAsk = {
  mode?: AiMode;
  message?: string;
  databases?: string[];
  tables?: { database?: string; schema: string; name: string }[];
  includeSamples?: boolean;
  sql?: string;
};

export type AiStep = {
  id: string;
  label: string;
  detail?: string;
  ms?: number;
};

export type AiColumn = {
  name: string;
  type: string;
  nullable?: boolean;
};

export type AiForeignKey = {
  from: string;
  to: string;
  columns: string[];
  constraint?: string;
};

export type AiContextObject = {
  database: string;
  schema: string;
  name: string;
  kind: string;
  row_count?: number | null;
  size_kb?: number | null;
  pk?: string[];
  columns: AiColumn[];
  sample?: { columns: string[]; rows: unknown[][] };
  reason?: string;
};

export type AiContextDb = {
  database: string;
  object_count: number;
  fk_count: number;
  objects: AiContextObject[];
  foreign_keys: AiForeignKey[];
};

const SQL_CONTINUATION =
  /^(FROM|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|UNION)/i;

const SYSTEM = `You are a SQL Server 2012 T-SQL assistant inside a local admin console.
Return ONLY valid JSON with this shape:
{"explanation":"...","sql":["one complete T-SQL statement"],"notes":["..."],"used_objects":["db.schema.table"]}

Accuracy rules (critical):
- Target SQL Server 2012 only. Use TOP, ISNULL, CONVERT, CTEs. No STRING_AGG, OPENJSON, DROP IF EXISTS, GENERATE_SERIES.
- Use ONLY tables, views, and columns listed in the catalog context below.
- If the request needs objects not in context, explain what is missing in explanation and notes — do NOT invent names.
- Use three-part names [database].[schema].[object] when more than one database appears in context.
- Default to SELECT. Write INSERT/UPDATE/DELETE only if the user explicitly asked.
- When the request spans multiple tables, write JOINs using foreign keys and PKs from context. State assumptions in notes.
- Put ONE complete runnable statement in sql[0]. Do NOT split SELECT / FROM / JOIN across multiple array items.
- List every object you referenced in used_objects.`;

function systemDbs() {
  return new Set(["master", "model", "msdb", "tempdb"]);
}

function step(steps: AiStep[], id: string, label: string, detail?: string, started?: number) {
  steps.push({ id, label, detail, ms: started != null ? Date.now() - started : undefined });
}

function tokenize(text: string) {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((part) => part.length > 2))];
}

function wantsJoin(message: string, pinnedCount: number) {
  if (pinnedCount > 1) return true;
  return /\b(join|relasi|hubung|gabung|combine|link|inner|left|right|outer|cross)\b/i.test(message);
}

function mentionTables(message: string, databases: string[]) {
  const defaultDb = databases[0] || "";
  const tables: { database?: string; schema: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const match of message.matchAll(/@([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+){1,2})/g)) {
    const raw = match[1];
    if (!raw) continue;
    const parts = raw.split(".");
    if (parts.length === 3) {
      const key = `${parts[0]}|${parts[1]}|${parts[2]}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tables.push({ database: parts[0], schema: parts[1], name: parts[2] });
    } else if (parts.length === 2 && defaultDb) {
      const key = `${defaultDb}|${parts[0]}|${parts[1]}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tables.push({ database: defaultDb, schema: parts[0], name: parts[1] });
    }
  }
  return tables;
}

function mergePinnedTables(ask: AiAsk, databases: string[]) {
  const seen = new Set<string>();
  const out: NonNullable<AiAsk["tables"]> = [];
  const push = (item: { database?: string; schema: string; name: string }) => {
    const key = `${item.database || ""}|${item.schema}|${item.name}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const item of ask.tables || []) push(item);
  for (const item of mentionTables(String(ask.message || ""), databases)) push(item);
  return out.length ? out : undefined;
}

function scoreObject(
  database: string,
  schema: string,
  name: string,
  kind: string,
  rowCount: number | null | undefined,
  message: string,
  joinMode: boolean,
) {
  const msg = message.toLowerCase();
  const full = `${schema}.${name}`.toLowerCase();
  const dbFull = `${database}.${schema}.${name}`.toLowerCase();
  let score = kind === "table" ? 1 : 0;
  if (msg.includes(dbFull) || msg.includes(`@${dbFull}`)) score += 30;
  if (msg.includes(full) || msg.includes(`@${full}`)) score += 20;
  if (msg.includes(name.toLowerCase()) || msg.includes(`@${name.toLowerCase()}`)) score += 12;
  for (const word of tokenize(message.replace(/@/g, " "))) {
    if (name.toLowerCase().includes(word)) score += 6;
    if (word.length > 4 && full.includes(word)) score += 4;
  }
  if (joinMode && kind === "table") score += 2;
  if (rowCount != null && rowCount > 0) score += Math.min(5, Math.log10(rowCount + 1));
  return score;
}

function reasonFor(score: number, wanted: boolean, joinMode: boolean) {
  if (wanted) return "selected";
  if (score >= 20) return "match";
  if (joinMode) return "fk";
  if (score >= 8) return "match";
  return "top";
}

function formatColumn(col: { name?: unknown; data_type?: unknown; is_nullable?: unknown }) {
  const name = String(col.name || "");
  const type = String(col.data_type || "unknown");
  const nullable = String(col.is_nullable || "").toUpperCase() === "YES";
  return { name, type, nullable };
}

function formatColumnLine(col: AiColumn) {
  const nullTag = col.nullable ? " NULL" : "";
  return `${col.name} ${col.type}${nullTag}`;
}

function fkKey(schema: string, table: string) {
  return `${schema}.${table}`.toLowerCase();
}

export async function gatherContext(client: SqlServerClient, ask: AiAsk) {
  const steps: AiStep[] = [];
  const started = Date.now();
  const message = String(ask.message || "");

  let databases = (ask.databases || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (!databases.length) {
    const all = await client.listDatabases();
    databases = all
      .filter((row) => !systemDbs().has(String((row as { name?: string }).name || "").toLowerCase()))
      .map((row) => String((row as { name?: string }).name || ""));
  }
  databases = databases.slice(0, 8);

  const pinned = mergePinnedTables(ask, databases) || [];
  const joinMode = wantsJoin(message, pinned.length);
  const wanted = new Set(pinned.map((item) => `${item.database || ""}|${item.schema}|${item.name}`.toLowerCase()));

  step(steps, "scope", "Scope", `${databases.length} database(s): ${databases.join(", ")}`, started);

  const context: AiContextDb[] = [];
  let sampleBudget = ask.includeSamples === false ? 0 : 12;
  let sampleUsed = 0;

  for (const database of databases) {
    const dbStarted = Date.now();
    const catalog = await client.listObjects(database, true);
    const metrics = new Map<string, { row_count?: number | null; size_kb?: number | null }>();
    for (const bucket of ["tables", "views"] as const) {
      for (const item of (catalog.objects[bucket] || []) as {
        schema?: string;
        name?: string;
        is_system?: boolean;
        row_count?: number | null;
        size_kb?: number | null;
      }[]) {
        if (item.is_system) continue;
        const schema = String(item.schema || "dbo");
        const name = String(item.name || "");
        if (!name) continue;
        metrics.set(fkKey(schema, name), {
          row_count: item.row_count ?? null,
          size_kb: item.size_kb ?? null,
        });
      }
    }

    const candidates: {
      schema: string;
      name: string;
      kind: string;
      row_count?: number | null;
      size_kb?: number | null;
      score: number;
      wanted: boolean;
    }[] = [];
    const push = (items: { schema?: string; name?: string; is_system?: boolean }[], kind: string) => {
      for (const item of items || []) {
        if (item.is_system) continue;
        const schema = String(item.schema || "dbo");
        const name = String(item.name || "");
        if (!name) continue;
        const isWanted =
          wanted.has(`${database}|${schema}|${name}`.toLowerCase()) ||
          wanted.has(`|${schema}|${name}`.toLowerCase());
        if (wanted.size && !isWanted) continue;
        const stat = metrics.get(fkKey(schema, name));
        candidates.push({
          schema,
          name,
          kind,
          row_count: stat?.row_count ?? null,
          size_kb: stat?.size_kb ?? null,
          score: scoreObject(database, schema, name, kind, stat?.row_count, message, joinMode),
          wanted: isWanted,
        });
      }
    };
    push((catalog.objects.tables || []) as { schema?: string; name?: string; is_system?: boolean }[], "table");
    push((catalog.objects.views || []) as { schema?: string; name?: string; is_system?: boolean }[], "view");

    let foreignKeys: AiForeignKey[] = [];
    try {
      const fkRows = await client.listForeignKeys(database);
      const grouped = new Map<string, AiForeignKey>();
      for (const row of fkRows) {
        const fromSchema = String(row.from_schema || "dbo");
        const fromTable = String(row.from_table || "");
        const toSchema = String(row.to_schema || "dbo");
        const toTable = String(row.to_table || "");
        const fromColumn = String(row.from_column || "");
        if (!fromTable || !toTable || !fromColumn) continue;
        const from = `${fromSchema}.${fromTable}`;
        const to = `${toSchema}.${toTable}`;
        const key = `${from}->${to}:${String(row.constraint_name || "")}`;
        const hit = grouped.get(key) || {
          from,
          to,
          columns: [],
          constraint: String(row.constraint_name || ""),
        };
        hit.columns.push(`${fromColumn}->${String(row.to_column || "")}`);
        grouped.set(key, hit);
      }
      foreignKeys = [...grouped.values()].slice(0, 80);
    } catch {
      foreignKeys = [];
    }

    const pickedNames = new Set<string>();
    const limit = wanted.size ? 40 : joinMode ? 30 : 25;
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    for (const item of ranked) {
      if (pickedNames.size >= limit) break;
      pickedNames.add(fkKey(item.schema, item.name));
    }
    if (joinMode) {
      for (const fk of foreignKeys) {
        if (pickedNames.size >= limit) break;
        for (const part of [fk.from, fk.to]) {
          const [schema, name] = part.split(".");
          if (schema && name) pickedNames.add(fkKey(schema, name));
        }
      }
    }

    step(
      steps,
      `catalog-${database}`,
      `Catalog · ${database}`,
      `${candidates.length} candidate object(s), ${foreignKeys.length} FK(s), sending ${pickedNames.size}`,
      dbStarted,
    );

    const objects: AiContextObject[] = [];
    const colStarted = Date.now();
    for (const key of pickedNames) {
      const item = ranked.find((row) => fkKey(row.schema, row.name) === key);
      if (!item) continue;
      let columns: AiColumn[] = [];
      try {
        const cols = await client.listColumns(database, item.schema, item.name);
        columns = cols.slice(0, 48).map((col) => formatColumn(col));
      } catch {
        columns = [];
      }
      let pk: string[] = [];
      if (item.kind === "table") {
        try {
          pk = await client.keyColumns(database, item.schema, item.name);
        } catch {
          pk = [];
        }
      }
      let sample: AiContextObject["sample"];
      if (sampleBudget > 0 && item.kind === "table") {
        try {
          const page = await client.pageTable(database, item.schema, item.name, { pageSize: 3 });
          sample = {
            columns: (page.columns || []).map((name) => String(name)),
            rows: (page.rows || []).slice(0, 3),
          };
          sampleBudget -= 1;
          sampleUsed += 1;
        } catch {
          /* skip sample */
        }
      }
      objects.push({
        database,
        schema: item.schema,
        name: item.name,
        kind: item.kind,
        row_count: item.row_count,
        size_kb: item.size_kb,
        pk,
        columns,
        sample,
        reason: reasonFor(item.score, item.wanted, joinMode),
      });
    }
    step(
      steps,
      `columns-${database}`,
      `Columns · ${database}`,
      `${objects.length} object(s), ${sampleUsed} sample(s) so far`,
      colStarted,
    );

    context.push({
      database,
      object_count: objects.length,
      fk_count: foreignKeys.length,
      objects,
      foreign_keys: foreignKeys.filter((fk) => {
        const from = fk.from.split(".")[1];
        const to = fk.to.split(".")[1];
        return objects.some((obj) => obj.name === from) || objects.some((obj) => obj.name === to) || joinMode;
      }),
    });
  }

  if (sampleUsed) {
    step(steps, "samples", "Samples", `${sampleUsed} table(s) with TOP 3 rows`, started);
  }

  return { context, steps };
}

export async function previewAiContext(client: SqlServerClient, ask: AiAsk) {
  return gatherContext(client, { ...ask, mode: "query" });
}

function compactContextText(context: AiContextDb[]) {
  const chunks: string[] = [];
  for (const db of context) {
    chunks.push(`## Database: ${db.database} (${db.object_count} objects, ${db.fk_count} FKs)`);
    if (db.foreign_keys.length) {
      chunks.push(
        "Foreign keys:\n" +
          db.foreign_keys
            .slice(0, 40)
            .map((fk) => `- ${fk.from} -> ${fk.to} (${fk.columns.join(", ")})`)
            .join("\n"),
      );
    }
    for (const obj of db.objects) {
      const size =
        obj.row_count != null
          ? `${obj.row_count.toLocaleString("en-US")} rows`
          : obj.size_kb != null
            ? `${obj.size_kb} KB`
            : "size unknown";
      const pk = obj.pk?.length ? ` PK: ${obj.pk.join(", ")}` : "";
      chunks.push(
        `### [${db.database}].[${obj.schema}].[${obj.name}] (${obj.kind}, ${size}${pk}, reason: ${obj.reason || "top"})`,
      );
      chunks.push(`Columns: ${obj.columns.map((col) => formatColumnLine(col)).join("; ")}`);
      if (obj.sample?.rows?.length) {
        chunks.push(`Sample rows: ${JSON.stringify(obj.sample.rows)}`);
      }
    }
  }
  return chunks.join("\n\n");
}

function normalizeSql(blocks: string[]) {
  const trimmed = blocks.map((item) => item.trim()).filter(Boolean);
  if (trimmed.length <= 1) return trimmed;

  const first = trimmed[0];
  if (/^(\s*)(SELECT|WITH)\b/i.test(first)) {
    const rest = trimmed.slice(1);
    const fragmentTail = rest.every(
      (block) =>
        SQL_CONTINUATION.test(block) ||
        !/^(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|EXEC)\b/i.test(block),
    );
    if (fragmentTail) return [trimmed.join("\n")];
  }

  const out: string[] = [];
  let buf: string[] = [];
  for (const block of trimmed) {
    if (!buf.length) {
      buf.push(block);
      continue;
    }
    if (SQL_CONTINUATION.test(block) || (!/^(SELECT|WITH)\b/i.test(block) && buf.length)) {
      buf.push(block);
      continue;
    }
    out.push(buf.join("\n"));
    buf = [block];
  }
  if (buf.length) out.push(buf.join("\n"));
  return out.length ? out : trimmed;
}

function parseModelJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(raw) as {
      explanation?: string;
      sql?: string[];
      notes?: string[];
      used_objects?: string[];
    };
    const sql = normalizeSql(
      Array.isArray(parsed.sql) ? parsed.sql.map((item) => String(item || "").trim()).filter(Boolean) : [],
    );
    return {
      explanation: String(parsed.explanation || "").trim() || text,
      sql,
      notes: Array.isArray(parsed.notes) ? parsed.notes.map((item) => String(item || "").trim()).filter(Boolean) : [],
      used_objects: Array.isArray(parsed.used_objects)
        ? parsed.used_objects.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
    };
  } catch {
    const blocks = normalizeSql([...text.matchAll(/```sql\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()));
    return {
      explanation: text.replace(/```[\s\S]*?```/g, "").trim() || text,
      sql: blocks,
      notes: [] as string[],
      used_objects: [] as string[],
    };
  }
}

function knownRefs(context: AiContextDb[]) {
  const set = new Set<string>();
  for (const db of context) {
    for (const obj of db.objects) {
      set.add(`${db.database}.${obj.schema}.${obj.name}`.toLowerCase());
      set.add(`${obj.schema}.${obj.name}`.toLowerCase());
      set.add(obj.name.toLowerCase());
    }
  }
  return set;
}

function validateSql(sqlBlocks: string[], context: AiContextDb[]) {
  const refs = knownRefs(context);
  const warnings: string[] = [];
  const objectPattern = /\[([^\]]+)\]\.\[([^\]]+)\]\.\[([^\]]+)\]/gi;
  const twoPartPattern = /\[([^\]]+)\]\.\[([^\]]+)\]/gi;

  for (const block of sqlBlocks) {
    let match: RegExpExecArray | null;
    objectPattern.lastIndex = 0;
    while ((match = objectPattern.exec(block))) {
      const ref = `${match[1]}.${match[2]}.${match[3]}`.toLowerCase();
      if (!refs.has(ref)) warnings.push(`Unknown object referenced: [${match[1]}].[${match[2]}].[${match[3]}]`);
    }
    twoPartPattern.lastIndex = 0;
    while ((match = twoPartPattern.exec(block))) {
      const ref = `${match[1]}.${match[2]}`.toLowerCase();
      if (block.includes(`[${match[1]}].[${match[2]}].[`)) continue;
      if (!refs.has(ref)) warnings.push(`Unknown object referenced: [${match[1]}].[${match[2]}]`);
    }
  }
  return [...new Set(warnings)];
}

function userPrompt(ask: AiAsk, context: AiContextDb[]) {
  const mode = ask.mode || "query";
  const task =
    mode === "analyze"
      ? "Analyze the SQL the user pasted against the catalog. Explain it, flag mismatches, and improve it if needed."
      : "Write accurate T-SQL that answers the user request, including JOINs when multiple tables are involved. Return one complete statement in sql[0].";
  return [
    `Mode: ${mode}`,
    `Task: ${task}`,
    ask.message ? `User request: ${ask.message}` : "",
    ask.sql ? `SQL to analyze:\n${ask.sql}` : "",
    compactContextText(context),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function askAi(client: SqlServerClient, ask: AiAsk) {
  const mode = ask.mode || "query";
  if (mode === "analyze") {
    if (!(ask.sql || "").trim()) throw new ClientError("Paste SQL to analyze.");
  } else if (!(ask.message || "").trim()) {
    throw new ClientError("Write what you want the AI to do.");
  }

  const { context, steps } = await gatherContext(client, ask);
  const tables = context.reduce((sum, db) => sum + db.objects.length, 0);
  if (!tables) {
    throw new ClientError("No tables found in the selected databases.");
  }

  const modelStarted = Date.now();
  const status = openaiStatus();
  const content = await chatOpenAi(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt(ask, context) },
    ],
    { json: true, temperature: 0.1 },
  );
  step(steps, "model", "OpenAI", status.model, modelStarted);

  const parsed = parseModelJson(content);
  const validateStarted = Date.now();
  const warnings = validateSql(parsed.sql, context);
  if (parsed.used_objects.length) {
    for (const ref of parsed.used_objects) {
      const lower = ref.toLowerCase();
      if (!knownRefs(context).has(lower) && !knownRefs(context).has(lower.split(".").slice(-2).join("."))) {
        warnings.push(`Model cited object not in context: ${ref}`);
      }
    }
  }
  step(
    steps,
    "validate",
    "Validate",
    warnings.length ? `${warnings.length} warning(s)` : "SQL references look consistent",
    validateStarted,
  );

  return {
    explanation: parsed.explanation,
    sql: parsed.sql,
    notes: parsed.notes,
    warnings,
    used_objects: parsed.used_objects,
    context,
    steps,
    model: status.model,
    scanned: context.map((db) => ({
      database: db.database,
      tables: db.objects.length,
      objects: db.objects.map((item) => `${item.schema}.${item.name}`),
    })),
    mode,
  };
}
