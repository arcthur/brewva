import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonFileSync } from "@brewva/brewva-std/node/fs";
import { toErrorMessage, isRecord } from "@brewva/brewva-std/unknown";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type { SourcePatchIntent } from "@brewva/brewva-vocabulary/workbench";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolRuntime } from "../../contracts/index.js";
import {
  prepareAndStoreSourcePatchPlan,
  recordSourceSnapshot,
  toSourceFileResourceUri,
} from "../../internal/source-patch-gate.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { getToolSessionId } from "../../runtime-port/parallel-read.js";
import {
  resolveReadableScopedPath,
  resolveToolTargetScope,
  type ToolTargetScope,
} from "../../runtime-port/target-scope.js";
import { errTextResult, inconclusiveTextResult, okTextResult } from "../../utils/result.js";
import {
  type LspPosition,
  type LspRange,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from "./lsp-server/client.js";
import {
  lspWorkspaceServerManager,
  shutdownLspWorkspaceServerManager,
  type LspWorkspaceClientLease,
} from "./lsp-server/manager.js";

export { shutdownLspWorkspaceServerManager };

type LspToolName =
  | "lsp_status"
  | "lsp_hover"
  | "lsp_definition"
  | "lsp_references"
  | "lsp_type_definition"
  | "lsp_implementation"
  | "lsp_diagnostics"
  | "lsp_rename"
  | "lsp_file_rename"
  | "lsp_code_action"
  | "lsp_format";

interface LspServerResolution {
  readonly available: boolean;
  readonly command?: string;
  readonly args: readonly string[];
  readonly source?: "workspace_config" | "workspace" | "path";
  readonly reason?: string;
}

interface TextEditDocument {
  readonly uri: string;
  readonly edits: readonly LspTextEdit[];
}

const POSITION_SCHEMA = {
  uri: Type.String({ minLength: 1 }),
  line: Type.Integer({ minimum: 0 }),
  character: Type.Integer({ minimum: 0 }),
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? (value as Record<string, unknown>) : undefined;
}

function splitCommand(value: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const parts = value.split(/\s+/u).filter(Boolean);
  return {
    command: parts[0] ?? value,
    args: parts.slice(1),
  };
}

function commandFromConfigValue(value: unknown):
  | {
      readonly command: string;
      readonly args: readonly string[];
    }
  | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return splitCommand(value.trim());
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    const [command, ...args] = value;
    return command ? { command, args } : undefined;
  }
  const record = asRecord(value);
  const command = typeof record?.command === "string" ? record.command : undefined;
  const args = Array.isArray(record?.args)
    ? record.args.filter((entry): entry is string => typeof entry === "string")
    : [];
  return command ? { command, args } : undefined;
}

function readWorkspaceConfiguredServer(cwd: string):
  | {
      readonly command: string;
      readonly args: readonly string[];
    }
  | undefined {
  const brewvaConfig = commandFromConfigValue(readJsonFileSync(resolve(cwd, ".brewva/lsp.json")));
  if (brewvaConfig) {
    return brewvaConfig;
  }
  const rootConfig = commandFromConfigValue(readJsonFileSync(resolve(cwd, "brewva.lsp.json")));
  if (rootConfig) {
    return rootConfig;
  }
  const packageJson = asRecord(readJsonFileSync(resolve(cwd, "package.json")));
  const brewva = asRecord(packageJson?.brewva);
  const lsp = asRecord(brewva?.lsp);
  return commandFromConfigValue(lsp);
}

