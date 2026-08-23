import { existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { settings } from "../config.js";
import { ClientError } from "../errors.js";

export function defaultDataFolder() {
  return settings.exportDir;
}

export function existingStartDir(path = "") {
  const text = (path || "").trim();
  if (text && existsSync(text)) return resolve(text);
  const fallback = defaultDataFolder();
  try {
    mkdirSync(fallback, { recursive: true });
    return resolve(fallback);
  } catch {
    return homedir();
  }
}

export function safeName(name: string) {
  return String(name || "data").replace(/[<>:"|?*/\\]/g, "_") || "data";
}

export function normalizeDir(path: string) {
  return resolve((path || "").trim() || defaultDataFolder());
}

export function ensureWritableDir(path: string) {
  const folder = normalizeDir(path);
  try {
    mkdirSync(folder, { recursive: true });
    const probe = join(folder, ".sqlsm-write-test");
    writeFileSync(probe, "ok");
    unlinkSync(probe);
  } catch (exc) {
    throw new ClientError(`Folder is not writable: ${folder}`, String(exc));
  }
  return folder;
}

export function folderShortcuts() {
  const home = homedir();
  const candidates: [string, string][] = [
    ["Home", home],
    ["Desktop", join(home, "Desktop")],
    ["Documents", join(home, "Documents")],
    ["App data", defaultDataFolder()],
  ];
  if (process.platform === "darwin") candidates.push(["Volumes", "/Volumes"]);
  const items: { name: string; path: string; kind: string }[] = [];
  const seen = new Set<string>();
  for (const [name, path] of candidates) {
    const full = resolve(path);
    if (seen.has(full) || !existsSync(full)) continue;
    seen.add(full);
    items.push({ name, path: full, kind: "shortcut" });
  }
  return items;
}

export function listFolders(path: string) {
  const text = (path || "").trim();
  let folder = text ? normalizeDir(text) : existingStartDir("");
  if (!existsSync(folder)) folder = existingStartDir("");
  let parent = dirname(folder);
  if (folder === "/" || /^[A-Za-z]:\\?$/.test(folder)) parent = "";
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch (exc) {
    throw new ClientError("Cannot read folder.", String(exc));
  }
  const entries = names
    .filter((name) => !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .flatMap((name) => {
      const full = join(folder, name);
      try {
        if (statSync(full).isDirectory()) return [{ name, path: full, kind: "dir" }];
      } catch {
        /* ignore */
      }
      return [];
    });
  return { path: folder, parent, entries, shortcuts: folderShortcuts() };
}

export function pickFolder(path: string) {
  const folder = existingStartDir(path);
  return { path: folder };
}
