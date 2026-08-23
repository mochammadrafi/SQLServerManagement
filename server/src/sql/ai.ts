import { ClientError } from "../errors.js";
import type { SqlServerClient } from "./client.js";
import { chatOpenAi } from "./openai.js";

export type AiMode = "query" | "analyze" | "join" | "scan";

export type AiAsk = {
  mode?: AiMode;
  message?: string;
  databases?: string[];
  tables?: { database?: string; schema: string; name: string }[];
  includeSamples?: boolean;
  sql?: string;
};

type TableContext = {
  database: string;
  schema: string;
  name: string;
  kind: string;
  columns: string[];
  sample?: { columns: string[]; rows: unknown[][] };
};

const SYSTEM = `You are a SQL Server 2012 T-SQL assistant inside a local admin console.
Return ONLY valid JSON:
{"explanation":"short","sql":["T-SQL here"],"notes":["optional"]}

Rules:
- Target SQL Server 2012. Use TOP, ISNULL, CONVERT. No STRING_AGG, no DROP IF EXISTS, no GENERATE_SERIES.
- Use three-part names [database].[schema].[table] when more than one database is in context.
- Only use tables and columns from the provided context. If something is missing, say so in explanation and do not invent objects.
- Default to SELECT. Write INSERT/UPDATE/DELETE only if the user asked.
- Prefer readable joins on similarly named columns (Id, *_id) when suggesting joins.
- Keep each batch runnable. Separate GO only if needed; prefer one statement per sql array item.`;

function systemDbs() {
  return new Set(["master", "model", "msdb", "tempdb"]);
}

export async function gatherContext(client: SqlServerClient, ask: AiAsk) {
  let databases = (ask.databases || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (!databases.length) {
    const all = await client.listDatabases();
    databases = all
      .filter((row) => !systemDbs().has(String((row as { name?: string }).name || "").toLowerCase()))
      .map((row) => String((row as { name?: string }).name || ""));
  }
  databases = databases.slice(0, 8);
  const wanted = new Set(
    (ask.tables || []).map((item) => `${item.database || ""}|${item.schema}|${item.name}`.toLowerCase()),
  );
  const context: { database: string; objects: TableContext[] }[] = [];
  let sampleBudget = ask.includeSamples === false ? 0 : 8;

  for (const database of databases) {
    const catalog = await client.listObjects(database, false);
    const picked: { schema: string; name: string; kind: string }[] = [];
    const push = (items: { schema?: string; name?: string; is_system?: boolean }[], kind: string) => {
      for (const item of items || []) {
        if (item.is_system) continue;
        const schema = String(item.schema || "dbo");
        const name = String(item.name || "");
        if (!name) continue;
        if (wanted.size && !wanted.has(`${database}|${schema}|${name}`.toLowerCase()) && !wanted.has(`|${schema}|${name}`.toLowerCase())) {
          continue;
        }
        picked.push({ schema, name, kind });
      }
    };
    push((catalog.objects.tables || []) as { schema?: string; name?: string; is_system?: boolean }[], "table");
    push((catalog.objects.views || []) as { schema?: string; name?: string; is_system?: boolean }[], "view");
    const limited = (wanted.size ? picked : picked.slice(0, 30)).slice(0, 40);
    const objects: TableContext[] = [];
    for (const item of limited) {
      let columns: string[] = [];
      try {
        const cols = await client.listColumns(database, item.schema, item.name);
        columns = cols.slice(0, 24).map((col) => {
          const type = col.data_type ? ` ${String(col.data_type)}` : "";
          return `${String(col.name || "")}${type}`;
        });
      } catch {
        columns = [];
      }
      let sample: TableContext["sample"];
      if (sampleBudget > 0 && item.kind === "table") {
        try {
          const page = await client.pageTable(database, item.schema, item.name, { pageSize: 3 });
          sample = {
            columns: (page.columns || []).map((name) => String(name)),
            rows: (page.rows || []).slice(0, 3),
          };
          sampleBudget -= 1;
        } catch {
          /* skip sample */
        }
      }
      objects.push({
        database,
        schema: item.schema,
        name: item.name,
        kind: item.kind,
        columns,
        sample,
      });
    }
    context.push({ database, objects });
  }
  return context;
}

function parseModelJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(raw) as { explanation?: string; sql?: string[]; notes?: string[] };
    return {
      explanation: String(parsed.explanation || "").trim() || text,
      sql: Array.isArray(parsed.sql) ? parsed.sql.map((item) => String(item || "").trim()).filter(Boolean) : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes.map((item) => String(item || "").trim()).filter(Boolean) : [],
    };
  } catch {
    const blocks = [...text.matchAll(/```sql\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
    return { explanation: text.replace(/```[\s\S]*?```/g, "").trim() || text, sql: blocks, notes: [] as string[] };
  }
}

function userPrompt(ask: AiAsk, context: { database: string; objects: TableContext[] }[]) {
  const mode = ask.mode || "query";
  const task =
    mode === "scan"
      ? "Scan the catalog. Summarize what is here, then propose useful SELECT / join queries a human would actually run."
      : mode === "join"
        ? "Suggest join paths between the listed objects. Output JOIN SQL."
        : mode === "analyze"
          ? "Analyze the SQL the user pasted. Explain it and improve it if needed."
          : "Write T-SQL that answers the user request.";
  return [
    `Mode: ${mode}`,
    `Task: ${task}`,
    ask.message ? `User: ${ask.message}` : "",
    ask.sql ? `Current SQL:\n${ask.sql}` : "",
    `Catalog context (databases scanned one by one):\n${JSON.stringify(context)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function askAi(client: SqlServerClient, ask: AiAsk) {
  const mode = ask.mode || "query";
  if (mode !== "scan" && !(ask.message || "").trim() && !(ask.sql || "").trim()) {
    throw new ClientError("Write what you want the AI to do.");
  }
  const context = await gatherContext(client, ask);
  const tables = context.reduce((sum, db) => sum + db.objects.length, 0);
  if (!tables) {
    throw new ClientError("No tables found in the selected databases.");
  }
  const content = await chatOpenAi([
    { role: "system", content: SYSTEM },
    { role: "user", content: userPrompt(ask, context) },
  ]);
  const result = parseModelJson(content);
  return {
    ...result,
    scanned: context.map((db) => ({
      database: db.database,
      tables: db.objects.length,
      objects: db.objects.map((item) => `${item.schema}.${item.name}`),
    })),
    mode,
  };
}