function findOnPath(command: string): string | undefined {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(entry, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveTypeScriptLanguageServer(cwd: string): LspServerResolution {
  const configured = readWorkspaceConfiguredServer(cwd);
  if (configured) {
    return {
      available: true,
      command: configured.command,
      args: configured.args,
      source: "workspace_config",
    };
  }

  const workspaceServer = resolve(cwd, "node_modules/.bin/typescript-language-server");
  if (existsSync(workspaceServer)) {
    return {
      available: true,
      command: workspaceServer,
      args: ["--stdio"],
      source: "workspace",
    };
  }

  const pathServer = findOnPath("typescript-language-server");
  if (pathServer) {
    return {
      available: true,
      command: pathServer,
      args: ["--stdio"],
      source: "path",
    };
  }

  return {
    available: false,
    args: [],
    reason: "typescript_language_server_unavailable",
  };
}

function unavailable(toolName: LspToolName, resolution: LspServerResolution) {
  return inconclusiveTextResult(
    [
      `[${toolName}]`,
      "status: unavailable",
      `reason: ${resolution.reason ?? "lsp_request_transport_unavailable"}`,
      "next_step: configure .brewva/lsp.json or install typescript-language-server in the workspace.",
    ].join("\n"),
    {
      ok: false,
      status: "unavailable",
      reason: resolution.reason ?? "lsp_request_transport_unavailable",
      stderr: null,
    },
  );
}

function languageIdForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".tsx":
      return "typescriptreact";
    case ".ts":
      return "typescript";
    case ".jsx":
      return "javascriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    default:
      return "plaintext";
  }
}

function uriToPath(uri: string, scope: ToolTargetScope): string | undefined {
  if (uri.startsWith("file://")) {
    const path = fileURLToPath(uri);
    return resolveReadableScopedPath(path, scope) ?? undefined;
  }
  if (uri.startsWith("brewva-resource:///file/")) {
    const path = decodeURIComponent(uri.slice("brewva-resource:///file/".length));
    return resolveReadableScopedPath(path, scope) ?? undefined;
  }
  return resolveReadableScopedPath(uri, scope) ?? undefined;
}

function pathToLspUri(path: string): string {
  return pathToFileURL(path).toString();
}

function lspPosition(line: number, character: number): LspPosition {
  return { line, character };
}

function lspRange(input: {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}): LspRange {
  return {
    start: lspPosition(input.startLine, input.startCharacter),
    end: lspPosition(input.endLine, input.endCharacter),
  };
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function offsetAt(text: string, position: LspPosition): number {
  const offsets = lineOffsets(text);
  const lineOffset = offsets[Math.min(position.line, offsets.length - 1)] ?? text.length;
  return Math.min(text.length, lineOffset + position.character);
}

function applyTextEdits(text: string, edits: readonly LspTextEdit[]): string {
  const sorted = [...edits].toSorted((left, right) => {
    const leftOffset = offsetAt(text, left.range.start);
    const rightOffset = offsetAt(text, right.range.start);
    return rightOffset - leftOffset;
  });
  let next = text;
  for (const edit of sorted) {
    const start = offsetAt(next, edit.range.start);
    const end = offsetAt(next, edit.range.end);
    next = `${next.slice(0, start)}${edit.newText}${next.slice(end)}`;
  }
  return next;
}

function isTextEdit(value: unknown): value is LspTextEdit {
  const record = asRecord(value);
  const range = asRecord(record?.range);
  const start = asRecord(range?.start);
  const end = asRecord(range?.end);
  return (
    typeof record?.newText === "string" &&
    typeof start?.line === "number" &&
    typeof start.character === "number" &&
    typeof end?.line === "number" &&
    typeof end.character === "number"
  );
}

function collectTextEditDocuments(edit: LspWorkspaceEdit): TextEditDocument[] {
  const documents: TextEditDocument[] = [];
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      documents.push({ uri, edits: edits.filter(isTextEdit) });
    }
  }
  for (const entry of edit.documentChanges ?? []) {
    const record = asRecord(entry);
    const textDocument = asRecord(record?.textDocument);
    const uri = typeof textDocument?.uri === "string" ? textDocument.uri : undefined;
    const edits = Array.isArray(record?.edits) ? record.edits.filter(isTextEdit) : undefined;
    if (uri && edits) {
      documents.push({ uri, edits });
    }
  }
  return documents;
}

