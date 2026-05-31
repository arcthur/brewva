import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex, shortSha256Hex } from "@brewva/brewva-std/hash";
import {
  createBrewvaResourceRouter,
  createHostedResourceLoader,
  type BrewvaResourceProvider,
  type BrewvaResourceReadResult,
  type BrewvaResourceRouter,
} from "@brewva/brewva-substrate/resources";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  type PatchFileChange,
  type PatchSet,
  resolveSessionPatchHistoryDirectory,
  SOURCE_PATCH_PREPARED_EVENT_TYPE,
  SOURCE_PATCH_STALE_RECOVERED_EVENT_TYPE,
  SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE,
  type SourceLineAnchor,
  type SourcePatchApplyResult,
  type SourcePatchConflict,
  type SourcePatchIntent,
  type SourcePatchPlan,
  type SourcePatchPreflight,
  type SourcePatchStaleRecoveryRecord,
  type SourceSnapshot,
} from "@brewva/brewva-vocabulary/workbench";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolRuntime } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { recordToolRuntimeEvent } from "../../runtime-port/extensions.js";
import { getToolSessionId } from "../../runtime-port/parallel-read.js";
import {
  resolveScopedPath,
  resolveToolTargetScope,
  type ToolTargetScope,
} from "../../runtime-port/target-scope.js";
import { errTextResult, inconclusiveTextResult, okTextResult } from "../../utils/result.js";
import { readSourceTextCached } from "./source-intelligence/cache.js";
import { createSourceIntelligenceEngine } from "./source-intelligence/engine.js";

const SOURCE_READ_MODE_VALUES = ["spans", "summary", "raw"] as const;
type SourceReadMode = (typeof SOURCE_READ_MODE_VALUES)[number];
const SOURCE_READ_MODE_SCHEMA = buildStringEnumSchema(SOURCE_READ_MODE_VALUES, {
  defaultValue: "spans",
  recommendedValue: "spans",
});
const MAX_SOURCE_READ_SPANS = 16;
const MAX_SOURCE_READ_LINES = 400;
const GENERATED_SCAN_BYTES = 4096;
const ROLLBACK_MANIFEST_FILE = "rollback.json";

interface NormalizedSpan {
  readonly startLine: number;
  readonly endLine: number;
}

interface PreparedFileMutation {
  readonly uri: string;
  readonly path: string;
  readonly operation: "write" | "delete" | "rename";
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly change: PatchFileChange;
}

interface StoredSourcePatchPlan {
  readonly plan: SourcePatchPlan;
  readonly mutations: readonly PreparedFileMutation[];
}

interface PendingFileMutation {
  readonly uri: string;
  readonly path: string;
  readonly operation: "write" | "delete" | "rename";
  readonly before: string | undefined;
  after: string | undefined;
  readonly oldPath?: string;
  readonly newPath?: string;
}

export interface StoredSourcePatchPlanReceipt {
  readonly plan: SourcePatchPlan;
}

export interface SourcePatchApplyReceipt {
  readonly ok: boolean;
  readonly result: SourcePatchApplyResult;
  readonly plan?: SourcePatchPlan;
  readonly patchSet?: PatchSet;
}

export interface SourceReadToolDetails {
  readonly status: "ok";
  readonly resourceUri: string;
  readonly filePath: string;
  readonly snapshot: SourceSnapshot;
  readonly mode: (typeof SOURCE_READ_MODE_VALUES)[number];
  readonly sourceCacheHit?: boolean;
}

const SNAPSHOTS = new Map<string, SourceSnapshot>();
const PLANS = new Map<string, StoredSourcePatchPlan>();
const RESOURCE_ROUTERS = new Map<string, Promise<BrewvaResourceRouter>>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sha256(input: string): string {
  return `sha256:${sha256Hex(input)}`;
}

function shortToken(input: string): string {
  return shortSha256Hex(input, 6);
}

function createId(prefix: string, contentHash: string): string {
  return `${prefix}_${contentHash.slice(7, 19)}_${randomUUID().slice(0, 8)}`;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines.length > 0 ? lines : [""];
}

function joinLines(lines: readonly string[], originalText: string): string {
  const joined = lines.join("\n");
  const withBom =
    originalText.startsWith("\uFEFF") && !joined.startsWith("\uFEFF") ? `\uFEFF${joined}` : joined;
  return originalText.endsWith("\n") && !withBom.endsWith("\n") ? `${withBom}\n` : withBom;
}

function buildAnchors(lines: readonly string[]): SourceLineAnchor[] {
  return lines.map((text, index) => {
    const line = index + 1;
    const hash = sha256(text);
    return {
      line,
      token: shortToken(`${line}:${hash}`),
      hash,
      text,
    };
  });
}

function formatAnchor(anchor: SourceLineAnchor): string {
  return `L${anchor.line}@${anchor.token}`;
}

function parseAnchor(value: string): { readonly line: number; readonly token: string } | null {
  const match = /^L(\d+)@([A-Za-z0-9_-]{2,})$/u.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    line: Number(match[1]),
    token: match[2] ?? "",
  };
}

function buildSnapshot(input: {
  readonly uri: string;
  readonly path: string;
  readonly sourceText: string;
}): SourceSnapshot {
  const lines = splitLines(input.sourceText);
  const contentHash = sha256(input.sourceText);
  return {
    id: createId("snap", contentHash),
    uri: input.uri,
    path: input.path,
    contentHash,
    createdAt: Date.now(),
    lineCount: lines.length,
    anchors: buildAnchors(lines),
  };
}

export function recordSourceSnapshot(input: {
  readonly uri: string;
  readonly path: string;
  readonly sourceText: string;
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly sessionId?: string;
}): SourceSnapshot {
  const snapshot = buildSnapshot(input);
  SNAPSHOTS.set(snapshot.id, snapshot);
  recordSnapshot({ runtime: input.runtime, sessionId: input.sessionId, snapshot });
  return snapshot;
}

export function formatSourceAnchor(anchor: SourceLineAnchor): string {
  return formatAnchor(anchor);
}

export function toSourceFileResourceUri(scope: ToolTargetScope, absolutePath: string): string {
  return resourceUriForPath(scope, absolutePath);
}

function normalizeSpans(
  spans: Array<{ start_line: number; end_line: number }> | undefined,
): NormalizedSpan[] {
  const raw =
    spans && spans.length > 0 ? spans : [{ start_line: 1, end_line: MAX_SOURCE_READ_LINES }];
  const normalized = raw
    .map((span) => ({
      startLine: Math.max(1, Math.floor(span.start_line)),
      endLine: Math.max(1, Math.floor(span.end_line)),
    }))
    .map((span) =>
      span.endLine < span.startLine ? { startLine: span.endLine, endLine: span.startLine } : span,
    )
    .toSorted((left, right) => {
      if (left.startLine !== right.startLine) {
        return left.startLine - right.startLine;
      }
      return left.endLine - right.endLine;
    });
  const merged: NormalizedSpan[] = [];
  for (const span of normalized.slice(0, MAX_SOURCE_READ_SPANS)) {
    const last = merged.at(-1);
    if (last && span.startLine <= last.endLine + 1) {
      merged[merged.length - 1] = {
        startLine: last.startLine,
        endLine: Math.max(last.endLine, span.endLine),
      };
      continue;
    }
    merged.push(span);
  }
  return merged;
}

