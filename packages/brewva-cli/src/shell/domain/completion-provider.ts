import { readdirSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ShellCompletionUsageEntry } from "./prompt.js";
import { fuzzyScore, normalizeSearchQuery } from "./search-scoring.js";

export type ShellCompletionTrigger = "/" | "@";

export interface ShellCompletionRange {
  readonly trigger: ShellCompletionTrigger;
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

export type ShellCompletionCandidateKind = "command" | "file" | "directory" | "agent" | "resource";

export type ShellCompletionAccept =
  | {
      readonly type: "runCommand";
      readonly commandId: string;
      readonly insertText: string;
      readonly argumentMode: "none" | "optional" | "required";
    }
  | {
      readonly type: "insertFilePart";
      readonly path: string;
    }
  | {
      readonly type: "insertDirectoryText";
      readonly text: string;
    }
  | {
      readonly type: "insertAgentPart";
      readonly agentId: string;
    }
  | {
      readonly type: "insertText";
      readonly text: string;
    };

export interface ShellCompletionCandidate {
  readonly id: string;
  readonly kind: ShellCompletionCandidateKind;
  readonly source: string;
  readonly label: string;
  readonly value: string;
  readonly insertText: string;
  readonly description?: string;
  readonly detail?: string;
  readonly aliases?: readonly string[];
  readonly searchText?: readonly string[];
  readonly suggested?: boolean;
  readonly accept: ShellCompletionAccept;
}

export interface ShellCompletionSource {
  readonly id: string;
  readonly triggers: readonly ShellCompletionTrigger[];
  resolve(range: ShellCompletionRange): readonly ShellCompletionCandidate[];
}

export interface ShellCompletionUsageStore {
  get(candidate: ShellCompletionCandidate): ShellCompletionUsageEntry | undefined;
  recordAccepted(candidate: ShellCompletionCandidate, now?: number): ShellCompletionUsageEntry;
}

export interface ShellCompletionAgent {
  readonly agentId: string;
  readonly description?: string;
}

export interface ShellCommandCompletionItem {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly category: string;
  readonly slashName?: string;
  readonly slashAliases: readonly string[];
  readonly suggested: boolean;
}

export interface ShellCommandCompletionProvider {
  slashCommands(): readonly ShellCommandCompletionItem[];
  getCommand(commandId: string):
    | {
        readonly slash?: {
          readonly argumentMode?: "none" | "optional" | "required";
        };
      }
    | undefined;
}

interface PathLineRange {
  readonly suffix: string;
}

interface PathQueryParts {
  readonly baseQuery: string;
  readonly lineRange?: PathLineRange;
}

const DEFAULT_WORKSPACE_ENTRY_LIMIT = 500;
const DEFAULT_WORKSPACE_DEPTH = 4;
const DEFAULT_COMPLETION_USAGE_LIMIT = 500;
const COMPLETION_FRECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

const IGNORED_WORKSPACE_DIRS = new Set([
  ".brewva",
  ".git",
  ".turbo",
  ".worktrees",
  "dist",
  "distribution",
  "node_modules",
]);

function completionUsageKey(kind: ShellCompletionCandidateKind, value: string): string {
  return `${kind}:${value}`;
}

function normalizeUsagePath(value: string): string {
  return stripPathLineRange(stripSuggestionQuotes(value)).replace(/\\/gu, "/");
}

function completionUsageValue(candidate: ShellCompletionCandidate): string {
  switch (candidate.accept.type) {
    case "runCommand":
      return candidate.accept.commandId;
    case "insertFilePart":
      return normalizeUsagePath(candidate.accept.path);
    case "insertDirectoryText":
      return normalizeUsagePath(candidate.accept.text);
    case "insertAgentPart":
      return candidate.accept.agentId.trim().toLowerCase();
    case "insertText":
      return candidate.accept.text;
    default: {
      const exhaustiveCheck: never = candidate.accept;
      void exhaustiveCheck;
      return candidate.value;
    }
  }
}

function normalizePathQuery(query: string): string {
  return query.trim().replace(/^"/u, "").replace(/\\/gu, "/");
}

function stripSuggestionQuotes(value: string): string {
  const trimmed = value.trim();
  const withoutLeadingQuote = trimmed.startsWith('"') ? trimmed.slice(1) : trimmed;
  return withoutLeadingQuote.endsWith('"') ? withoutLeadingQuote.slice(0, -1) : withoutLeadingQuote;
}

function isWithinWorkspace(cwd: string, path: string): boolean {
  const relativePath = relative(cwd, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function formatPathSuggestion(cwd: string, fullPath: string, isDirectory: boolean): string {
  const rel = relative(cwd, fullPath).split(sep).join("/");
  const normalized = rel.length > 0 ? rel : ".";
  const withDirectorySuffix = isDirectory ? `${normalized}/` : normalized;
  if (!withDirectorySuffix.includes(" ")) {
    return withDirectorySuffix;
  }
  return isDirectory ? `"${withDirectorySuffix}` : `"${withDirectorySuffix}"`;
}

function parsePathQuery(query: string): PathQueryParts {
  const normalized = normalizePathQuery(query);
  const hashIndex = normalized.lastIndexOf("#");
  if (hashIndex < 0) {
    return { baseQuery: normalized };
  }

  const linePart = normalized.slice(hashIndex + 1);
  const lineMatch = /^L?([1-9]\d*)(?:-L?([1-9]\d*))?$/iu.exec(linePart);
  if (!lineMatch) {
    return { baseQuery: normalized };
  }

  const startLine = Number(lineMatch[1]);
  const endLine = lineMatch[2] ? Number(lineMatch[2]) : undefined;
  return {
    baseQuery: normalized.slice(0, hashIndex),
    lineRange: {
      suffix:
        endLine !== undefined && endLine > startLine
          ? `#L${startLine}-L${endLine}`
          : `#L${startLine}`,
    },
  };
}

function stripPathLineRange(value: string): string {
  return parsePathQuery(value).baseQuery;
}

function appendPathLineRange(
  value: string,
  isDirectory: boolean,
  lineRange?: PathLineRange,
): string {
  if (!lineRange || isDirectory) {
    return value;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return `${value.slice(0, -1)}${lineRange.suffix}"`;
  }
  return `${value}${lineRange.suffix}`;
}

function pathSearchText(value: string): string[] {
  const normalized = stripPathLineRange(stripSuggestionQuotes(value)).replace(/\/$/u, "");
  const parts = normalized.split("/").filter(Boolean);
  return [normalized, basename(normalized), ...parts];
}

function createWorkspaceCandidate(input: {
  cwd: string;
  fullPath: string;
  isDirectory: boolean;
  lineRange?: PathLineRange;
}): ShellCompletionCandidate {
  const value = appendPathLineRange(
    formatPathSuggestion(input.cwd, input.fullPath, input.isDirectory),
    input.isDirectory,
    input.lineRange,
  );
  return {
    id: `${input.isDirectory ? "directory" : "file"}:${value}`,
    kind: input.isDirectory ? "directory" : "file",
    source: "workspace",
    label: `@${value}`,
    value,
    insertText: value,
    description: input.isDirectory ? "directory" : "file",
    detail: input.isDirectory ? "directory" : "file",
    searchText: pathSearchText(value),
    accept: input.isDirectory
      ? {
          type: "insertDirectoryText",
          text: value,
        }
      : {
          type: "insertFilePart",
          path: value,
        },
  };
}

function bestCandidateScore(query: string, candidate: ShellCompletionCandidate): number | null {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) {
    return candidate.kind === "command" ? 0 : candidate.suggested ? 100 : 0;
  }

  let best: number | null = null;
  const fields =
    candidate.kind === "command"
      ? [candidate.value, candidate.label.replace(/^\//u, ""), ...(candidate.aliases ?? [])]
      : [
          candidate.value,
          candidate.label.replace(/^[@/]/u, ""),
          candidate.description ?? "",
          candidate.detail ?? "",
          ...(candidate.aliases ?? []),
          ...(candidate.searchText ?? []),
        ];
  for (const field of fields) {
    const score = fuzzyScore(normalized, field);
    if (score !== null && (best === null || score > best)) {
      best = score;
    }
  }
  return best;
}

function sourcePriority(candidate: ShellCompletionCandidate): number {
  switch (candidate.kind) {
    case "command":
      return 500;
    case "agent":
      return 400;
    case "directory":
      return 300;
    case "file":
      return 250;
    case "resource":
      return 200;
    default: {
      const exhaustiveCheck: never = candidate.kind;
      void exhaustiveCheck;
      return 0;
    }
  }
}

function frecencyBoost(usage: ShellCompletionUsageEntry | undefined): number {
  if (!usage) {
    return 0;
  }
  const rawBoost = Math.min(240, usage.count * 80);
  const ageMs = Math.max(0, Date.now() - usage.lastUsedAt);
  const decay = 1 / (1 + ageMs / COMPLETION_FRECENCY_HALF_LIFE_MS);
  return rawBoost * decay;
}

function compareCandidates(
  left: { candidate: ShellCompletionCandidate; score: number; sourceIndex: number; index: number },
  right: { candidate: ShellCompletionCandidate; score: number; sourceIndex: number; index: number },
): number {
  return (
    right.score - left.score ||
    sourcePriority(right.candidate) - sourcePriority(left.candidate) ||
    left.sourceIndex - right.sourceIndex ||
    left.candidate.label.localeCompare(right.candidate.label) ||
    left.candidate.value.localeCompare(right.candidate.value) ||
    left.index - right.index
  );
}

export function createInMemoryCompletionUsageStore(
  entries: readonly ShellCompletionUsageEntry[] = [],
  onRecord?: (entry: ShellCompletionUsageEntry) => void,
  options?: { readonly maxEntries?: number },
): ShellCompletionUsageStore {
  const maxEntries = Math.max(1, Math.trunc(options?.maxEntries ?? DEFAULT_COMPLETION_USAGE_LIMIT));
  const usage = new Map<string, ShellCompletionUsageEntry>();
  const setUsage = (entry: ShellCompletionUsageEntry): void => {
    const key = completionUsageKey(entry.kind, entry.value);
    usage.delete(key);
    usage.set(key, { ...entry });
    while (usage.size > maxEntries) {
      const oldestKey = usage.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      usage.delete(oldestKey);
    }
  };
  for (const entry of [...entries].toSorted((left, right) => left.lastUsedAt - right.lastUsedAt)) {
    setUsage(entry);
  }
  return {
    get(candidate) {
      return usage.get(completionUsageKey(candidate.kind, completionUsageValue(candidate)));
    },
    recordAccepted(candidate, now = Date.now()) {
      const value = completionUsageValue(candidate);
      const key = completionUsageKey(candidate.kind, value);
      const current = usage.get(key);
      const next: ShellCompletionUsageEntry = {
        kind: candidate.kind,
        value,
        count: (current?.count ?? 0) + 1,
        lastUsedAt: now,
      };
      setUsage(next);
      onRecord?.(next);
      return next;
    },
  };
}

export class ShellCompletionProvider {
  readonly #sources: readonly ShellCompletionSource[];
  readonly #usageStore: ShellCompletionUsageStore;

  constructor(input: {
    readonly sources: readonly ShellCompletionSource[];
    readonly usageStore: ShellCompletionUsageStore;
  }) {
    this.#sources = [...input.sources];
    this.#usageStore = input.usageStore;
  }

  resolve(range: ShellCompletionRange): ShellCompletionCandidate[] {
    const ranked: Array<{
      candidate: ShellCompletionCandidate;
      score: number;
      sourceIndex: number;
      index: number;
    }> = [];

    for (const [sourceIndex, source] of this.#sources.entries()) {
      if (!source.triggers.includes(range.trigger)) {
        continue;
      }
      const candidates = source.resolve(range);
      for (const [index, candidate] of candidates.entries()) {
        const baseScore = bestCandidateScore(range.query, candidate);
        if (baseScore === null) {
          continue;
        }
        ranked.push({
          candidate,
          score: baseScore + frecencyBoost(this.#usageStore.get(candidate)),
          sourceIndex,
          index,
        });
      }
    }

    return ranked.toSorted(compareCandidates).map((entry) => entry.candidate);
  }

  recordAccepted(candidate: ShellCompletionCandidate): void {
    this.#usageStore.recordAccepted(candidate);
  }
}

export function createCommandCompletionSource(
  commandProvider: ShellCommandCompletionProvider,
): ShellCompletionSource {
  return {
    id: "command",
    triggers: ["/"],
    resolve() {
      return commandProvider.slashCommands().map((command): ShellCompletionCandidate => {
        const source = commandProvider.getCommand(command.id);
        const argumentMode = source?.slash?.argumentMode ?? "none";
        const slashName = command.slashName ?? command.id;
        return {
          id: `command:${command.id}`,
          kind: "command",
          source: "command",
          label: `/${slashName}`,
          value: slashName,
          insertText: `/${slashName} `,
          description: command.description,
          detail: command.category,
          aliases: command.slashAliases,
          searchText: [command.title, command.category],
          suggested: command.suggested,
          accept: {
            type: "runCommand",
            commandId: command.id,
            insertText: `/${slashName} `,
            argumentMode,
          },
        };
      });
    },
  };
}

export function createAgentCompletionSource(
  listAgents: () => readonly ShellCompletionAgent[],
): ShellCompletionSource {
  return {
    id: "agent",
    triggers: ["@"],
    resolve() {
      const seen = new Set<string>();
      const candidates: ShellCompletionCandidate[] = [];
      for (const agent of listAgents()) {
        const agentId = agent.agentId.trim();
        if (!agentId || seen.has(agentId)) {
          continue;
        }
        seen.add(agentId);
        candidates.push({
          id: `agent:${agentId}`,
          kind: "agent",
          source: "agent",
          label: `@${agentId}`,
          value: agentId,
          insertText: agentId,
          description: agent.description,
          detail: "agent",
          searchText: [agentId, agent.description ?? ""],
          accept: {
            type: "insertAgentPart",
            agentId,
          },
        });
      }
      return candidates;
    },
  };
}

export function createWorkspaceReferenceCompletionSource(input: {
  readonly cwd: string;
  readonly limit?: number;
  readonly maxDepth?: number;
}): ShellCompletionSource {
  const cwd = resolve(input.cwd);
  const limit = input.limit ?? DEFAULT_WORKSPACE_ENTRY_LIMIT;
  const maxDepth = input.maxDepth ?? DEFAULT_WORKSPACE_DEPTH;

  const listValidEntries = (
    directory: string,
  ): Array<{ fullPath: string; isDirectory: boolean }> => {
    if (!isWithinWorkspace(cwd, directory)) {
      return [];
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const validEntries: Array<{ fullPath: string; isDirectory: boolean }> = [];
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const isDirectory = entry.isDirectory();
      if (isDirectory && IGNORED_WORKSPACE_DIRS.has(entry.name)) {
        continue;
      }
      validEntries.push({ fullPath: join(directory, entry.name), isDirectory });
    }
    return validEntries;
  };

  const readDirectoryCandidates = (
    directory: string,
    output: ShellCompletionCandidate[],
    lineRange?: PathLineRange,
  ): void => {
    for (const { fullPath, isDirectory } of listValidEntries(directory)) {
      if (output.length >= limit) {
        return;
      }
      output.push(createWorkspaceCandidate({ cwd, fullPath, isDirectory, lineRange }));
    }
  };

  const walkCandidates = (
    directory: string,
    depth: number,
    output: ShellCompletionCandidate[],
    lineRange?: PathLineRange,
  ): void => {
    if (output.length >= limit || depth > maxDepth) {
      return;
    }
    const directories: Array<{ fullPath: string }> = [];
    for (const { fullPath, isDirectory } of listValidEntries(directory)) {
      if (output.length >= limit) {
        return;
      }
      output.push(createWorkspaceCandidate({ cwd, fullPath, isDirectory, lineRange }));
      if (isDirectory) {
        directories.push({ fullPath });
      }
    }
    for (const childDirectory of directories) {
      if (output.length >= limit) {
        return;
      }
      walkCandidates(childDirectory.fullPath, depth + 1, output, lineRange);
    }
  };

  return {
    id: "workspace",
    triggers: ["@"],
    resolve(range) {
      const { baseQuery: query, lineRange } = parsePathQuery(range.query);
      const output: ShellCompletionCandidate[] = [];
      if (!query) {
        readDirectoryCandidates(cwd, output);
        return output;
      }

      if (query.includes("/")) {
        const directoryQuery = query.endsWith("/") ? query : dirname(query);
        const directory = resolve(cwd, directoryQuery === "." ? "" : directoryQuery);
        readDirectoryCandidates(directory, output, lineRange);
        return output;
      }

      walkCandidates(cwd, 0, output, lineRange);
      return output;
    },
  };
}
