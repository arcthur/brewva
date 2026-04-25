import { extname, isAbsolute, relative } from "node:path";
import process from "node:process";
import type { BrewvaRenderableComponent, BrewvaToolDefinition } from "@brewva/brewva-substrate";
import type { CliShellTranscriptToolPart } from "../../src/shell/transcript.js";
import type { SessionPalette } from "./palette.js";

export interface ToolRenderCache {
  readonly sessionId: string | null;
  readonly stateByToolCallId: Map<string, unknown>;
  readonly callComponentsByToolCallId: Map<string, BrewvaRenderableComponent>;
  readonly resultComponentsByToolCallId: Map<string, BrewvaRenderableComponent>;
  resetForSession(sessionId: string): void;
  clear(): void;
}

export function createToolRenderCache(): ToolRenderCache {
  let sessionId: string | null = null;
  const stateByToolCallId = new Map<string, unknown>();
  const callComponentsByToolCallId = new Map<string, BrewvaRenderableComponent>();
  const resultComponentsByToolCallId = new Map<string, BrewvaRenderableComponent>();
  const clear = () => {
    stateByToolCallId.clear();
    callComponentsByToolCallId.clear();
    resultComponentsByToolCallId.clear();
  };
  return {
    get sessionId() {
      return sessionId;
    },
    stateByToolCallId,
    callComponentsByToolCallId,
    resultComponentsByToolCallId,
    resetForSession(nextSessionId) {
      if (sessionId === nextSessionId) {
        return;
      }
      sessionId = nextSessionId;
      clear();
    },
    clear() {
      sessionId = null;
      clear();
    },
  };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export interface ToolDiffFile {
  path: string;
  displayPath: string;
  diff: string;
  action?: string;
  additions?: number;
  deletions?: number;
  movePath?: string;
}

export type ToolDiffPayload =
  | {
      kind: "single";
      path?: string;
      diff: string;
    }
  | {
      kind: "files";
      files: ToolDiffFile[];
    };

function readToolRenderState(cache: ToolRenderCache, toolCallId: string): unknown {
  let state = cache.stateByToolCallId.get(toolCallId);
  if (!state) {
    state = {};
    cache.stateByToolCallId.set(toolCallId, state);
  }
  return state;
}

export function renderToolComponentLines(input: {
  kind: "call" | "result";
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  toolRenderCache: ToolRenderCache;
  part: CliShellTranscriptToolPart;
  width: number;
  expanded?: boolean;
}): string[] {
  const toolDefinition = input.toolDefinitions.get(input.part.toolName);
  if (!toolDefinition) {
    return [];
  }

  const renderTheme = {
    bold(text: string) {
      return text;
    },
    fg(_tone: string, text: string) {
      return text;
    },
  };

  if (input.kind === "call") {
    if (!toolDefinition.renderCall || input.part.args === undefined) {
      return [];
    }
    const component = toolDefinition.renderCall(input.part.args as never, renderTheme, {
      args: input.part.args,
      toolCallId: input.part.toolCallId,
      invalidate: () => undefined,
      lastComponent: input.toolRenderCache.callComponentsByToolCallId.get(input.part.toolCallId),
      state: readToolRenderState(input.toolRenderCache, input.part.toolCallId),
      cwd: process.cwd(),
      executionStarted: input.part.status !== "pending",
      argsComplete: true,
      isPartial: input.part.status !== "completed" && input.part.status !== "error",
      expanded: input.expanded ?? true,
      showImages: false,
      isError: input.part.status === "error",
    });
    input.toolRenderCache.callComponentsByToolCallId.set(input.part.toolCallId, component);
    return component.render(input.width).filter((line) => line.length > 0);
  }

  const payload = input.part.result ?? input.part.partialResult;
  if (!toolDefinition.renderResult || !payload) {
    return [];
  }
  const component = toolDefinition.renderResult(
    {
      content: payload.content as never,
      details: payload.details,
      isError: payload.isError,
      ...(payload.display ? { display: payload.display } : {}),
    },
    {
      expanded: input.expanded ?? true,
      isPartial: !input.part.result,
    },
    renderTheme,
    {
      args: input.part.args,
      toolCallId: input.part.toolCallId,
      invalidate: () => undefined,
      lastComponent: input.toolRenderCache.resultComponentsByToolCallId.get(input.part.toolCallId),
      state: readToolRenderState(input.toolRenderCache, input.part.toolCallId),
      cwd: process.cwd(),
      executionStarted: input.part.status !== "pending",
      argsComplete: true,
      isPartial: !input.part.result,
      expanded: input.expanded ?? true,
      showImages: false,
      isError: input.part.status === "error",
    },
  );
  input.toolRenderCache.resultComponentsByToolCallId.set(input.part.toolCallId, component);
  return component.render(input.width).filter((line) => line.length > 0);
}

export function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function readRecordString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function readRecordStringMaybeEmpty(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function readRecordNumber(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeDisplayPath(path: string | undefined): string | undefined {
  if (!path || path.length === 0) {
    return undefined;
  }
  if (!isAbsolute(path)) {
    return path;
  }

  const cwd = process.cwd();
  const relativePath = relative(cwd, path);
  if (relativePath.length === 0) {
    return ".";
  }
  if (!relativePath.startsWith("..")) {
    return relativePath;
  }

  const home = process.env.HOME;
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }

  return path;
}

const DIFF_SOURCE_RECORD_KEYS = ["previewDiff", "diffPreview", "preview"] as const;

function readToolDetails(part: CliShellTranscriptToolPart): Record<string, unknown> | undefined {
  return asRecord(part.result?.details) ?? asRecord(part.partialResult?.details);
}

export function readToolPath(part: CliShellTranscriptToolPart): string | undefined {
  const args = asRecord(part.args);
  return normalizeDisplayPath(readRecordString(args, ["path", "filePath", "file_path"]));
}

export function readToolCommand(part: CliShellTranscriptToolPart): string | undefined {
  return readRecordString(asRecord(part.args), ["command", "cmd"]);
}

export function readToolTextInput(part: CliShellTranscriptToolPart): string | undefined {
  return readRecordString(asRecord(part.args), ["content", "text"]);
}

export function readToolRangeSuffix(part: CliShellTranscriptToolPart): string {
  const args = asRecord(part.args);
  const offset = readRecordNumber(args, ["offset", "startLine", "line"]);
  const limit = readRecordNumber(args, ["limit", "lineCount", "count"]);
  if (offset === undefined && limit === undefined) {
    return "";
  }
  const startLine = offset ?? 1;
  if (limit !== undefined && limit > 1) {
    return `:${startLine}-${startLine + limit - 1}`;
  }
  return `:${startLine}`;
}

function normalizeDiffFile(value: unknown): ToolDiffFile | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const rawDiff = readRecordStringMaybeEmpty(record, ["diff", "patch", "diffText", "content"]);
  const action = readRecordString(record, ["action", "type", "status", "kind"]);
  const deletions = readRecordNumber(record, ["deletions", "removed", "removedLines"]);
  if (rawDiff === undefined && action !== "delete" && deletions === undefined) {
    return undefined;
  }
  const rawPath = readRecordString(record, [
    "path",
    "filePath",
    "file_path",
    "relativePath",
    "relative_path",
  ]);
  const displayPath = normalizeDisplayPath(rawPath) ?? "file";
  return {
    path: rawPath ?? displayPath,
    displayPath,
    diff: rawDiff ?? "",
    action,
    additions: readRecordNumber(record, ["additions", "added", "addedLines"]),
    deletions,
    movePath: normalizeDisplayPath(readRecordString(record, ["movePath", "newPath", "toPath"])),
  };
}

function readDiffFiles(details: Record<string, unknown> | undefined): ToolDiffFile[] {
  const directFiles = details?.files;
  if (Array.isArray(directFiles)) {
    return directFiles.flatMap((file) => {
      const normalized = normalizeDiffFile(file);
      return normalized ? [normalized] : [];
    });
  }

  const patchSet = asRecord(details?.patchSet ?? details?.patch_set ?? details?.patches);
  const changes = patchSet?.changes;
  if (Array.isArray(changes)) {
    return changes.flatMap((change) => {
      const normalized = normalizeDiffFile(change);
      return normalized ? [normalized] : [];
    });
  }

  return [];
}

function readDiffPathFromRecord(
  details: Record<string, unknown> | undefined,
  fallback?: string,
): string | undefined {
  return (
    normalizeDisplayPath(
      readRecordString(details, ["path", "filePath", "file_path", "relativePath", "relative_path"]),
    ) ?? fallback
  );
}

function readDirectDiffPayloadFromDetails(
  details: Record<string, unknown> | undefined,
  path?: string,
): ToolDiffPayload | undefined {
  const files = readDiffFiles(details);
  if (files.length > 0) {
    return {
      kind: "files",
      files,
    };
  }

  const diff =
    readRecordString(details, ["diff", "patch", "diffText"]) ??
    readRecordStringMaybeEmpty(details, ["unifiedDiff"]);
  if (!diff || diff.length === 0) {
    return undefined;
  }
  return {
    kind: "single",
    path,
    diff,
  };
}

export function readDiffSourceRecordFromDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }
  const direct = readDirectDiffPayloadFromDetails(details, readDiffPathFromRecord(details));
  if (direct) {
    return details;
  }
  const directError = readRecordString(details, ["error"]);
  if (directError) {
    return details;
  }
  for (const key of DIFF_SOURCE_RECORD_KEYS) {
    const nested = asRecord(details[key]);
    if (!nested) {
      continue;
    }
    const nestedPayload = readDirectDiffPayloadFromDetails(nested, readDiffPathFromRecord(nested));
    const nestedError = readRecordString(nested, ["error"]);
    if (nestedPayload || nestedError) {
      return nested;
    }
  }
  return undefined;
}