function formatSpan(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
}

function normalizeSourceReadMode(value: unknown): SourceReadMode {
  return value === "summary" || value === "raw" || value === "spans" ? value : "spans";
}

function resourceUriForPath(scope: ToolTargetScope, absolutePath: string): string {
  const relativePath = relative(scope.baseCwd, absolutePath).replaceAll("\\", "/");
  const path =
    relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : absolutePath;
  return `brewva-resource:///file/${path.replace(/^\/+/u, "")}`;
}

function pathFromResourceUri(uri: string, scope: ToolTargetScope): string | null {
  if (uri.startsWith("file://")) {
    return resolveScopedPath(fileURLToPath(uri), scope);
  }
  if (uri.startsWith("brewva-resource:///file/")) {
    const resourcePath = decodeURIComponent(uri.slice("brewva-resource:///file/".length));
    const candidate = isAbsolute(resourcePath) ? resourcePath : resourcePath;
    return resolveScopedPath(candidate, scope);
  }
  return resolveScopedPath(uri, scope);
}

function readExistingFile(path: string): string {
  return readFileSync(path, "utf8");
}

function isGeneratedPath(path: string): boolean {
  return /(?:^|[./_-])(?:generated|gen|pb)(?:[._-]|$)/iu.test(path) || /\.pb\.[^.]+$/iu.test(path);
}

function isGeneratedContent(content: string): boolean {
  const head = content.slice(0, GENERATED_SCAN_BYTES);
  return /@generated|DO NOT EDIT|Code generated|protoc|sqlc|openapi-generator/iu.test(head);
}

function isGeneratedFile(path: string): boolean {
  if (isGeneratedPath(path)) {
    return true;
  }
  if (!existsSync(path)) {
    return false;
  }
  return isGeneratedContent(readFileSync(path, "utf8"));
}

function rejectGeneratedTarget(path: string): SourcePatchConflict | null {
  return isGeneratedFile(path)
    ? {
        uri: path,
        reason: "generated_file_rejected",
        message: "Generated files cannot be mutated by source_patch_prepare.",
      }
    : null;
}

function resolveAnchorInSnapshot(
  snapshot: SourceSnapshot,
  anchorRef: string,
): SourceLineAnchor | null {
  const parsed = parseAnchor(anchorRef);
  if (!parsed) {
    return null;
  }
  return (
    snapshot.anchors.find(
      (anchor) => anchor.line === parsed.line && anchor.token === parsed.token,
    ) ?? null
  );
}

