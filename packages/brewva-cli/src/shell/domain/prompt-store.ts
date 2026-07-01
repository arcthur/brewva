import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { rewriteFileAtomic } from "@brewva/brewva-std/node/fs";
import { cloneCliShellPromptSnapshot, cloneCliShellPromptStashEntry } from "./prompt-parts.js";
import type { ShellCompletionUsageEntry } from "./prompt.js";
import type {
  CliShellPromptSnapshot,
  CliShellPromptStashEntry,
  CliShellPromptStorePort,
  CliShellUiDiffPrefs,
  CliShellUiViewPrefs,
} from "./prompt.js";

const MAX_PROMPT_HISTORY_ENTRIES = 50;
const MAX_PROMPT_STASH_ENTRIES = 50;
const MAX_COMPLETION_USAGE_ENTRIES = 500;

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

function parseJsonArrayFile<T>(filePath: string, maxEntries: number): T[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.slice(-maxEntries) as T[];
  } catch {
    return [];
  }
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

async function writeJsonFileAsync(filePath: string, entries: readonly unknown[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

interface CliShellUiPrefs {
  theme?: string;
  view?: CliShellUiViewPrefs;
  diff?: CliShellUiDiffPrefs;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readUiPrefsFile(filePath: string): CliShellUiPrefs {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const record = asRecord(JSON.parse(readFileSync(filePath, "utf8")));
    if (!record) {
      return {};
    }
    const prefs: CliShellUiPrefs = {};
    if (typeof record.theme === "string") {
      prefs.theme = record.theme;
    }
    const view = asRecord(record.view);
    if (view && typeof view.toolDetails === "boolean" && typeof view.showThinking === "boolean") {
      prefs.view = { toolDetails: view.toolDetails, showThinking: view.showThinking };
    }
    const diff = asRecord(record.diff);
    if (diff && typeof diff.style === "string" && typeof diff.wrapMode === "string") {
      prefs.diff = { style: diff.style, wrapMode: diff.wrapMode };
    }
    return prefs;
  } catch {
    // Corrupt prefs file — ignore and fall back to defaults.
  }
  return {};
}

function scheduleJsonlWrite(filePath: string, entries: readonly unknown[]): void {
  void writeJsonlFileAsync(filePath, entries).catch(() => {
    // Persistence is best-effort; in-memory state is the source of claim.
  });
}

function scheduleJsonlAppend(filePath: string, entry: unknown): void {
  void appendJsonlAsync(filePath, entry).catch(() => {
    // Persistence is best-effort; in-memory state is the source of claim.
  });
}

function scheduleJsonWrite(filePath: string, entries: readonly unknown[]): void {
  void writeJsonFileAsync(filePath, entries).catch(() => {
    // Persistence is best-effort; in-memory state is the source of claim.
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
  const completionUsagePath = join(rootDir, "completion-usage.json");
  let history = parseJsonlFile<CliShellPromptSnapshot>(historyPath, MAX_PROMPT_HISTORY_ENTRIES).map(
    (entry) => cloneCliShellPromptSnapshot(entry),
  );
  let stash = parseJsonlFile<CliShellPromptStashEntry>(stashPath, MAX_PROMPT_STASH_ENTRIES).map(
    (entry) => cloneCliShellPromptStashEntry(entry),
  );
  let completionUsage = parseJsonArrayFile<ShellCompletionUsageEntry>(
    completionUsagePath,
    MAX_COMPLETION_USAGE_ENTRIES,
  );
  const uiPrefsPath = join(rootDir, "ui-prefs.json");
  let uiPrefs = readUiPrefsFile(uiPrefsPath);
  // Serialize ui-prefs writes through one chain: theme, view, and diff share a
  // single file, so two rapid saves must not land out of order and lose an
  // update. Each write emits the LATEST merged snapshot, and rewriteFileAtomic
  // makes it crash-atomic (tmp + fsync + rename), matching the store's durability
  // discipline. Best-effort — in-memory `uiPrefs` stays the source of truth.
  let uiPrefsWriteChain: Promise<void> = Promise.resolve();
  const scheduleUiPrefsWrite = (): void => {
    uiPrefsWriteChain = uiPrefsWriteChain
      .then(async () => {
        await mkdir(dirname(uiPrefsPath), { recursive: true });
        rewriteFileAtomic(uiPrefsPath, `${JSON.stringify(uiPrefs, null, 2)}\n`);
      })
      .catch(() => {
        // Persistence is best-effort; in-memory state is the source of truth.
      });
  };

  return {
    loadHistory() {
      return history.map((entry) => cloneCliShellPromptSnapshot(entry));
    },
    appendHistory(entry) {
      // Suppress an adjacent duplicate so re-submitting the same prompt does not
      // fill history with repeats.
      if (history.at(-1)?.text === entry.text) {
        return;
      }
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
    loadCompletionUsage() {
      return completionUsage.map((entry) => ({ ...entry }));
    },
    recordCompletionUsage(entry) {
      const key = `${entry.kind}:${entry.value}`;
      completionUsage = [
        ...completionUsage.filter((candidate) => `${candidate.kind}:${candidate.value}` !== key),
        { ...entry },
      ].slice(-MAX_COMPLETION_USAGE_ENTRIES);
      scheduleJsonWrite(completionUsagePath, completionUsage);
    },
    loadUiTheme() {
      return uiPrefs.theme;
    },
    saveUiTheme(name) {
      uiPrefs = { ...uiPrefs, theme: name };
      scheduleUiPrefsWrite();
    },
    loadUiView() {
      return uiPrefs.view;
    },
    saveUiView(view) {
      uiPrefs = { ...uiPrefs, view: { ...view } };
      scheduleUiPrefsWrite();
    },
    loadUiDiff() {
      return uiPrefs.diff;
    },
    saveUiDiff(diff) {
      uiPrefs = { ...uiPrefs, diff: { ...diff } };
      scheduleUiPrefsWrite();
    },
  };
}