function collectResourceIntents(
  edit: LspWorkspaceEdit,
  scope: ToolTargetScope,
  options?: { readonly skipCreateUris?: ReadonlySet<string> },
): SourcePatchIntent[] {
  const intents: SourcePatchIntent[] = [];
  for (const entry of edit.documentChanges ?? []) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const kind = record?.kind;
    if (kind === "create" && typeof record.uri === "string") {
      if (options?.skipCreateUris?.has(record.uri)) {
        continue;
      }
      const path = uriToPath(record.uri, scope);
      if (path) {
        intents.push({
          kind: "create_file",
          uri: toSourceFileResourceUri(scope, path),
          content: "",
        });
      }
    }
    if (kind === "delete" && typeof record.uri === "string") {
      const path = uriToPath(record.uri, scope);
      if (path) {
        intents.push({ kind: "delete_file", uri: toSourceFileResourceUri(scope, path) });
      }
    }
    if (
      kind === "rename" &&
      typeof record.oldUri === "string" &&
      typeof record.newUri === "string"
    ) {
      const oldPath = uriToPath(record.oldUri, scope);
      const newPath = uriToPath(record.newUri, scope);
      if (oldPath && newPath) {
        intents.push({
          kind: "rename_file",
          uri: toSourceFileResourceUri(scope, oldPath),
          newUri: toSourceFileResourceUri(scope, newPath),
        });
      }
    }
  }
  return intents;
}

function workspaceEditToIntents(input: {
  readonly edit: LspWorkspaceEdit;
  readonly scope: ToolTargetScope;
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly sessionId?: string;
}): SourcePatchIntent[] {
  const textEditDocuments = collectTextEditDocuments(input.edit);
  const textEditUris = new Set(
    textEditDocuments
      .filter((document) => document.edits.length > 0)
      .map((document) => document.uri),
  );
  const intents = collectResourceIntents(input.edit, input.scope, {
    skipCreateUris: textEditUris,
  });
  for (const document of textEditDocuments) {
    const path = uriToPath(document.uri, input.scope);
    if (!path || document.edits.length === 0) {
      continue;
    }
    if (!existsSync(path)) {
      const content = applyTextEdits("", document.edits);
      intents.push({
        kind: "create_file",
        uri: toSourceFileResourceUri(input.scope, path),
        content,
      });
      continue;
    }
    const before = readFileSync(path, "utf8");
    const after = applyTextEdits(before, document.edits);
    const snapshot = recordSourceSnapshot({
      uri: toSourceFileResourceUri(input.scope, path),
      path,
      sourceText: before,
      runtime: input.runtime,
      sessionId: input.sessionId,
    });
    const first = snapshot.anchors[0];
    const last = snapshot.anchors.at(-1);
    if (!first || !last) {
      continue;
    }
    intents.push({
      kind: "replace_lines",
      uri: snapshot.uri,
      snapshotId: snapshot.id,
      startLine: first.line,
      endLine: last.line,
      replacement: after,
    });
  }
  return intents;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function withClient<T>(input: {
  readonly scope: ToolTargetScope;
  readonly resolution: LspServerResolution;
  readonly fn: (lease: LspWorkspaceClientLease) => Promise<T>;
}): Promise<
  | { readonly ok: true; readonly value: T; readonly stderr: string }
  | { readonly ok: false; readonly error: string; readonly stderr: string }
> {
  if (!input.resolution.command) {
    return { ok: false, error: "missing_lsp_command", stderr: "" };
  }
  let stderr = "";
  try {
    const value = await lspWorkspaceServerManager().withClient(
      {
        command: input.resolution.command,
        args: input.resolution.args,
        cwd: input.scope.baseCwd,
        rootUri: pathToFileURL(input.scope.baseCwd).toString(),
      },
      async (lease) => {
        try {
          return await input.fn(lease);
        } finally {
          stderr = lease.client.stderr;
        }
      },
    );
    return { ok: true, value, stderr };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
      stderr,
    };
  }
}

function openDocumentForUri(
  lease: LspWorkspaceClientLease,
  uri: string,
  scope: ToolTargetScope,
): string | undefined {
  const path = uriToPath(uri, scope);
  if (!path || !existsSync(path)) {
    return undefined;
  }
  const lspUri = pathToLspUri(path);
  lease.openDocument({
    uri: lspUri,
    languageId: languageIdForPath(path),
    text: readFileSync(path, "utf8"),
  });
  return lspUri;
}