function findRecoveredAnchor(input: {
  readonly snapshot: SourceSnapshot;
  readonly expected: SourceLineAnchor;
  readonly currentLines: readonly string[];
}): SourceLineAnchor | null {
  const matches = buildAnchors(input.currentLines).filter(
    (anchor) => anchor.hash === input.expected.hash,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function resolveCurrentAnchor(input: {
  readonly snapshot: SourceSnapshot;
  readonly anchorRef: string;
  readonly currentLines: readonly string[];
  readonly sessionId: string | undefined;
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly planId: string;
}): { readonly anchor: SourceLineAnchor | null; readonly staleRecovered: boolean } {
  const expected = resolveAnchorInSnapshot(input.snapshot, input.anchorRef);
  if (!expected) {
    return { anchor: null, staleRecovered: false };
  }
  const currentText = input.currentLines[expected.line - 1];
  if (typeof currentText === "string" && sha256(currentText) === expected.hash) {
    return { anchor: expected, staleRecovered: false };
  }
  const recovered = findRecoveredAnchor({
    snapshot: input.snapshot,
    expected,
    currentLines: input.currentLines,
  });
  if (input.sessionId) {
    const record: SourcePatchStaleRecoveryRecord = {
      planId: input.planId,
      snapshotId: input.snapshot.id,
      uri: input.snapshot.uri,
      recovered: Boolean(recovered),
      reason: recovered ? undefined : "anchor_not_found",
    };
    input.runtime?.capabilities.tools.sourcePatch.staleRecovery.record(input.sessionId, record);
    recordToolRuntimeEvent(input.runtime, {
      sessionId: input.sessionId,
      type: SOURCE_PATCH_STALE_RECOVERED_EVENT_TYPE,
      payload: record,
    });
  }
  return { anchor: recovered, staleRecovered: Boolean(recovered) };
}

function normalizeReplacementLines(value: string): string[] {
  return value.endsWith("\n") ? value.slice(0, -1).split(/\r?\n/u) : value.split(/\r?\n/u);
}

function applyLineIntent(input: {
  readonly intent: SourcePatchIntent;
  readonly snapshot: SourceSnapshot;
  readonly currentText: string;
  readonly sessionId: string | undefined;
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly planId: string;
}): {
  readonly after: string;
  readonly staleRecovered: boolean;
  readonly conflict?: SourcePatchConflict;
} {
  const lines = splitLines(input.currentText);
  if (
    input.intent.kind !== "replace_anchor" &&
    input.intent.kind !== "insert_before_anchor" &&
    input.intent.kind !== "insert_after_anchor" &&
    input.intent.kind !== "delete_anchor_range"
  ) {
    return {
      after: input.currentText,
      staleRecovered: false,
      conflict: {
        uri: input.snapshot.uri,
        reason: "unsupported_line_intent",
      },
    };
  }
  const firstRef = "anchor" in input.intent ? input.intent.anchor : input.intent.startAnchor;
  const first = resolveCurrentAnchor({
    snapshot: input.snapshot,
    anchorRef: firstRef,
    currentLines: lines,
    sessionId: input.sessionId,
    runtime: input.runtime,
    planId: input.planId,
  });
  if (!first.anchor) {
    return {
      after: input.currentText,
      staleRecovered: first.staleRecovered,
      conflict: {
        uri: input.snapshot.uri,
        reason: "anchor_not_found",
        message: `Unable to resolve anchor ${firstRef}.`,
      },
    };
  }

  if (input.intent.kind === "insert_before_anchor") {
    const nextLines = [...lines];
    nextLines.splice(
      first.anchor.line - 1,
      0,
      ...normalizeReplacementLines(input.intent.insertion),
    );
    return { after: joinLines(nextLines, input.currentText), staleRecovered: first.staleRecovered };
  }
  if (input.intent.kind === "insert_after_anchor") {
    const nextLines = [...lines];
    nextLines.splice(first.anchor.line, 0, ...normalizeReplacementLines(input.intent.insertion));
    return { after: joinLines(nextLines, input.currentText), staleRecovered: first.staleRecovered };
  }

  if (!("startAnchor" in input.intent)) {
    return {
      after: input.currentText,
      staleRecovered: false,
      conflict: {
        uri: input.snapshot.uri,
        reason: "unsupported_line_intent",
      },
    };
  }
  const endRef = input.intent.endAnchor ?? input.intent.startAnchor;
  const last = resolveCurrentAnchor({
    snapshot: input.snapshot,
    anchorRef: endRef,
    currentLines: lines,
    sessionId: input.sessionId,
    runtime: input.runtime,
    planId: input.planId,
  });
  if (!last.anchor) {
    return {
      after: input.currentText,
      staleRecovered: first.staleRecovered || last.staleRecovered,
      conflict: {
        uri: input.snapshot.uri,
        reason: "anchor_not_found",
        message: `Unable to resolve anchor ${endRef}.`,
      },
    };
  }
  const startLine = Math.min(first.anchor.line, last.anchor.line);
  const endLine = Math.max(first.anchor.line, last.anchor.line);
  const nextLines = [...lines];
  const replacement =
    input.intent.kind === "replace_anchor"
      ? normalizeReplacementLines(input.intent.replacement)
      : [];
  nextLines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
  return {
    after: joinLines(nextLines, input.currentText),
    staleRecovered: first.staleRecovered || last.staleRecovered,
  };
}

function buildPreview(mutations: readonly PreparedFileMutation[]): string {
  const output: string[] = [];
  for (const mutation of mutations) {
    output.push(`--- ${mutation.path}`, `+++ ${mutation.path}`);
    if (mutation.before !== undefined) {
      for (const line of splitLines(mutation.before)) {
        output.push(`-${line}`);
      }
    }
    if (mutation.after !== undefined) {
      for (const line of splitLines(mutation.after)) {
        output.push(`+${line}`);
      }
    }
  }
  return output.join("\n");
}

function reserveOutputPath(input: {
  readonly outputPath: string;
  readonly uri: string;
  readonly owners: Map<string, string>;
  readonly conflicts: SourcePatchConflict[];
}): boolean {
  const existingUri = input.owners.get(input.outputPath);
  if (!existingUri) {
    input.owners.set(input.outputPath, input.uri);
    return true;
  }
  input.conflicts.push({
    uri: input.uri,
    reason: "path_conflict",
    message: `Multiple source patch mutations produce ${input.outputPath}.`,
  });
  return false;
}

function mutationOutputPaths(mutation: PreparedFileMutation): string[] {
  if (mutation.operation === "rename") {
    return mutation.change.newPath ? [mutation.change.newPath] : [];
  }
  return mutation.after !== undefined ? [mutation.path] : [];
}

function detectMutationPathConflicts(
  mutations: readonly PreparedFileMutation[],
): SourcePatchConflict[] {
  const outputOwners = new Map<string, PreparedFileMutation>();
  const conflicts: SourcePatchConflict[] = [];
  const emitted = new Set<string>();
  for (const mutation of mutations) {
    for (const outputPath of mutationOutputPaths(mutation)) {
      const existing = outputOwners.get(outputPath);
      if (!existing) {
        outputOwners.set(outputPath, mutation);
        continue;
      }
      const key = `${outputPath}:${existing.uri}:${mutation.uri}`;
      if (emitted.has(key)) {
        continue;
      }
      emitted.add(key);
      conflicts.push({
        uri: mutation.uri,
        reason: "path_conflict",
        message: `Multiple source patch mutations produce ${outputPath}.`,
      });
    }
  }
  return conflicts;
}

function workspaceRelativePath(scope: ToolTargetScope, path: string): string {
  const relativePath = relative(scope.baseCwd, path).replaceAll("\\", "/");
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : path;
}

function safeRollbackFileName(index: number, path: string): string {
  const sanitized = path.replace(/[^a-zA-Z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return `${String(index).padStart(4, "0")}_${sanitized || "root"}.txt`;
}

function writeRollbackArtifact(input: {
  readonly patchSetId: string;
  readonly mutations: readonly PreparedFileMutation[];
  readonly scope?: ToolTargetScope;
  readonly sessionId?: string;
}): string | undefined {
  if (!input.scope || !input.sessionId) {
    return undefined;
  }
  const scope = input.scope;
  const sessionId = input.sessionId;
  const patchDir = join(
    resolveSessionPatchHistoryDirectory({
      workspaceRoot: scope.baseCwd,
      sessionId,
    }),
    input.patchSetId,
  );
  const beforeDir = join(patchDir, "before");
  mkdirSync(beforeDir, { recursive: true });
  const entries = input.mutations.map((mutation, index) => {
    const path = workspaceRelativePath(scope, mutation.path);
    const beforeArtifactRef =
      mutation.before === undefined
        ? undefined
        : workspaceRelativePath(scope, join(beforeDir, safeRollbackFileName(index, path)));
    if (beforeArtifactRef && mutation.before !== undefined) {
      writeFileSync(join(scope.baseCwd, beforeArtifactRef), mutation.before, "utf8");
    }
    return {
      path,
      operation: mutation.operation,
      oldPath:
        mutation.change.oldPath === undefined
          ? undefined
          : workspaceRelativePath(scope, mutation.change.oldPath),
      newPath:
        mutation.change.newPath === undefined
          ? undefined
          : workspaceRelativePath(scope, mutation.change.newPath),
      beforeHash: mutation.change.beforeHash,
      afterHash: mutation.change.afterHash,
      beforeArtifactRef,
    };
  });
  const manifestPath = join(patchDir, ROLLBACK_MANIFEST_FILE);
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: 1,
        patchSetId: input.patchSetId,
        createdAt: Date.now(),
        entries,
      },
      null,
      2,
    ),
    "utf8",
  );
  return workspaceRelativePath(scope, manifestPath);
}

function sourcePatchConflictResult(planId: string, conflicts: readonly SourcePatchConflict[]) {
  return errTextResult(
    [
      "[SourcePatchPlan]",
      `status: conflict`,
      `plan_id: ${planId}`,
      ...conflicts.map((conflict) => `${conflict.reason}: ${conflict.message ?? conflict.uri}`),
    ].join("\n"),
    {
      ok: false,
      status: "conflict",
      planId,
      conflicts,
    },
  );
}

function recordSnapshot(input: {
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly sessionId: string | undefined;
  readonly snapshot: SourceSnapshot;
}): void {
  if (!input.sessionId) {
    return;
  }
  input.runtime?.capabilities.tools.sourcePatch.snapshots.record(input.sessionId, input.snapshot);
  recordToolRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE,
    payload: input.snapshot,
  });
}

function recordPlan(input: {
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly sessionId: string | undefined;
  readonly plan: SourcePatchPlan;
}): void {
  if (!input.sessionId) {
    return;
  }
  input.runtime?.capabilities.tools.sourcePatch.plans.prepare(input.sessionId, input.plan);
  recordToolRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: SOURCE_PATCH_PREPARED_EVENT_TYPE,
    payload: input.plan,
  });
}