export function readDiffPayloadFromDetails(
  details: Record<string, unknown> | undefined,
  path?: string,
): ToolDiffPayload | undefined {
  const direct = readDirectDiffPayloadFromDetails(details, readDiffPathFromRecord(details, path));
  if (direct) {
    return direct;
  }

  for (const key of DIFF_SOURCE_RECORD_KEYS) {
    const nested = asRecord(details?.[key]);
    if (!nested) {
      continue;
    }
    const nestedPayload = readDirectDiffPayloadFromDetails(
      nested,
      readDiffPathFromRecord(nested, path),
    );
    if (nestedPayload) {
      return nestedPayload;
    }
  }
  return undefined;
}

export function readToolDiffPayload(part: CliShellTranscriptToolPart): ToolDiffPayload | undefined {
  const details = readToolDetails(part);
  return readDiffPayloadFromDetails(details, readToolPath(part));
}

function readWorkerSessionIdFromRecord(
  record: Record<string, unknown> | undefined,
): string | undefined {
  const direct = readRecordString(record, ["workerSessionId", "childSessionId"]);
  if (direct) {
    return direct;
  }
  const outcomes = record?.outcomes;
  if (Array.isArray(outcomes)) {
    for (const outcome of outcomes) {
      const nested = readWorkerSessionIdFromRecord(asRecord(outcome));
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

export function readToolWorkerSessionId(part: CliShellTranscriptToolPart): string | undefined {
  return readWorkerSessionIdFromRecord(readToolDetails(part));
}

export function inferFiletype(path: string | undefined): string {
  if (!path) {
    return "text";
  }
  const extension = extname(path).replace(/^\./u, "");
  return extension.length > 0 ? extension : "text";
}

export function truncateText(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/u);
  if (lines.length <= maxLines) {
    return text;
  }
  return [...lines.slice(0, maxLines), "..."].join("\n");
}

export function summarizeInput(input: unknown, omit: readonly string[] = []): string {
  const record = asRecord(input);
  if (!record) {
    return "";
  }
  const primitives = Object.entries(record).filter(([key, value]) => {
    if (omit.includes(key)) {
      return false;
    }
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  });
  if (primitives.length === 0) {
    return "";
  }
  return `[${primitives.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`;
}

export function readToolResultText(part: CliShellTranscriptToolPart): string {
  const payload = part.result ?? part.partialResult;
  if (!payload) {
    return "";
  }
  return payload.content
    .filter(
      (contentPart): contentPart is Extract<(typeof payload.content)[number], { type: "text" }> =>
        contentPart.type === "text",
    )
    .map((contentPart) => contentPart.text)
    .join("\n");
}

function readDisplayTextValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readToolDisplaySummaryText(part: CliShellTranscriptToolPart): string | undefined {
  const payload = part.result ?? part.partialResult;
  return readDisplayTextValue(payload?.display?.summaryText);
}

export function readToolDisplayDetailsText(part: CliShellTranscriptToolPart): string | undefined {
  const payload = part.result ?? part.partialResult;
  return (
    readDisplayTextValue(payload?.display?.detailsText) ??
    readDisplayTextValue(payload?.display?.rawText)
  );
}

export function readToolDisplayText(part: CliShellTranscriptToolPart, expanded: boolean): string {
  if (expanded) {
    return readToolDisplayDetailsText(part) ?? readToolResultText(part);
  }
  return readToolDisplaySummaryText(part) ?? readToolResultText(part);
}

export function readToolErrorText(part: CliShellTranscriptToolPart): string | undefined {
  if (part.status !== "error") {
    return undefined;
  }
  const text = readToolResultText(part).trim();
  return text.length > 0 ? text : "Tool execution failed.";
}

export type { SessionPalette };
