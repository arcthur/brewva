import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cloneCliShellPromptSnapshot, cloneCliShellPromptStashEntry } from "./prompt-parts.js";
import type {
  CliShellPromptSnapshot,
  CliShellPromptStashEntry,
  CliShellPromptStorePort,
} from "./types.js";

const MAX_PROMPT_HISTORY_ENTRIES = 50;
const MAX_PROMPT_STASH_ENTRIES = 50;

function normalizePathInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolveMaybeAbsolute(baseDir: string, pathText: string): string {
  const normalized = normalizePathInput(pathText);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(baseDir, normalized);
}

function resolveCliPromptStoreRoot(
  input: {
    env?: NodeJS.ProcessEnv;
    rootDir?: string;
  } = {},
): string {
  if (input.rootDir) {
    return resolve(input.rootDir);
  }
  const env = input.env ?? process.env;
  const agentDirFromEnv =
    typeof env["BREWVA_CODING_AGENT_DIR"] === "string" && env["BREWVA_CODING_AGENT_DIR"].trim()
      ? resolveMaybeAbsolute(process.cwd(), env["BREWVA_CODING_AGENT_DIR"])
      : undefined;
  const globalRoot = agentDirFromEnv
    ? resolve(agentDirFromEnv, "..")
    : typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim().length > 0
      ? resolveMaybeAbsolute(process.cwd(), join(env.XDG_CONFIG_HOME, "brewva"))
      : resolve(homedir(), ".config", "brewva");
  return join(globalRoot, "agent", "cli");
}

function parseJsonlFile<T>(filePath: string, maxEntries: number): T[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const text = readFileSync(filePath, "utf8");
  const entries = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is T => entry !== undefined)
    .slice(-maxEntries);
  if (entries.length > 0) {
    scheduleJsonlWrite(filePath, entries);
  }
  return entries;
}

async function writeJsonlFileAsync(filePath: string, entries: readonly unknown[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const payload =
    entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
  await writeFile(filePath, payload, "utf8");
}

async function appendJsonlAsync(filePath: string, entry: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function scheduleJsonlWrite(filePath: string, entries: readonly unknown[]): void {
  void writeJsonlFileAsync(filePath, entries).catch(() => {
    // Persistence is best-effort; in-memory state is the source of truth.
  });
}

function scheduleJsonlAppend(filePath: string, entry: unknown): void {
  void appendJsonlAsync(filePath, entry).catch(() => {
    // Persistence is best-effort; in-memory state is the source of truth.
  });
}

export function createCliShellPromptStore(
  input: {
    env?: NodeJS.ProcessEnv;
    rootDir?: string;
  } = {},
): CliShellPromptStorePort {
  const rootDir = resolveCliPromptStoreRoot(input);
  const historyPath = join(rootDir, "prompt-history.jsonl");
  const stashPath = join(rootDir, "prompt-stash.jsonl");
  let history = parseJsonlFile<CliShellPromptSnapshot>(historyPath, MAX_PROMPT_HISTORY_ENTRIES).map(
    (entry) => cloneCliShellPromptSnapshot(entry),
  );
  let stash = parseJsonlFile<CliShellPromptStashEntry>(stashPath, MAX_PROMPT_STASH_ENTRIES).map(
    (entry) => cloneCliShellPromptStashEntry(entry),
  );

  return {
    loadHistory() {
      return history.map((entry) => cloneCliShellPromptSnapshot(entry));
    },
    appendHistory(entry) {
      const nextEntry = cloneCliShellPromptSnapshot(entry);
      history = [...history, nextEntry].slice(-MAX_PROMPT_HISTORY_ENTRIES);
      if (history.length < MAX_PROMPT_HISTORY_ENTRIES) {
        scheduleJsonlAppend(historyPath, nextEntry);
        return;
      }
      scheduleJsonlWrite(historyPath, history);
    },
    loadStash() {
      return stash.map((entry) => cloneCliShellPromptStashEntry(entry));
    },
    pushStash(entry) {
      const nextEntry: CliShellPromptStashEntry = {
        ...cloneCliShellPromptSnapshot(entry),
        timestamp: Date.now(),
      };
      stash = [...stash, nextEntry].slice(-MAX_PROMPT_STASH_ENTRIES);
      scheduleJsonlWrite(stashPath, stash);
      return cloneCliShellPromptStashEntry(nextEntry);
    },
    popStash() {
      if (stash.length === 0) {
        return undefined;
      }
      const entry = stash.at(-1);
      stash = stash.slice(0, -1);
      scheduleJsonlWrite(stashPath, stash);
      return entry ? cloneCliShellPromptStashEntry(entry) : undefined;
    },
    removeStash(index) {
      if (index < 0 || index >= stash.length) {
        return;
      }
      stash = stash.filter((_entry, candidateIndex) => candidateIndex !== index);
      scheduleJsonlWrite(stashPath, stash);
    },
  };
}