function isSourceLineAnchor(value: unknown): value is SourceLineAnchor {
  const record = asRecord(value);
  return (
    typeof record?.line === "number" &&
    typeof record.token === "string" &&
    typeof record.hash === "string" &&
    typeof record.text === "string"
  );
}

function isSourceSnapshot(value: unknown): value is SourceSnapshot {
  const record = asRecord(value);
  return (
    typeof record?.id === "string" &&
    typeof record.uri === "string" &&
    (record.path === undefined || typeof record.path === "string") &&
    typeof record.contentHash === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.lineCount === "number" &&
    Array.isArray(record.anchors) &&
    record.anchors.every(isSourceLineAnchor)
  );
}

function isSourcePatchIntent(value: unknown): value is SourcePatchIntent {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string" || typeof record.uri !== "string") {
    return false;
  }
  if (record.kind === "replace_anchor") {
    return (
      typeof record.snapshotId === "string" &&
      typeof record.startAnchor === "string" &&
      (record.endAnchor === undefined || typeof record.endAnchor === "string") &&
      typeof record.replacement === "string"
    );
  }
  if (record.kind === "insert_before_anchor" || record.kind === "insert_after_anchor") {
    return (
      typeof record.snapshotId === "string" &&
      typeof record.anchor === "string" &&
      typeof record.insertion === "string"
    );
  }
  if (record.kind === "delete_anchor_range") {
    return (
      typeof record.snapshotId === "string" &&
      typeof record.startAnchor === "string" &&
      (record.endAnchor === undefined || typeof record.endAnchor === "string")
    );
  }
  if (record.kind === "create_file") {
    return typeof record.content === "string";
  }
  if (record.kind === "delete_file") {
    return true;
  }
  if (record.kind === "rename_file") {
    return typeof record.newUri === "string";
  }
  return false;
}

function isSourcePatchPlan(value: unknown): value is SourcePatchPlan {
  const record = asRecord(value);
  const preflight = asRecord(record?.preflight);
  return (
    typeof record?.id === "string" &&
    (record.status === "prepared" ||
      record.status === "conflict" ||
      record.status === "applied" ||
      record.status === "failed") &&
    typeof record.createdAt === "number" &&
    Array.isArray(record.snapshots) &&
    record.snapshots.every((snapshotId) => typeof snapshotId === "string") &&
    Array.isArray(record.intents) &&
    record.intents.every(isSourcePatchIntent) &&
    Array.isArray(record.changes) &&
    Array.isArray(record.conflicts) &&
    typeof preflight?.ok === "boolean" &&
    typeof preflight.staleRecovered === "boolean" &&
    typeof preflight.generatedFileRejected === "boolean" &&
    typeof record.preview === "string"
  );
}

function eventPayload(event: unknown): unknown {
  return asRecord(event)?.payload;
}

function querySourcePatchEvents(input: {
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly sessionId: string | undefined;
  readonly type: string;
}): readonly unknown[] {
  if (!input.runtime || !input.sessionId) {
    return [];
  }
  try {
    return input.runtime.capabilities.events.records.query(input.sessionId, {
      type: input.type,
    });
  } catch {
    return [];
  }
}

function hydrateSnapshotsFromRuntimeEvents(input: {
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly sessionId: string | undefined;
  readonly snapshotIds: readonly string[];
}): void {
  const missing = new Set(input.snapshotIds.filter((snapshotId) => !SNAPSHOTS.has(snapshotId)));
  if (missing.size === 0) {
    return;
  }
  const events = querySourcePatchEvents({
    runtime: input.runtime,
    sessionId: input.sessionId,
    type: SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE,
  });
  for (const event of events.toReversed()) {
    const payload = eventPayload(event);
    if (!isSourceSnapshot(payload) || !missing.has(payload.id)) {
      continue;
    }
    SNAPSHOTS.set(payload.id, payload);
    missing.delete(payload.id);
    if (missing.size === 0) {
      return;
    }
  }
}

function findPlanInRuntimeEvents(input: {
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly sessionId: string | undefined;
  readonly planId: string;
}): SourcePatchPlan | undefined {
  const events = querySourcePatchEvents({
    runtime: input.runtime,
    sessionId: input.sessionId,
    type: SOURCE_PATCH_PREPARED_EVENT_TYPE,
  });
  for (const event of events.toReversed()) {
    const payload = eventPayload(event);
    if (isSourcePatchPlan(payload) && payload.id === input.planId) {
      return payload;
    }
  }
  return undefined;
}

function formatSourceRead(input: {
  readonly filePath: string;
  readonly uri: string;
  readonly snapshot: SourceSnapshot;
  readonly spans: readonly NormalizedSpan[];
  readonly mode: string;
  readonly summary?: readonly string[];
}): string {
  const output = [
    "[SourceRead]",
    `file: ${input.filePath}`,
    `resource_uri: ${input.uri}`,
    `snapshot_id: ${input.snapshot.id}`,
    `mode: ${input.mode}`,
    `total_lines: ${input.snapshot.lineCount}`,
  ];
  if (input.summary) {
    output.push("", "[Summary]", ...input.summary);
  }
  let emitted = 0;
  for (const span of input.spans) {
    if (emitted >= MAX_SOURCE_READ_LINES) {
      break;
    }
    const startLine = Math.max(1, span.startLine);
    const endLine = Math.min(span.endLine, input.snapshot.anchors.length);
    if (startLine > endLine) {
      continue;
    }
    output.push("", `[Span ${formatSpan(startLine, endLine)}]`);
    for (let line = startLine; line <= endLine && emitted < MAX_SOURCE_READ_LINES; line += 1) {
      const anchor = input.snapshot.anchors[line - 1];
      if (!anchor) {
        continue;
      }
      output.push(`${formatAnchor(anchor)}|${anchor.text}`);
      emitted += 1;
    }
  }
  return output.join("\n");
}

async function buildSummary(filePath: string, workspaceRoot: string): Promise<string[]> {
  try {
    const engine = createSourceIntelligenceEngine({ workspaceRoot });
    const document = await engine.loadDocument(filePath);
    return [
      `language: ${document.language}`,
      `imports: ${document.imports.length}`,
      ...document.imports.slice(0, 12).map((entry) => `import ${entry.rawSpecifier}`),
      `declarations: ${document.declarations.length}`,
      ...document.declarations
        .slice(0, 24)
        .map(
          (entry) =>
            `${entry.kind} ${entry.name} ${formatSpan(entry.span.startLine, entry.span.endLine)}`,
        ),
      `diagnostics: ${document.diagnostics.length}`,
      ...document.diagnostics.slice(0, 12).map((entry) => `${entry.severity}: ${entry.message}`),
    ];
  } catch (error) {
    return [`summary_unavailable: ${error instanceof Error ? error.message : String(error)}`];
  }
}