function prepareWorkspaceEditResult(input: {
  readonly toolName: LspToolName;
  readonly edit: LspWorkspaceEdit;
  readonly scope: ToolTargetScope;
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly sessionId?: string;
  readonly summary: string;
}) {
  const intents = workspaceEditToIntents({
    edit: input.edit,
    scope: input.scope,
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  if (intents.length === 0) {
    return inconclusiveTextResult(`[${input.toolName}]\nstatus: no_edit`, {
      ok: false,
      status: "no_edit",
      edit: input.edit,
    });
  }
  const prepared = prepareAndStoreSourcePatchPlan({
    edits: intents,
    scope: input.scope,
    runtime: input.runtime,
    sessionId: input.sessionId,
    summary: input.summary,
  });
  const plan = prepared.plan;
  const body = [
    `[${input.toolName}]`,
    `status: ${plan.preflight.ok ? "prepared" : "conflict"}`,
    `plan_id: ${plan.id}`,
    `changes: ${plan.changes.length}`,
    "",
    plan.preview,
  ].join("\n");
  const details = {
    ok: plan.preflight.ok,
    status: plan.preflight.ok ? "prepared" : "conflict",
    planId: plan.id,
    plan,
  };
  return plan.preflight.ok ? okTextResult(body, details) : errTextResult(body, details);
}

function createReadRequestTool(input: {
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly name: LspToolName;
  readonly label: string;
  readonly description: string;
  readonly method: string;
  readonly parameters: ToolDefinition["parameters"];
  buildParams(params: Record<string, unknown>, lspUri: string): unknown;
}): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(input.runtime, input.name);
  return define({
    name: input.name,
    label: input.label,
    description: input.description,
    parameters: input.parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requestParams = asRecord(params);
      if (!requestParams || typeof requestParams.uri !== "string") {
        return errTextResult(`[${input.name}]\nstatus: failed\nreason: invalid_params`, {
          ok: false,
          reason: "invalid_params",
        });
      }
      const requestUri = requestParams.uri;
      const scope = resolveToolTargetScope(runtime, ctx);
      const resolution = resolveTypeScriptLanguageServer(scope.baseCwd);
      if (!resolution.available) {
        return unavailable(input.name, resolution);
      }
      const result = await withClient({
        scope,
        resolution,
        fn: async (lease) => {
          const lspUri = openDocumentForUri(lease, requestUri, scope);
          if (!lspUri) {
            throw new Error("document_not_found");
          }
          return await lease.client.request(input.method, input.buildParams(requestParams, lspUri));
        },
      });
      if (!result.ok) {
        return errTextResult(`[${input.name}]\nstatus: failed\nreason: ${result.error}`, {
          ok: false,
          status: "failed",
          reason: result.error,
          stderr: result.stderr,
        });
      }
      return okTextResult(
        [`[${input.name}]`, "status: ok", "result:", formatJson(result.value)].join("\n"),
        {
          ok: true,
          status: "ok",
          result: result.value,
          stderr: result.stderr,
        },
      );
    },
  });
}

export type LspWriteAfterSeverity = "error" | "warning" | "information" | "hint";

export interface LspWriteAfterDiagnostic {
  readonly path: string;
  readonly severity: LspWriteAfterSeverity;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number. */
  readonly column: number;
  readonly message: string;
  readonly code?: string;
  readonly source?: string;
}

export interface LspWriteAfterDiagnosticsResult {
  /** Whether a language server could be resolved for the workspace. */
  readonly available: boolean;
  readonly scannedPaths: readonly string[];
  readonly diagnostics: readonly LspWriteAfterDiagnostic[];
}

/** LSP language ids the write-after diagnostics pass understands (TS server only today). */
const LSP_WRITE_AFTER_LANGUAGES = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]);

/**
 * TypeScript project-level diagnostic codes that flood a file with no tsconfig
 * ancestor (module resolution, top-level await, missing `require`). They are
 * suppressed for orphan files so a freshly created file outside any project does
 * not drown the model in setup noise. Mirrors omp's orphan suppression set.
 */
const ORPHAN_TS_PROJECT_DIAGNOSTIC_CODES = new Set([1375, 1378, 2307, 2580, 2591, 2792, 2867]);

function writeAfterSeverityFromLsp(value: unknown): LspWriteAfterSeverity {
  switch (value) {
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      // LSP severity 1 is Error; an unspecified severity is treated as an error
      // (conservative — surface it rather than hide it).
      return "error";
  }
}

