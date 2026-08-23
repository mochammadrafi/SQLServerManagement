import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { STORE_DIR } from "../config.js";
import { ClientError } from "../errors.js";

const PATH = join(STORE_DIR, "openai.json");
const DEFAULT_MODEL = "gpt-4o-mini";

type Store = { apiKey?: string; model?: string };

function loadStore(): Store {
  const envKey = (process.env.SQLSM_OPENAI_KEY || "").trim();
  let file: Store = {};
  if (existsSync(PATH)) {
    try {
      file = JSON.parse(readFileSync(PATH, "utf8")) as Store;
    } catch {
      file = {};
    }
  }
  return {
    apiKey: envKey || String(file.apiKey || "").trim(),
    model: String(file.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
  };
}

export function openaiStatus() {
  const store = loadStore();
  const key = store.apiKey || "";
  const tail = key.length > 8 ? key.slice(-4) : "";
  return {
    configured: Boolean(key),
    masked: key ? `${key.slice(0, 7)}…${tail}` : "",
    model: store.model || DEFAULT_MODEL,
    source: process.env.SQLSM_OPENAI_KEY ? "env" : key ? "file" : "",
  };
}

export function saveOpenAiKey(apiKey: string, model?: string) {
  const key = String(apiKey || "").trim();
  if (key && !key.startsWith("sk-")) {
    throw new ClientError("OpenAI key should start with sk-.");
  }
  mkdirSync(STORE_DIR, { recursive: true });
  const current = loadStore();
  const next: Store = {
    apiKey: key || current.apiKey,
    model: String(model || current.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
  };
  writeFileSync(PATH, JSON.stringify(next, null, 2));
  try {
    chmodSync(PATH, 0o600);
  } catch {
    /* ignore */
  }
  return openaiStatus();
}

export async function chatOpenAi(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts?: { json?: boolean; temperature?: number },
) {
  const store = loadStore();
  if (!store.apiKey) {
    throw new ClientError(
      "OpenAI key is not set.",
      "Paste the key on the AI page, or set SQLSM_OPENAI_KEY.",
    );
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${store.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: store.model || DEFAULT_MODEL,
      temperature: opts?.temperature ?? 0.15,
      messages,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const data = (await res.json()) as {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
  };
  if (!res.ok) {
    throw new ClientError(data.error?.message || `OpenAI HTTP ${res.status}`);
  }
  return String(data.choices?.[0]?.message?.content || "").trim();
}