export function createSourceReadTool(options?: {
  runtime?: BrewvaBundledToolRuntime;
}): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options?.runtime, "source_read");
  return define({
    name: "source_read",
    label: "Source Read",
    description:
      "Read source resources with snapshot ids and hash-anchored editable lines. Use this before source_patch_prepare. Anchors look like L42@a1b2c3; copy them verbatim from source_read output.",
    parameters: Type.Object({
      uri: Type.String({ minLength: 1 }),
      mode: Type.Optional(SOURCE_READ_MODE_SCHEMA),
      spans: Type.Optional(
        Type.Array(
          Type.Object({
            start_line: Type.Integer({ minimum: 1 }),
            end_line: Type.Integer({ minimum: 1 }),
          }),
          { maxItems: MAX_SOURCE_READ_SPANS },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(runtime, ctx);
      const router = await resourceRouterForRoot({
        cwd: scope.baseCwd,
        roots: scope.allowedRoots,
      });
      const resource = await router.read(params.uri);
      const absolutePath = resource.path ?? pathFromResourceUri(params.uri, scope);
      if (!absolutePath) {
        return errTextResult(
          `source_read rejected: uri escapes target roots (${scope.allowedRoots.join(", ")}).`,
          { ok: false, reason: "path_outside_target" },
        );
      }
      if (
        resource.status !== "ok" &&
        resource.reason !== "not_found" &&
        resource.reason !== "not_file"
      ) {
        return errTextResult(`source_read unavailable: ${resource.reason ?? "not_found"}`, {
          ok: false,
          reason: resource.reason ?? "not_found",
        });
      }
      if (!existsSync(absolutePath)) {
        return errTextResult(`Error: File not found: ${absolutePath}`, {
          ok: false,
          reason: "not_found",
        });
      }
      if (!statSync(absolutePath).isFile()) {
        return errTextResult(`Error: Path is not a file: ${absolutePath}`, {
          ok: false,
          reason: "not_file",
        });
      }
      const uri = resourceUriForPath(scope, absolutePath);
      const source = readSourceTextCached(absolutePath);
      const sessionId = getToolSessionId(ctx);
      const snapshot = recordSourceSnapshot({
        uri,
        path: absolutePath,
        sourceText: source.sourceText,
        runtime,
        sessionId,
      });
      const mode = normalizeSourceReadMode(params.mode);
      const spans =
        mode === "raw"
          ? [{ startLine: 1, endLine: snapshot.lineCount }]
          : normalizeSpans(params.spans);
      const summary =
        mode === "summary" ? await buildSummary(absolutePath, scope.baseCwd) : undefined;
      return okTextResult(
        formatSourceRead({
          filePath: absolutePath,
          uri,
          snapshot,
          spans,
          mode,
          summary,
        }),
        {
          status: "ok",
          resourceUri: uri,
          filePath: absolutePath,
          snapshot,
          mode,
          sourceCacheHit: source.cacheHit,
        } satisfies SourceReadToolDetails,
      );
    },
  });
}

function preparePlan(input: {
  readonly edits: readonly SourcePatchIntent[];
  readonly scope: ToolTargetScope;
  readonly sessionId: string | undefined;
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
  readonly planId?: string;
  readonly createdAt?: number;
}): StoredSourcePatchPlan {
  const planId = input.planId ?? createId("plan", sha256(JSON.stringify(input.edits)));
  const conflicts: SourcePatchConflict[] = [];
  const pending = new Map<string, PendingFileMutation>();
  const outputPathOwners = new Map<string, string>();
  let staleRecovered = false;

  for (const intent of input.edits) {
    const path = pathFromResourceUri(intent.uri, input.scope);
    if (!path) {
      conflicts.push({ uri: intent.uri, reason: "path_outside_target" });
      continue;
    }

    const existingPending = pending.get(path);
    if (
      existingPending &&
      (intent.kind === "create_file" ||
        intent.kind === "delete_file" ||
        intent.kind === "rename_file" ||
        existingPending.operation !== "write")
    ) {
      conflicts.push({
        uri: intent.uri,
        reason: "path_conflict",
        message: "Structural edits cannot be combined with another edit for the same file.",
      });
      continue;
    }

    if (intent.kind !== "create_file") {
      const generatedConflict = rejectGeneratedTarget(path);
      if (generatedConflict) {
        conflicts.push(generatedConflict);
        continue;
      }
    }

    if (
      intent.kind === "replace_anchor" ||
      intent.kind === "insert_before_anchor" ||
      intent.kind === "insert_after_anchor" ||
      intent.kind === "delete_anchor_range"
    ) {
      let snapshot = SNAPSHOTS.get(intent.snapshotId);
      if (!snapshot) {
        hydrateSnapshotsFromRuntimeEvents({
          runtime: input.runtime,
          sessionId: input.sessionId,
          snapshotIds: [intent.snapshotId],
        });
        snapshot = SNAPSHOTS.get(intent.snapshotId);
      }
      if (!snapshot) {
        conflicts.push({ uri: intent.uri, reason: "snapshot_not_found" });
        continue;
      }
      if (!existsSync(path)) {
        conflicts.push({ uri: intent.uri, reason: "not_found" });
        continue;
      }
      const before = existingPending?.before ?? readExistingFile(path);
      const currentText = existingPending?.after ?? before;
      const applied = applyLineIntent({
        intent,
        snapshot,
        currentText,
        sessionId: input.sessionId,
        runtime: input.runtime,
        planId,
      });
      staleRecovered = staleRecovered || applied.staleRecovered;
      if (applied.conflict) {
        conflicts.push(applied.conflict);
        continue;
      }
      pending.set(path, {
        uri: intent.uri,
        path,
        operation: "write",
        before,
        after: applied.after,
      });
      continue;
    }

    if (intent.kind === "create_file") {
      if (existsSync(path)) {
        conflicts.push({ uri: intent.uri, reason: "already_exists" });
        continue;
      }
      if (
        !reserveOutputPath({
          outputPath: path,
          uri: intent.uri,
          owners: outputPathOwners,
          conflicts,
        })
      ) {
        continue;
      }
      if (isGeneratedPath(path) || isGeneratedContent(intent.content)) {
        conflicts.push({ uri: intent.uri, reason: "generated_file_rejected" });
        continue;
      }
      pending.set(path, {
        uri: intent.uri,
        path,
        operation: "write",
        before: undefined,
        after: intent.content,
      });
      continue;
    }

    if (intent.kind === "delete_file") {
      if (!existsSync(path)) {
        conflicts.push({ uri: intent.uri, reason: "not_found" });
        continue;
      }
      pending.set(path, {
        uri: intent.uri,
        path,
        operation: "delete",
        before: readExistingFile(path),
        after: undefined,
      });
      continue;
    }

    if (intent.kind === "rename_file") {
      const newPath = pathFromResourceUri(intent.newUri, input.scope);
      if (!newPath) {
        conflicts.push({ uri: intent.newUri, reason: "path_outside_target" });
        continue;
      }
      if (existsSync(newPath)) {
        conflicts.push({ uri: intent.newUri, reason: "already_exists" });
        continue;
      }
      if (
        !reserveOutputPath({
          outputPath: newPath,
          uri: intent.newUri,
          owners: outputPathOwners,
          conflicts,
        })
      ) {
        continue;
      }
      const newGeneratedConflict = rejectGeneratedTarget(newPath);
      if (newGeneratedConflict) {
        conflicts.push(newGeneratedConflict);
        continue;
      }
      pending.set(path, {
        uri: intent.uri,
        path,
        operation: "rename",
        before: readExistingFile(path),
        after: undefined,
        oldPath: path,
        newPath,
      });
    }
  }

  const mutations: PreparedFileMutation[] = [...pending.values()].map((mutation) => {
    const action =
      mutation.operation === "rename"
        ? "rename"
        : mutation.before === undefined
          ? "add"
          : mutation.after === undefined
            ? "delete"
            : "modify";
    return {
      uri: mutation.uri,
      path: mutation.path,
      operation: mutation.operation,
      before: mutation.before,
      after: mutation.after,
      change: {
        path: mutation.path,
        action,
        beforeHash: mutation.before === undefined ? undefined : sha256(mutation.before),
        afterHash: mutation.after === undefined ? undefined : sha256(mutation.after),
        oldPath: mutation.oldPath,
        newPath: mutation.newPath,
      },
    };
  });
  conflicts.push(...detectMutationPathConflicts(mutations));

  const preflight: SourcePatchPreflight = {
    ok: conflicts.length === 0,
    staleRecovered,
    generatedFileRejected: conflicts.some(
      (conflict) => conflict.reason === "generated_file_rejected",
    ),
    reason: conflicts[0]?.reason,
  };
  const snapshotIds = input.edits
    .flatMap((intent) => ("snapshotId" in intent ? [intent.snapshotId] : []))
    .filter((value, index, all) => all.indexOf(value) === index);
  const plan: SourcePatchPlan = {
    id: planId,
    status: conflicts.length === 0 ? "prepared" : "conflict",
    createdAt: input.createdAt ?? Date.now(),
    summary: input.summary,
    snapshots: snapshotIds,
    intents: input.edits,
    changes: mutations.map((mutation) => mutation.change),
    conflicts,
    preflight,
    preview: buildPreview(mutations),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  return { plan, mutations };
}

function normalizeIntent(raw: unknown): SourcePatchIntent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string") {
    return null;
  }
  const uri = typeof record.uri === "string" ? record.uri : undefined;
  if (!uri) {
    return null;
  }
  if (kind === "replace_anchor") {
    return typeof record.snapshot_id === "string" &&
      typeof record.start_anchor === "string" &&
      typeof record.replacement === "string"
      ? {
          kind,
          uri,
          snapshotId: record.snapshot_id,
          startAnchor: record.start_anchor,
          endAnchor: typeof record.end_anchor === "string" ? record.end_anchor : undefined,
          replacement: record.replacement,
        }
      : null;
  }
  if (kind === "insert_before_anchor" || kind === "insert_after_anchor") {
    return typeof record.snapshot_id === "string" &&
      typeof record.anchor === "string" &&
      typeof record.insertion === "string"
      ? {
          kind,
          uri,
          snapshotId: record.snapshot_id,
          anchor: record.anchor,
          insertion: record.insertion,
        }
      : null;
  }
  if (kind === "delete_anchor_range") {
    return typeof record.snapshot_id === "string" && typeof record.start_anchor === "string"
      ? {
          kind,
          uri,
          snapshotId: record.snapshot_id,
          startAnchor: record.start_anchor,
          endAnchor: typeof record.end_anchor === "string" ? record.end_anchor : undefined,
        }
      : null;
  }
  if (kind === "create_file") {
    return typeof record.content === "string" ? { kind, uri, content: record.content } : null;
  }
  if (kind === "delete_file") {
    return { kind, uri };
  }
  if (kind === "rename_file") {
    return typeof record.new_uri === "string" ? { kind, uri, newUri: record.new_uri } : null;
  }
  return null;
}

export function prepareAndStoreSourcePatchPlan(input: {
  readonly edits: readonly SourcePatchIntent[];
  readonly scope: ToolTargetScope;
  readonly sessionId?: string;
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
}): StoredSourcePatchPlanReceipt {
  const prepared = preparePlan({
    edits: input.edits,
    scope: input.scope,
    sessionId: input.sessionId,
    runtime: input.runtime,
    summary: input.summary,
    metadata: input.metadata,
  });
  PLANS.set(prepared.plan.id, prepared);
  recordPlan({ runtime: input.runtime, sessionId: input.sessionId, plan: prepared.plan });
  return { plan: prepared.plan };
}

function replayStoredSourcePatchPlan(input: {
  readonly plan: SourcePatchPlan;
  readonly scope: ToolTargetScope;
  readonly sessionId: string | undefined;
  readonly runtime: BrewvaBundledToolRuntime | undefined;
}): StoredSourcePatchPlan {
  if (!input.plan.preflight.ok || input.plan.status !== "prepared") {
    return { plan: input.plan, mutations: [] };
  }
  hydrateSnapshotsFromRuntimeEvents({
    runtime: input.runtime,
    sessionId: input.sessionId,
    snapshotIds: input.plan.snapshots,
  });
  return preparePlan({
    edits: input.plan.intents,
    scope: input.scope,
    sessionId: input.sessionId,
    runtime: input.runtime,
    summary: input.plan.summary,
    metadata: input.plan.metadata,
    planId: input.plan.id,
    createdAt: input.plan.createdAt,
  });
}

function recoverStoredSourcePatchPlan(input: {
  readonly planId: string;
  readonly scope: ToolTargetScope | undefined;
  readonly sessionId: string | undefined;
  readonly runtime: BrewvaBundledToolRuntime | undefined;
}): StoredSourcePatchPlan | undefined {
  const plan = findPlanInRuntimeEvents({
    runtime: input.runtime,
    sessionId: input.sessionId,
    planId: input.planId,
  });
  if (!plan) {
    return undefined;
  }
  if (!input.scope) {
    const stored = { plan, mutations: [] };
    PLANS.set(plan.id, stored);
    return stored;
  }
  const stored = replayStoredSourcePatchPlan({
    plan,
    scope: input.scope,
    sessionId: input.sessionId,
    runtime: input.runtime,
  });
  PLANS.set(stored.plan.id, stored);
  return stored;
}

function getStoredSourcePatchPlan(input: {
  readonly planId: string;
  readonly scope: ToolTargetScope | undefined;
  readonly sessionId: string | undefined;
  readonly runtime: BrewvaBundledToolRuntime | undefined;
}): StoredSourcePatchPlan | undefined {
  return (
    PLANS.get(input.planId) ??
    recoverStoredSourcePatchPlan({
      planId: input.planId,
      scope: input.scope,
      sessionId: input.sessionId,
      runtime: input.runtime,
    })
  );
}

export function applyStoredSourcePatchPlan(input: {
  readonly planId: string;
  readonly sessionId?: string;
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly scope?: ToolTargetScope;
}): SourcePatchApplyReceipt {
  const stored = getStoredSourcePatchPlan({
    planId: input.planId,
    scope: input.scope,
    sessionId: input.sessionId,
    runtime: input.runtime,
  });
  if (!stored) {
    return {
      ok: false,
      result: {
        ok: false,
        planId: input.planId,
        appliedPaths: [],
        failedPaths: [],
        reason: "plan_not_found",
      },
    };
  }
  if (!stored.plan.preflight.ok) {
    const failedPaths = stored.plan.conflicts.map((conflict) => conflict.uri);
    const result: SourcePatchApplyResult = {
      ok: false,
      planId: stored.plan.id,
      appliedPaths: [],
      failedPaths,
      reason: stored.plan.preflight.reason ?? "plan_conflict",
    };
    if (input.sessionId) {
      input.runtime?.capabilities.tools.sourcePatch.plans.apply(input.sessionId, result);
    }
    return { ok: false, result, plan: stored.plan };
  }
  if (stored.plan.status !== "prepared") {
    const result: SourcePatchApplyResult = {
      ok: false,
      planId: stored.plan.id,
      appliedPaths: [],
      failedPaths: stored.plan.changes.map((change) => change.path),
      reason: "plan_not_prepared",
    };
    if (input.sessionId) {
      input.runtime?.capabilities.tools.sourcePatch.plans.apply(input.sessionId, result);
    }
    return { ok: false, result, plan: stored.plan };
  }

  const failedPaths: string[] = [];
  for (const mutation of stored.mutations) {
    if (
      mutation.operation === "write" &&
      mutation.before === undefined &&
      existsSync(mutation.path)
    ) {
      failedPaths.push(mutation.path);
      continue;
    }
    if (mutation.before !== undefined) {
      const current = existsSync(mutation.path) ? readExistingFile(mutation.path) : undefined;
      if (current !== mutation.before) {
        failedPaths.push(mutation.path);
      }
    }
    if (
      mutation.operation === "rename" &&
      mutation.change.newPath &&
      existsSync(mutation.change.newPath)
    ) {
      failedPaths.push(mutation.change.newPath);
    }
  }

  const ok = failedPaths.length === 0;
  const patchSetId = ok ? createId("patch", sha256(stored.plan.id)) : undefined;
  const result: SourcePatchApplyResult = {
    ok,
    planId: stored.plan.id,
    patchSetId,
    appliedPaths: [],
    failedPaths,
    reason: ok ? undefined : "preflight_changed",
  };
  if (!ok) {
    if (input.sessionId) {
      input.runtime?.capabilities.tools.sourcePatch.plans.apply(input.sessionId, result);
    }
    return { ok: false, result, plan: stored.plan };
  }

  let rollbackArtifactRef: string | undefined;
  try {
    rollbackArtifactRef = writeRollbackArtifact({
      patchSetId: patchSetId ?? stored.plan.id,
      mutations: stored.mutations,
      scope: input.scope,
      sessionId: input.sessionId,
    });
  } catch {
    const failedResult: SourcePatchApplyResult = {
      ok: false,
      planId: stored.plan.id,
      patchSetId,
      appliedPaths: [],
      failedPaths: stored.mutations.map((mutation) => mutation.path),
      reason: "rollback_artifact_failed",
    };
    if (input.sessionId) {
      input.runtime?.capabilities.tools.sourcePatch.plans.apply(input.sessionId, failedResult);
    }
    return { ok: false, result: failedResult, plan: stored.plan };
  }

  const appliedPaths: string[] = [];
  for (const mutation of stored.mutations) {
    if (mutation.operation === "rename") {
      const newPath = mutation.change.newPath;
      const oldPath = mutation.change.oldPath ?? mutation.path;
      if (!newPath) {
        continue;
      }
      mkdirSync(dirname(newPath), { recursive: true });
      renameSync(oldPath, newPath);
      appliedPaths.push(newPath);
      continue;
    }
    if (mutation.operation === "delete") {
      if (existsSync(mutation.path)) {
        rmSync(mutation.path);
      }
      appliedPaths.push(mutation.path);
      continue;
    }
    if (mutation.after !== undefined) {
      mkdirSync(dirname(mutation.path), { recursive: true });
      writeFileSync(mutation.path, mutation.after, "utf8");
      appliedPaths.push(mutation.path);
    }
  }

  const patchSet: PatchSet = {
    id: patchSetId ?? stored.plan.id,
    createdAt: Date.now(),
    status: "applied",
    sourcePatchPlanId: stored.plan.id,
    sourceSnapshotIds: stored.plan.snapshots,
    preflight: stored.plan.preflight,
    rollbackArtifactRef,
    changes: [...stored.plan.changes],
  };
  const appliedResult: SourcePatchApplyResult = {
    ok: true,
    planId: stored.plan.id,
    patchSetId: patchSet.id,
    appliedPaths,
    failedPaths: [],
  };
  if (input.sessionId) {
    input.runtime?.capabilities.tools.sourcePatch.plans.apply(input.sessionId, appliedResult);
  }
  return {
    ok: true,
    result: appliedResult,
    plan: stored.plan,
    patchSet,
  };
}

export function createSourcePatchTools(options?: {
  runtime?: BrewvaBundledToolRuntime;
}): [ToolDefinition, ToolDefinition] {
  const prepareFactory = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "source_patch_prepare",
  );
  const applyFactory = createRuntimeBoundBrewvaToolFactory(options?.runtime, "source_patch_apply");
  const prepare = prepareFactory.define({
    name: "source_patch_prepare",
    label: "Source Patch Prepare",
    description:
      "Prepare a multi-file source patch from hash-anchored edit intents. This never mutates files. Anchors look like L42@a1b2c3; copy them verbatim from source_read output.",
    parameters: Type.Object({
      edits: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1, maxItems: 100 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const edits = params.edits.map(normalizeIntent);
      if (edits.some((edit) => edit === null)) {
        return errTextResult("source_patch_prepare rejected: invalid_edit_intent", {
          ok: false,
          reason: "invalid_edit_intent",
        });
      }
      const sessionId = getToolSessionId(ctx);
      const prepared = preparePlan({
        edits: edits.filter((edit): edit is SourcePatchIntent => edit !== null),
        scope: resolveToolTargetScope(prepareFactory.runtime, ctx),
        sessionId,
        runtime: prepareFactory.runtime,
      });
      PLANS.set(prepared.plan.id, prepared);
      recordPlan({ runtime: prepareFactory.runtime, sessionId, plan: prepared.plan });
      if (!prepared.plan.preflight.ok) {
        return sourcePatchConflictResult(prepared.plan.id, prepared.plan.conflicts);
      }
      return okTextResult(
        [
          "[SourcePatchPlan]",
          "status: prepared",
          `plan_id: ${prepared.plan.id}`,
          `changes: ${prepared.plan.changes.length}`,
          "",
          prepared.plan.preview,
        ].join("\n"),
        {
          ok: true,
          status: "prepared",
          planId: prepared.plan.id,
          plan: prepared.plan,
        },
      );
    },
  });
  const apply = applyFactory.define({
    name: "source_patch_apply",
    label: "Source Patch Apply",
    description:
      "Apply a prepared source patch plan after rechecking current file hashes. This is the only source mutation gate.",
    parameters: Type.Object({
      plan_id: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getToolSessionId(ctx);
      const scope = resolveToolTargetScope(applyFactory.runtime, ctx);
      const receipt = applyStoredSourcePatchPlan({
        planId: params.plan_id,
        sessionId,
        runtime: applyFactory.runtime,
        scope,
      });
      if (receipt.result.reason === "plan_not_found") {
        return inconclusiveTextResult("source_patch_apply unavailable: plan_not_found", {
          ok: false,
          reason: "plan_not_found",
        });
      }
      if (!receipt.ok) {
        return errTextResult(
          [
            "[SourcePatchApply]",
            "status: failed",
            `plan_id: ${receipt.result.planId}`,
            `reason: ${receipt.result.reason ?? "preflight_changed"}`,
            ...receipt.result.failedPaths.map((path) => `failed: ${path}`),
          ].join("\n"),
          {
            ...receipt.result,
            ok: false,
            status: "failed",
          },
        );
      }
      return okTextResult(
        [
          "[SourcePatchApply]",
          "status: applied",
          `plan_id: ${receipt.result.planId}`,
          `patch_set_id: ${receipt.patchSet?.id ?? "unknown"}`,
          ...receipt.result.appliedPaths.map((path) => `applied: ${path}`),
        ].join("\n"),
        {
          ...receipt.result,
          ok: true,
          status: "applied",
          patchSet: receipt.patchSet ?? null,
        },
      );
    },
  });
  return [prepare, apply];
}

async function resourceRouterForRoot(input: {
  readonly cwd: string;
  readonly roots?: readonly string[];
}): Promise<BrewvaResourceRouter> {
  const cacheKey = `${input.cwd}\0${(input.roots ?? [input.cwd]).join("\0")}`;
  const cached = RESOURCE_ROUTERS.get(cacheKey);
  if (cached) {
    return cached;
  }
  const created = Promise.resolve(
    createBrewvaResourceRouter({
      cwd: input.cwd,
      loader: () => createHostedResourceLoader({ cwd: input.cwd, agentDir: input.cwd }),
      roots: input.roots,
    }),
  );
  RESOURCE_ROUTERS.set(cacheKey, created);
  return created;
}

function formatResourceRead(result: BrewvaResourceReadResult): string {
  if (result.status !== "ok") {
    return [
      "[ResourceRead]",
      "status: unavailable",
      `uri: ${result.uri}`,
      `reason: ${result.reason ?? "provider_unavailable"}`,
    ].join("\n");
  }
  return [
    "[ResourceRead]",
    "status: ok",
    `uri: ${result.uri}`,
    `media_type: ${result.mediaType ?? "text/plain"}`,
    "",
    result.content ?? "",
  ].join("\n");
}

function parseRouterPath(uri: string, scheme: string): string {
  const prefix = `brewva-resource:///${scheme}/`;
  return uri.startsWith(prefix) ? decodeURIComponent(uri.slice(prefix.length)) : "";
}

function createAgentResourceProvider(input: {
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly sessionId?: string;
}): BrewvaResourceProvider {
  return {
    scheme: "agent",
    async read(uri) {
      const [runId] = parseRouterPath(uri, "agent").split("/");
      if (!runId) {
        return { status: "unavailable", uri, reason: "missing_agent_id" };
      }
      if (!input.sessionId || !input.runtime?.delegation?.listRuns) {
        return { status: "unavailable", uri, reason: "agent_runtime_unavailable" };
      }
      const runs = await input.runtime.delegation.listRuns(input.sessionId, {
        runIds: [runId],
        includeTerminal: true,
        limit: 1,
      });
      const run = runs[0];
      if (!run) {
        return { status: "unavailable", uri, reason: "not_found" };
      }
      return {
        status: "ok",
        uri,
        mediaType: "application/json",
        content: JSON.stringify(run),
      };
    },
  };
}

function createConflictResourceProvider(input: {
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly sessionId?: string;
  readonly scope: ToolTargetScope;
}): BrewvaResourceProvider {
  return {
    scheme: "conflict",
    read(uri) {
      const [planId] = parseRouterPath(uri, "conflict").split("/");
      const stored = planId
        ? getStoredSourcePatchPlan({
            planId,
            scope: input.scope,
            sessionId: input.sessionId,
            runtime: input.runtime,
          })
        : undefined;
      if (!stored || stored.plan.conflicts.length === 0) {
        return { status: "unavailable", uri, reason: "not_found" };
      }
      return {
        status: "ok",
        uri,
        mediaType: "application/json",
        content: JSON.stringify({
          planId: stored.plan.id,
          conflicts: stored.plan.conflicts,
        }),
      };
    },
  };
}

export function createResourceReadTool(options?: {
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly providers?: readonly BrewvaResourceProvider[];
}): ToolDefinition {
  const rawRuntime = options?.runtime;
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "resource_read",
  );
  return define({
    name: "resource_read",
    label: "Resource Read",
    description:
      "Read non-source Brewva resources through brewva-resource:/// URIs. Source files should use source_read.",
    parameters: Type.Object({
      uri: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolTargetScope(runtime, ctx);
      const sessionId = getToolSessionId(ctx);
      const router = await resourceRouterForRoot({
        cwd: scope.baseCwd,
        roots: scope.allowedRoots,
      });
      const result = await router.read(params.uri, [
        createAgentResourceProvider({ runtime: rawRuntime, sessionId }),
        createConflictResourceProvider({ runtime, sessionId, scope }),
        ...(options?.providers ?? []),
      ]);
      if (sessionId) {
        runtime?.capabilities.tools.sourcePatch.resources.read(sessionId, {
          uri: result.uri,
          mediaType: result.mediaType,
        });
      }
      if (result.status !== "ok") {
        return inconclusiveTextResult(formatResourceRead(result), {
          ok: false,
          status: result.status,
          uri: result.uri,
          reason: result.reason ?? "provider_unavailable",
        });
      }
      return okTextResult(formatResourceRead(result), {
        ok: true,
        status: result.status,
        uri: result.uri,
        mediaType: result.mediaType ?? null,
      });
    },
  });
}