function hasTsconfigAncestor(absPath: string): boolean {
  let dir = dirname(resolve(absPath));
  while (true) {
    if (existsSync(resolve(dir, "tsconfig.json")) || existsSync(resolve(dir, "jsconfig.json"))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

function toWriteAfterDiagnostic(
  absPath: string,
  entry: unknown,
): LspWriteAfterDiagnostic | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const record = entry as {
    range?: { start?: { line?: unknown; character?: unknown } };
    severity?: unknown;
    message?: unknown;
    code?: unknown;
    source?: unknown;
  };
  if (typeof record.message !== "string") {
    return undefined;
  }
  const startLine = record.range?.start?.line;
  const startCharacter = record.range?.start?.character;
  // LSP diagnostic codes are number | string per the protocol.
  const code =
    typeof record.code === "number" || typeof record.code === "string"
      ? String(record.code)
      : undefined;
  const source = typeof record.source === "string" ? record.source : undefined;
  return {
    path: absPath,
    severity: writeAfterSeverityFromLsp(record.severity),
    line: typeof startLine === "number" ? startLine + 1 : 1,
    column: typeof startCharacter === "number" ? startCharacter + 1 : 1,
    message: record.message,
    ...(code !== undefined ? { code } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

/**
 * Project raw LSP diagnostic entries for one file into the write-after shape,
 * applying orphan-file suppression. Pure and fs-free: `isOrphan` (a file with no
 * tsconfig/jsconfig ancestor) is supplied by the caller, so this is unit-testable
 * without a real workspace or server. When orphan, TypeScript project-setup codes
 * are dropped so a freshly-created file outside any project does not flood setup
 * noise; otherwise every mappable entry (0-based LSP line/col → 1-based) survives.
 */
export function projectLspWriteAfterDiagnostics(
  absPath: string,
  rawEntries: readonly unknown[],
  isOrphan: boolean,
): LspWriteAfterDiagnostic[] {
  const collected: LspWriteAfterDiagnostic[] = [];
  for (const entry of rawEntries) {
    const diagnostic = toWriteAfterDiagnostic(absPath, entry);
    if (!diagnostic) {
      continue;
    }
    if (
      isOrphan &&
      diagnostic.code !== undefined &&
      ORPHAN_TS_PROJECT_DIAGNOSTIC_CODES.has(Number(diagnostic.code)) &&
      (diagnostic.source === undefined || diagnostic.source === "typescript")
    ) {
      continue;
    }
    collected.push(diagnostic);
  }
  return collected;
}

/**
 * Fetch language-server diagnostics for freshly written files. Intended to run
 * immediately after a successful `source_patch_apply` so type errors introduced
 * by an edit surface in the tool result instead of on the next explicit
 * `lsp_diagnostics` call. Pure I/O against the shared LSP server pool: it opens
 * each TS-family path, waits (bounded by `timeoutMs` across all paths) for
 * published diagnostics, and applies orphan-file project-error suppression. When
 * no server resolves it returns `available: false` so the caller can stay silent.
 */
export async function runLspWriteAfterDiagnostics(input: {
  readonly cwd: string;
  readonly absPaths: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<LspWriteAfterDiagnosticsResult> {
  const cwd = resolve(input.cwd);
  const uniquePaths = [
    ...new Set(
      input.absPaths
        .map((path) => resolve(path))
        .filter(
          (path) => LSP_WRITE_AFTER_LANGUAGES.has(languageIdForPath(path)) && existsSync(path),
        ),
    ),
  ];
  if (uniquePaths.length === 0) {
    return { available: true, scannedPaths: [], diagnostics: [] };
  }
  const resolution = resolveTypeScriptLanguageServer(cwd);
  if (!resolution.available) {
    return { available: false, scannedPaths: [], diagnostics: [] };
  }
  const readableRoots = [...new Set([cwd, ...uniquePaths.map((path) => dirname(path))])];
  const scope: ToolTargetScope = {
    baseCwd: cwd,
    primaryRoot: cwd,
    allowedRoots: readableRoots,
    readableRoots,
  };
  const deadline = Date.now() + (input.timeoutMs ?? 800);
  const outcome = await withClient({
    scope,
    resolution,
    fn: async (lease) => {
      const collected: LspWriteAfterDiagnostic[] = [];
      for (const absPath of uniquePaths) {
        if (input.signal?.aborted) {
          break;
        }
        const lspUri = openDocumentForUri(lease, absPath, scope);
        if (!lspUri) {
          continue;
        }
        const remaining = Math.max(0, deadline - Date.now());
        const raw = await lease.client.waitForDiagnostics(lspUri, remaining);
        collected.push(
          ...projectLspWriteAfterDiagnostics(absPath, raw, !hasTsconfigAncestor(absPath)),
        );
      }
      return collected;
    },
  });
  if (!outcome.ok) {
    return { available: true, scannedPaths: uniquePaths, diagnostics: [] };
  }
  return { available: true, scannedPaths: uniquePaths, diagnostics: outcome.value };
}

export function createLspTools(options?: { runtime?: BrewvaBundledToolRuntime }): ToolDefinition[] {
  const statusFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "lsp_status");
  const status = statusFactory.define({
    name: "lsp_status",
    label: "LSP Status",
    description:
      "Report the real language-server command Brewva will use for this workspace. No AST fallback is used.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(statusFactory.runtime, ctx);
      const resolution = resolveTypeScriptLanguageServer(scope.baseCwd);
      if (!resolution.available) {
        return unavailable("lsp_status", resolution);
      }
      return okTextResult(
        [
          "[lsp_status]",
          "status: available",
          `source: ${resolution.source ?? "unknown"}`,
          `command: ${resolution.command}`,
          `args: ${resolution.args.join(" ")}`,
        ].join("\n"),
        {
          ok: true,
          status: "available",
          source: resolution.source ?? null,
          command: resolution.command,
          args: resolution.args,
        },
      );
    },
  });

  const positionParams = (params: Record<string, unknown>, lspUri: string) => ({
    textDocument: { uri: lspUri },
    position: lspPosition(Number(params.line), Number(params.character)),
  });

  const referenceParams = (params: Record<string, unknown>, lspUri: string) => ({
    ...positionParams(params, lspUri),
    context: { includeDeclaration: params.include_declaration !== false },
  });

  const diagnosticsFactory = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "lsp_diagnostics",
  );
  const diagnostics = diagnosticsFactory.define({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Report diagnostics published by a real language server.",
    parameters: Type.Object({ uri: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(diagnosticsFactory.runtime, ctx);
      const resolution = resolveTypeScriptLanguageServer(scope.baseCwd);
      if (!resolution.available) {
        return unavailable("lsp_diagnostics", resolution);
      }
      const result = await withClient({
        scope,
        resolution,
        fn: async (lease) => {
          const lspUri = openDocumentForUri(lease, params.uri, scope);
          if (!lspUri) {
            throw new Error("document_not_found");
          }
          return await lease.client.waitForDiagnostics(lspUri);
        },
      });
      if (!result.ok) {
        return errTextResult(`[lsp_diagnostics]\nstatus: failed\nreason: ${result.error}`, {
          ok: false,
          status: "failed",
          reason: result.error,
          stderr: result.stderr,
        });
      }
      return okTextResult(
        ["[lsp_diagnostics]", "status: ok", "diagnostics:", formatJson(result.value)].join("\n"),
        { ok: true, status: "ok", diagnostics: result.value, stderr: result.stderr },
      );
    },
  });

  const renameFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "lsp_rename");
  const rename = renameFactory.define({
    name: "lsp_rename",
    label: "LSP Rename",
    description:
      "Request textDocument/rename from a real language server and prepare a SourcePatchPlan. It never mutates directly.",
    parameters: Type.Object({
      ...POSITION_SCHEMA,
      new_name: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(renameFactory.runtime, ctx);
      const resolution = resolveTypeScriptLanguageServer(scope.baseCwd);
      if (!resolution.available) {
        return unavailable("lsp_rename", resolution);
      }
      const sessionId = getToolSessionId(ctx);
      const result = await withClient({
        scope,
        resolution,
        fn: async (lease) => {
          const lspUri = openDocumentForUri(lease, params.uri, scope);
          if (!lspUri) {
            throw new Error("document_not_found");
          }
          return await lease.client.request("textDocument/rename", {
            textDocument: { uri: lspUri },
            position: lspPosition(params.line, params.character),
            newName: params.new_name,
          });
        },
      });
      if (!result.ok) {
        return errTextResult(`[lsp_rename]\nstatus: failed\nreason: ${result.error}`, {
          ok: false,
          status: "failed",
          reason: result.error,
          stderr: result.stderr,
        });
      }
      return prepareWorkspaceEditResult({
        toolName: "lsp_rename",
        edit: (asRecord(result.value) ?? {}) as LspWorkspaceEdit,
        scope,
        runtime: renameFactory.runtime,
        sessionId,
        summary: `LSP rename to ${params.new_name}`,
      });
    },
  });

  const fileRenameFactory = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "lsp_file_rename",
  );
  const fileRename = fileRenameFactory.define({
    name: "lsp_file_rename",
    label: "LSP File Rename",
    description:
      "Request workspace/willRenameFiles from a real language server and prepare a SourcePatchPlan.",
    parameters: Type.Object({
      old_uri: Type.String({ minLength: 1 }),
      new_uri: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(fileRenameFactory.runtime, ctx);
      const resolution = resolveTypeScriptLanguageServer(scope.baseCwd);
      if (!resolution.available) {
        return unavailable("lsp_file_rename", resolution);
      }
      const oldPath = uriToPath(params.old_uri, scope);
      const newPath = uriToPath(params.new_uri, scope);
      if (!oldPath || !newPath) {
        return errTextResult("[lsp_file_rename]\nstatus: failed\nreason: path_outside_target", {
          ok: false,
          reason: "path_outside_target",
        });
      }
      const sessionId = getToolSessionId(ctx);
      const oldUri = pathToLspUri(oldPath);
      const newUri = pathToLspUri(newPath);
      const result = await withClient({
        scope,
        resolution,
        fn: async (lease) =>
          await lease.client.request("workspace/willRenameFiles", {
            files: [{ oldUri, newUri }],
          }),
      });
      if (!result.ok) {
        return errTextResult(`[lsp_file_rename]\nstatus: failed\nreason: ${result.error}`, {
          ok: false,
          status: "failed",
          reason: result.error,
          stderr: result.stderr,
        });
      }
      const edit = (asRecord(result.value) ?? {}) as LspWorkspaceEdit;
      const withRename: LspWorkspaceEdit = {
        ...edit,
        documentChanges: [...(edit.documentChanges ?? []), { kind: "rename", oldUri, newUri }],
      };
      return prepareWorkspaceEditResult({
        toolName: "lsp_file_rename",
        edit: withRename,
        scope,
        runtime: fileRenameFactory.runtime,
        sessionId,
        summary: "LSP file rename",
      });
    },
  });

  const codeActionFactory = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "lsp_code_action",
  );
  const codeAction = codeActionFactory.define({
    name: "lsp_code_action",
    label: "LSP Code Action",
    description:
      "Request textDocument/codeAction from a real language server and prepare the selected edit as a SourcePatchPlan.",
    parameters: Type.Object({
      uri: Type.String({ minLength: 1 }),
      start_line: Type.Integer({ minimum: 0 }),
      start_character: Type.Integer({ minimum: 0 }),
      end_line: Type.Integer({ minimum: 0 }),
      end_character: Type.Integer({ minimum: 0 }),
      action_index: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(codeActionFactory.runtime, ctx);
      const resolution = resolveTypeScriptLanguageServer(scope.baseCwd);
      if (!resolution.available) {
        return unavailable("lsp_code_action", resolution);
      }
      const sessionId = getToolSessionId(ctx);
      const result = await withClient({
        scope,
        resolution,
        fn: async (lease) => {
          const lspUri = openDocumentForUri(lease, params.uri, scope);
          if (!lspUri) {
            throw new Error("document_not_found");
          }
          return await lease.client.request("textDocument/codeAction", {
            textDocument: { uri: lspUri },
            range: lspRange({
              startLine: params.start_line,
              startCharacter: params.start_character,
              endLine: params.end_line,
              endCharacter: params.end_character,
            }),
            context: { diagnostics: [] },
          });
        },
      });
      if (!result.ok) {
        return errTextResult(`[lsp_code_action]\nstatus: failed\nreason: ${result.error}`, {
          ok: false,
          status: "failed",
          reason: result.error,
          stderr: result.stderr,
        });
      }
      const actions = Array.isArray(result.value) ? result.value : [];
      const action = asRecord(actions[params.action_index ?? 0]);
      const edit = asRecord(action?.edit) as LspWorkspaceEdit | undefined;
      if (!edit) {
        return inconclusiveTextResult(
          ["[lsp_code_action]", "status: no_edit", "actions:", formatJson(actions)].join("\n"),
          { ok: false, status: "no_edit", actions, stderr: result.stderr },
        );
      }
      return prepareWorkspaceEditResult({
        toolName: "lsp_code_action",
        edit,
        scope,
        runtime: codeActionFactory.runtime,
        sessionId,
        summary: "LSP code action",
      });
    },
  });

  const formatFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "lsp_format");
  const format = formatFactory.define({
    name: "lsp_format",
    label: "LSP Format",
    description:
      "Request textDocument/formatting from a real language server and prepare edits as a SourcePatchPlan.",
    parameters: Type.Object({
      uri: Type.String({ minLength: 1 }),
      tab_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 2 })),
      insert_spaces: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(formatFactory.runtime, ctx);
      const resolution = resolveTypeScriptLanguageServer(scope.baseCwd);
      if (!resolution.available) {
        return unavailable("lsp_format", resolution);
      }
      const sessionId = getToolSessionId(ctx);
      const result = await withClient({
        scope,
        resolution,
        fn: async (lease) => {
          const lspUri = openDocumentForUri(lease, params.uri, scope);
          if (!lspUri) {
            throw new Error("document_not_found");
          }
          return await lease.client.request("textDocument/formatting", {
            textDocument: { uri: lspUri },
            options: {
              tabSize: params.tab_size ?? 2,
              insertSpaces: params.insert_spaces !== false,
            },
          });
        },
      });
      if (!result.ok) {
        return errTextResult(`[lsp_format]\nstatus: failed\nreason: ${result.error}`, {
          ok: false,
          status: "failed",
          reason: result.error,
          stderr: result.stderr,
        });
      }
      const path = uriToPath(params.uri, scope);
      if (!path) {
        return errTextResult("[lsp_format]\nstatus: failed\nreason: path_outside_target", {
          ok: false,
          reason: "path_outside_target",
        });
      }
      return prepareWorkspaceEditResult({
        toolName: "lsp_format",
        edit: {
          changes: {
            [pathToLspUri(path)]: Array.isArray(result.value)
              ? result.value.filter(isTextEdit)
              : [],
          },
        },
        scope,
        runtime: formatFactory.runtime,
        sessionId,
        summary: "LSP format",
      });
    },
  });

  return [
    status,
    createReadRequestTool({
      runtime: options?.runtime,
      name: "lsp_hover",
      label: "LSP Hover",
      description: "Request textDocument/hover from a real language server.",
      method: "textDocument/hover",
      parameters: Type.Object(POSITION_SCHEMA),
      buildParams: positionParams,
    }),
    createReadRequestTool({
      runtime: options?.runtime,
      name: "lsp_definition",
      label: "LSP Definition",
      description: "Request textDocument/definition from a real language server.",
      method: "textDocument/definition",
      parameters: Type.Object(POSITION_SCHEMA),
      buildParams: positionParams,
    }),
    createReadRequestTool({
      runtime: options?.runtime,
      name: "lsp_references",
      label: "LSP References",
      description: "Request textDocument/references from a real language server.",
      method: "textDocument/references",
      parameters: Type.Object({
        ...POSITION_SCHEMA,
        include_declaration: Type.Optional(Type.Boolean({ default: true })),
      }),
      buildParams: referenceParams,
    }),
    createReadRequestTool({
      runtime: options?.runtime,
      name: "lsp_type_definition",
      label: "LSP Type Definition",
      description: "Request textDocument/typeDefinition from a real language server.",
      method: "textDocument/typeDefinition",
      parameters: Type.Object(POSITION_SCHEMA),
      buildParams: positionParams,
    }),
    createReadRequestTool({
      runtime: options?.runtime,
      name: "lsp_implementation",
      label: "LSP Implementation",
      description: "Request textDocument/implementation from a real language server.",
      method: "textDocument/implementation",
      parameters: Type.Object(POSITION_SCHEMA),
      buildParams: positionParams,
    }),
    diagnostics,
    rename,
    fileRename,
    codeAction,
    format,
  ];
}
