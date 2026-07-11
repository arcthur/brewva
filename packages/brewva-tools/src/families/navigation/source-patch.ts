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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrewvaAgentDir } from "@brewva/brewva-runtime/config";
import { sha256Hex } from "@brewva/brewva-std/hash";
import {
  createBrewvaResourceRouter,
  createHostedResourceLoader,
  parseUriSchemePrefix,
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
  describeRuntimeArtifactReadRejection,
  describeTargetScopeRejection,
  resolveRuntimeArtifactReadRejection,
  resolveScopedPath,
  resolveToolTargetScope,
  type ToolTargetScope,
} from "../../runtime-port/target-scope.js";
import { errTextResult, inconclusiveTextResult, okTextResult } from "../../utils/result.js";
import { noteFileAccess } from "./grep/engine/index.js";
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
// Reveal-on-reject caps (borrowed from oh-my-pi's seen-lines enforcement). A
// rejected edit inlines at most this many unseen lines, each clipped to this many
// columns. Only a complete, full-width reveal merges into the working seen set —
// and, past oh-my-pi, a snapshot may absorb at most SEEN_LINE_REVEAL_CAP lines
// total via such merges across every prepare (the reveal-merge budget in
// applyLineIntent). So the model cannot piecewise-reveal a wide blind region in
// <=cap slices across retries; once the budget is spent it must re-read.
const SEEN_LINE_REVEAL_CAP = 40;
const SEEN_LINE_REVEAL_MAX_COLUMNS = 512;
const SOURCE_URI_GRAMMAR_HINT =
  "Accepted uri forms: a repo-relative or absolute file path, source:///<path>, brewva-resource:///file/<path>, or file:///<absolute-path>.";
// Schemes source_read can serve without the resource loader. Anything else
// fails fast here: routing it would materialize the hosted loader (a full
// skill-discovery scan) just to learn the scheme is unknown.
const SOURCE_READ_URI_SCHEMES = new Set(["file", "source", "brewva-resource"]);

function hasUnknownSourceReadScheme(uri: string): boolean {
  const parsed = parseUriSchemePrefix(uri);
  return parsed !== null && !SOURCE_READ_URI_SCHEMES.has(parsed.scheme);
}
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

/**
 * Working seen-line set per snapshot: the harness-held seen-proof that replaced
 * the per-line token. Lazily seeded from the snapshot's persisted `seenLines`
 * (covering fresh reads and resume rehydration alike) and augmented in-session by
 * a complete reveal-on-reject, which is deliberately not re-persisted — a resumed
 * session re-reveals rather than re-reads. Process-scoped; the tape's snapshot
 * payload stays the durable source of truth.
 */
const SEEN_LINES = new Map<string, Set<number>>();

function getSeenLineSet(snapshot: SourceSnapshot): Set<number> {
  let seen = SEEN_LINES.get(snapshot.id);
  if (!seen) {
    seen = new Set(snapshot.seenLines);
    SEEN_LINES.set(snapshot.id, seen);
  }
  return seen;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sha256(input: string): string {
  return `sha256:${sha256Hex(input)}`;
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
  return lines.map((text, index) => ({ line: index + 1, text }));
}

function allLineNumbers(lineCount: number): number[] {
  return Array.from({ length: lineCount }, (_, index) => index + 1);
}

// Builds a draft snapshot; `seenLines` is left empty for the caller to finalize
// (from the render's displayed lines, or all lines for full-file provenance).
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
    seenLines: [],
  };
}

/**
 * Record a snapshot on behalf of a caller that read the whole file (LSP rename,
 * worker-results settlement, grep anchoring). `seenLines` defaults to every line
 * because such callers have full-file provenance; the model-facing `source_read`
 * tool instead passes the exact displayed subset so the seen-proof narrows to
 * what the model actually saw. See {@link SourceSnapshot.seenLines}.
 */
export function recordSourceSnapshot(input: {
  readonly uri: string;
  readonly path: string;
  readonly sourceText: string;
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly sessionId?: string;
  readonly seenLines?: readonly number[];
}): SourceSnapshot {
  const built = buildSnapshot(input);
  const snapshot: SourceSnapshot = {
    ...built,
    seenLines: input.seenLines ?? allLineNumbers(built.lineCount),
  };
  commitSnapshot({ snapshot, runtime: input.runtime, sessionId: input.sessionId });
  return snapshot;
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
    const payload = decodeURIComponent(uri.slice("brewva-resource:///file/".length));
    return resolveStrippedUriPayload(payload, scope);
  }
  const parsed = parseUriSchemePrefix(uri);
  if (parsed?.scheme === "source") {
    return resolveStrippedUriPayload(decodeURIComponent(parsed.payload), scope);
  }
  return resolveScopedPath(uri, scope);
}

// Resource-uri payloads strip leading slashes (resourceUriForPath and the
// router's source alias both do), so an absolute path can arrive in relative
// shape. Resolve cwd-relative first, then fall back to the filesystem-root
// interpretation; a payload nothing resolves keeps the cwd-relative answer so
// create-file intents and error messages stay anchored to the base cwd.
function resolveStrippedUriPayload(payload: string, scope: ToolTargetScope): string | null {
  const relativeCandidate = resolveScopedPath(payload, scope);
  if (relativeCandidate && existsSync(relativeCandidate)) {
    return relativeCandidate;
  }
  const rootedCandidate = resolveScopedPath(resolve("/", payload), scope);
  if (rootedCandidate && existsSync(rootedCandidate)) {
    return rootedCandidate;
  }
  return relativeCandidate;
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

function rejectRuntimeArtifactTarget(
  path: string,
  scope: ToolTargetScope,
  uri: string,
): SourcePatchConflict | null {
  const runtimeArtifact = resolveRuntimeArtifactReadRejection(path, scope);
  return runtimeArtifact
    ? {
        uri,
        reason: runtimeArtifact.reason,
        message: "Runtime artifact storage is not a source patch target.",
      }
    : null;
}

// Relocate a snapshot line whose content moved: the unique current line whose
// text equals the snapshot's stored text. This is exactly the old cached-`hash`
// relocation (the hash was only `sha256(text)`), now comparing text directly.
function findRecoveredAnchor(input: {
  readonly expected: SourceLineAnchor;
  readonly currentLines: readonly string[];
}): SourceLineAnchor | null {
  let match: SourceLineAnchor | null = null;
  for (let index = 0; index < input.currentLines.length; index += 1) {
    if (input.currentLines[index] === input.expected.text) {
      if (match) {
        return null;
      }
      match = { line: index + 1, text: input.expected.text };
    }
  }
  return match;
}

function resolveCurrentLine(input: {
  readonly snapshot: SourceSnapshot;
  readonly line: number;
  readonly currentLines: readonly string[];
  readonly sessionId: string | undefined;
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly planId: string;
}): { readonly anchor: SourceLineAnchor | null; readonly staleRecovered: boolean } {
  const expected = input.snapshot.anchors[input.line - 1];
  if (!expected) {
    return { anchor: null, staleRecovered: false };
  }
  if (input.currentLines[expected.line - 1] === expected.text) {
    return { anchor: expected, staleRecovered: false };
  }
  const recovered = findRecoveredAnchor({ expected, currentLines: input.currentLines });
  if (input.sessionId) {
    const record: SourcePatchStaleRecoveryRecord = {
      planId: input.planId,
      snapshotId: input.snapshot.id,
      uri: input.snapshot.uri,
      recovered: Boolean(recovered),
      reason: recovered ? undefined : "line_not_found",
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

// The snapshot line numbers an intent touches — the seen-proof scope. Replace and
// delete cover their whole range; an insert must have seen its reference line.
function intentLineSpan(
  intent: SourcePatchIntent,
): { readonly startLine: number; readonly endLine: number } | null {
  if (intent.kind === "insert_before_line" || intent.kind === "insert_after_line") {
    return { startLine: intent.line, endLine: intent.line };
  }
  if (intent.kind === "replace_lines" || intent.kind === "delete_lines") {
    const end = intent.endLine ?? intent.startLine;
    return {
      startLine: Math.min(intent.startLine, end),
      endLine: Math.max(intent.startLine, end),
    };
  }
  return null;
}

interface RevealedLine {
  readonly line: number;
  readonly text: string;
}

// Render the unseen lines for a rejection: at most SEEN_LINE_REVEAL_CAP lines,
// each clipped to SEEN_LINE_REVEAL_MAX_COLUMNS columns. `complete` means this one
// reveal showed every unseen line in full width — the single-reveal precondition
// for a merge (the cumulative budget check in applyLineIntent is the other half).
function revealUnseenLines(input: {
  readonly snapshot: SourceSnapshot;
  readonly unseen: readonly number[];
}): { readonly revealed: readonly RevealedLine[]; readonly complete: boolean } {
  const unseen = [...input.unseen].toSorted((left, right) => left - right);
  const revealCount = Math.min(unseen.length, SEEN_LINE_REVEAL_CAP);
  const revealed: RevealedLine[] = [];
  let columnTruncated = false;
  for (let index = 0; index < revealCount; index += 1) {
    const line = unseen[index];
    const anchor = line === undefined ? undefined : input.snapshot.anchors[line - 1];
    if (!anchor) {
      // Defensive: applyLineIntent range-checks the span before calling, so every
      // unseen line has an anchor. If that ever changes, dropping the line keeps
      // the reveal incomplete so it never merges — fail closed, never crash.
      continue;
    }
    if (anchor.text.length > SEEN_LINE_REVEAL_MAX_COLUMNS) {
      revealed.push({
        line: anchor.line,
        text: `${anchor.text.slice(0, SEEN_LINE_REVEAL_MAX_COLUMNS)}…`,
      });
      columnTruncated = true;
    } else {
      revealed.push({ line: anchor.line, text: anchor.text });
    }
  }
  return { revealed, complete: revealed.length === unseen.length && !columnTruncated };
}

// Compose the `unseen_lines` rejection message. `outcome` decides the guidance:
// `merged` — the reveal was complete and within budget, so a straight retry now
// lands; `truncated` — the reveal was clipped (too many lines or too wide) so the
// model must re-read; `budget` — the reveal was complete but the snapshot's
// cumulative reveal-merge budget is spent, so re-read rather than piecewise-reveal.
function unseenLinesMessage(input: {
  readonly unseenCount: number;
  readonly revealed: readonly RevealedLine[];
  readonly outcome: "merged" | "truncated" | "budget";
}): string {
  const head =
    input.outcome === "merged"
      ? `${input.unseenCount} target line(s) were not shown by source_read. Revealed in full — retry the same edit to apply:`
      : `${input.unseenCount} target line(s) were not shown by source_read. Re-read the target range with source_read before editing:`;
  const tail =
    input.outcome === "merged"
      ? []
      : input.outcome === "budget"
        ? [
            "reveal_budget_exhausted: too much of this snapshot revealed without a read; re-read the target range with source_read.",
          ]
        : ["reveal_truncated: re-read the target range with source_read before editing."];
  return [head, ...input.revealed.map((entry) => `${entry.line}:${entry.text}`), ...tail].join(
    "\n",
  );
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
  // Set when re-deriving mutations for a tape-attested prepared plan on apply. The
  // seen-check is a prepare-time attention gate the tape's `prepared` status already
  // records; re-running it against the non-persisted in-session reveal set would flip
  // a cleanly-prepared plan to a contradictory `unseen_lines` conflict at apply.
  readonly trustSeen?: boolean;
}): {
  readonly after: string;
  readonly staleRecovered: boolean;
  readonly conflict?: SourcePatchConflict;
} {
  const lines = splitLines(input.currentText);
  const intent = input.intent;
  const span = intentLineSpan(intent);
  if (!span) {
    return {
      after: input.currentText,
      staleRecovered: false,
      conflict: { uri: input.snapshot.uri, reason: "unsupported_line_intent" },
    };
  }
  if (span.startLine < 1 || span.endLine > input.snapshot.lineCount) {
    return {
      after: input.currentText,
      staleRecovered: false,
      conflict: {
        uri: input.snapshot.uri,
        reason: "line_out_of_range",
        message: `Lines ${span.startLine}-${span.endLine} fall outside the snapshot (${input.snapshot.lineCount} lines).`,
      },
    };
  }

  // Seen-check: every touched line must have been shown by the read that minted
  // the snapshot. On a miss, reveal the unseen lines (a complete reveal merges so
  // a straight retry lands) and reject this attempt. Skipped on replay of an
  // already-prepared plan (see `trustSeen`).
  if (!input.trustSeen) {
    const seen = getSeenLineSet(input.snapshot);
    const unseen: number[] = [];
    for (let line = span.startLine; line <= span.endLine; line += 1) {
      if (!seen.has(line)) {
        unseen.push(line);
      }
    }
    if (unseen.length > 0) {
      const reveal = revealUnseenLines({ snapshot: input.snapshot, unseen });
      // Cross-prepare anti-piecewise budget: a snapshot may absorb at most
      // SEEN_LINE_REVEAL_CAP lines total via reveal-merge across every prepare.
      // `seen` only ever grows here, and `snapshot.seenLines` is its dedup-free
      // seed, so `seen.size - seenLines.length` is exactly how much has already
      // been reveal-merged. Once the budget is spent the reveal stops merging, so
      // the model cannot walk a wide blind region in <=cap slices — it must re-read.
      const revealMergedSoFar = seen.size - input.snapshot.seenLines.length;
      const withinBudget = revealMergedSoFar + unseen.length <= SEEN_LINE_REVEAL_CAP;
      const merged = reveal.complete && withinBudget;
      if (merged) {
        // A complete, in-budget reveal covered every unseen line in full, so
        // `unseen` is exactly the set to merge for a straight retry to land.
        for (const line of unseen) {
          seen.add(line);
        }
      }
      const message = unseenLinesMessage({
        unseenCount: unseen.length,
        revealed: reveal.revealed,
        outcome: merged ? "merged" : reveal.complete ? "budget" : "truncated",
      });
      return {
        after: input.currentText,
        staleRecovered: false,
        conflict: { uri: input.snapshot.uri, reason: "unseen_lines", message },
      };
    }
  }

  const first = resolveCurrentLine({
    snapshot: input.snapshot,
    line: span.startLine,
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
        reason: "line_not_found",
        message: `Unable to resolve line ${span.startLine}.`,
      },
    };
  }

  if (intent.kind === "insert_before_line") {
    const nextLines = [...lines];
    nextLines.splice(first.anchor.line - 1, 0, ...normalizeReplacementLines(intent.insertion));
    return { after: joinLines(nextLines, input.currentText), staleRecovered: first.staleRecovered };
  }
  if (intent.kind === "insert_after_line") {
    const nextLines = [...lines];
    nextLines.splice(first.anchor.line, 0, ...normalizeReplacementLines(intent.insertion));
    return { after: joinLines(nextLines, input.currentText), staleRecovered: first.staleRecovered };
  }

  const last = resolveCurrentLine({
    snapshot: input.snapshot,
    line: span.endLine,
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
        reason: "line_not_found",
        message: `Unable to resolve line ${span.endLine}.`,
      },
    };
  }
  // Fail closed when drift relocated the two endpoints to an inconsistent range:
  // the recovered span must match the seen span the model authored. Splicing
  // min..max of independently relocated endpoints would rewrite whatever current
  // lines fall between them — an interior insertion or a reorder the seen-gate
  // never vetted (the gate only proved the two endpoints' text). A whole-range
  // shift (e.g. leading-line insertion) keeps the span, so legitimate recovery is
  // untouched; only an inconsistent relocation trips this. Re-read rather than clobber.
  if (last.anchor.line - first.anchor.line !== span.endLine - span.startLine) {
    return {
      after: input.currentText,
      staleRecovered: first.staleRecovered || last.staleRecovered,
      conflict: {
        uri: input.snapshot.uri,
        reason: "range_relocation_conflict",
        message: `Lines ${span.startLine}-${span.endLine} no longer form a contiguous range after drift; re-read the target range with source_read before editing.`,
      },
    };
  }
  const startLine = Math.min(first.anchor.line, last.anchor.line);
  const endLine = Math.max(first.anchor.line, last.anchor.line);
  const nextLines = [...lines];
  const replacement =
    intent.kind === "replace_lines" ? normalizeReplacementLines(intent.replacement) : [];
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

// Cache the finalized snapshot in-process and record it to the tape. The cache is
// set unconditionally (a session-less read still needs the snapshot resolvable by
// prepare/apply); the tape record no-ops without a session.
function commitSnapshot(input: {
  readonly snapshot: SourceSnapshot;
  readonly runtime: BrewvaBundledToolRuntime | undefined;
  readonly sessionId: string | undefined;
}): void {
  SNAPSHOTS.set(input.snapshot.id, input.snapshot);
  recordSnapshot(input);
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
  return typeof record?.line === "number" && typeof record.text === "string";
}

// Requiring `seenLines` is deliberate: a pre-cutover snapshot payload (no seen set)
// fails this guard and is not rehydrated, so the model re-reads and re-mints a
// new-format snapshot. The missing field is the clean-break fail-closed signal.
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
    record.anchors.every(isSourceLineAnchor) &&
    Array.isArray(record.seenLines) &&
    record.seenLines.every((line) => typeof line === "number")
  );
}

function isSourcePatchIntent(value: unknown): value is SourcePatchIntent {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string" || typeof record.uri !== "string") {
    return false;
  }
  if (record.kind === "replace_lines") {
    return (
      typeof record.snapshotId === "string" &&
      typeof record.startLine === "number" &&
      (record.endLine === undefined || typeof record.endLine === "number") &&
      typeof record.replacement === "string"
    );
  }
  if (record.kind === "insert_before_line" || record.kind === "insert_after_line") {
    return (
      typeof record.snapshotId === "string" &&
      typeof record.line === "number" &&
      typeof record.insertion === "string"
    );
  }
  if (record.kind === "delete_lines") {
    return (
      typeof record.snapshotId === "string" &&
      typeof record.startLine === "number" &&
      (record.endLine === undefined || typeof record.endLine === "number")
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
  // No catch: the legitimate "nothing recorded" case is the early-return above. The event
  // query is an in-process projection read — a genuine read error is a real failure, not an
  // empty result, so it surfaces (and lets the tool report a failure) rather than being
  // swallowed into a misleading "plan_not_found" / "snapshot_not_found".
  return input.runtime.capabilities.events.records.query(input.sessionId, { type: input.type });
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

// Renders `NN:<text>` per line and returns the displayed line numbers as the
// snapshot's seen set. The caller records the snapshot carrying these, so an edit
// may only target a line this read actually printed.
function formatSourceRead(input: {
  readonly filePath: string;
  readonly uri: string;
  readonly snapshot: SourceSnapshot;
  readonly spans: readonly NormalizedSpan[];
  readonly mode: string;
  readonly summary?: readonly string[];
}): { readonly text: string; readonly seenLines: number[] } {
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
  const seenLines: number[] = [];
  for (const span of input.spans) {
    if (seenLines.length >= MAX_SOURCE_READ_LINES) {
      break;
    }
    const startLine = Math.max(1, span.startLine);
    const endLine = Math.min(span.endLine, input.snapshot.anchors.length);
    if (startLine > endLine) {
      continue;
    }
    output.push("", `[Span ${formatSpan(startLine, endLine)}]`);
    for (
      let line = startLine;
      line <= endLine && seenLines.length < MAX_SOURCE_READ_LINES;
      line += 1
    ) {
      const anchor = input.snapshot.anchors[line - 1];
      if (!anchor) {
        continue;
      }
      output.push(`${anchor.line}:${anchor.text}`);
      seenLines.push(anchor.line);
    }
  }
  return { text: output.join("\n"), seenLines };
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
      "Read source resources as line-numbered content (each line is NN:text) under a snapshot id. Use this before source_patch_prepare: edits reference lines by number, and only lines a source_read displayed can be edited.",
    parameters: Type.Object({
      uri: Type.String({
        minLength: 1,
        description:
          "File to read: repo-relative or absolute path; source:///<path>, brewva-resource:///file/<path>, and file:// URIs are also accepted.",
      }),
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
      if (hasUnknownSourceReadScheme(params.uri)) {
        return errTextResult(
          `source_read unavailable: unknown_scheme (uri: ${params.uri}). ${SOURCE_URI_GRAMMAR_HINT}`,
          { ok: false, reason: "unknown_scheme" },
        );
      }
      const scope = resolveToolTargetScope(runtime, ctx);
      const preflightPath = pathFromResourceUri(params.uri, scope);
      const preflightRuntimeArtifact = preflightPath
        ? resolveRuntimeArtifactReadRejection(preflightPath, scope)
        : null;
      if (preflightRuntimeArtifact) {
        return errTextResult(
          describeRuntimeArtifactReadRejection({
            tool: "source_read",
            subject: "uri",
            offending: params.uri,
          }),
          {
            ok: false,
            reason: preflightRuntimeArtifact.reason,
            artifact: preflightRuntimeArtifact.artifact,
            artifactRoot: preflightRuntimeArtifact.artifactRoot,
          },
        );
      }
      const router = await resourceRouterForRoot({
        cwd: scope.baseCwd,
        roots: scope.allowedRoots,
      });
      const resource = await router.read(params.uri);
      const absolutePath = resource.path ?? preflightPath;
      if (!absolutePath) {
        return errTextResult(
          describeTargetScopeRejection({
            tool: "source_read",
            subject: "uri",
            allowedRoots: scope.allowedRoots,
            offending: params.uri,
          }),
          { ok: false, reason: "path_outside_target" },
        );
      }
      const runtimeArtifact = resolveRuntimeArtifactReadRejection(absolutePath, scope);
      if (runtimeArtifact) {
        return errTextResult(
          describeRuntimeArtifactReadRejection({
            tool: "source_read",
            subject: "uri",
            offending: params.uri,
          }),
          {
            ok: false,
            reason: runtimeArtifact.reason,
            artifact: runtimeArtifact.artifact,
            artifactRoot: runtimeArtifact.artifactRoot,
          },
        );
      }
      if (
        resource.status !== "ok" &&
        resource.reason !== "not_found" &&
        resource.reason !== "not_file"
      ) {
        const reason = resource.reason ?? "not_found";
        const hint = reason === "unknown_scheme" ? ` ${SOURCE_URI_GRAMMAR_HINT}` : "";
        return errTextResult(`source_read unavailable: ${reason} (uri: ${params.uri}).${hint}`, {
          ok: false,
          reason,
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
      // Build the snapshot, then render to learn which lines were displayed, then
      // record the snapshot carrying that seen set — the read must know its own
      // displayed lines before it commits the snapshot the seen-proof rests on.
      const built = buildSnapshot({
        uri,
        path: absolutePath,
        sourceText: source.sourceText,
      });
      const mode = normalizeSourceReadMode(params.mode);
      const spans =
        mode === "raw"
          ? [{ startLine: 1, endLine: built.lineCount }]
          : normalizeSpans(params.spans);
      const summary =
        mode === "summary" ? await buildSummary(absolutePath, scope.baseCwd) : undefined;
      const rendered = formatSourceRead({
        filePath: absolutePath,
        uri,
        snapshot: built,
        spans,
        mode,
        summary,
      });
      const snapshot: SourceSnapshot = { ...built, seenLines: rendered.seenLines };
      commitSnapshot({ snapshot, runtime, sessionId });
      // Record the read so fff frecency learns which files this session touches.
      noteFileAccess(scope.baseCwd, absolutePath);
      return okTextResult(rendered.text, {
        status: "ok",
        resourceUri: uri,
        filePath: absolutePath,
        snapshot,
        mode,
        sourceCacheHit: source.cacheHit,
      } satisfies SourceReadToolDetails);
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
  // Propagated to the seen-check: true only when replaying a tape-attested prepared
  // plan on apply, never on a fresh prepare.
  readonly trustSeen?: boolean;
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
    const runtimeArtifactConflict = rejectRuntimeArtifactTarget(path, input.scope, intent.uri);
    if (runtimeArtifactConflict) {
      conflicts.push(runtimeArtifactConflict);
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
      intent.kind === "replace_lines" ||
      intent.kind === "insert_before_line" ||
      intent.kind === "insert_after_line" ||
      intent.kind === "delete_lines"
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
        trustSeen: input.trustSeen,
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
      const newRuntimeArtifactConflict = rejectRuntimeArtifactTarget(
        newPath,
        input.scope,
        intent.newUri,
      );
      if (newRuntimeArtifactConflict) {
        conflicts.push(newRuntimeArtifactConflict);
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
  if (kind === "replace_lines") {
    return typeof record.snapshot_id === "string" &&
      typeof record.start_line === "number" &&
      typeof record.replacement === "string"
      ? {
          kind,
          uri,
          snapshotId: record.snapshot_id,
          startLine: record.start_line,
          endLine: typeof record.end_line === "number" ? record.end_line : undefined,
          replacement: record.replacement,
        }
      : null;
  }
  if (kind === "insert_before_line" || kind === "insert_after_line") {
    return typeof record.snapshot_id === "string" &&
      typeof record.line === "number" &&
      typeof record.insertion === "string"
      ? {
          kind,
          uri,
          snapshotId: record.snapshot_id,
          line: record.line,
          insertion: record.insertion,
        }
      : null;
  }
  if (kind === "delete_lines") {
    return typeof record.snapshot_id === "string" && typeof record.start_line === "number"
      ? {
          kind,
          uri,
          snapshotId: record.snapshot_id,
          startLine: record.start_line,
          endLine: typeof record.end_line === "number" ? record.end_line : undefined,
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
    // The plan already passed the seen-gate at prepare time (its persisted status is
    // `prepared`); the reveal-merge set is not durable, so re-gating on replay would
    // wrongly reject. File-state re-checks (drift, generated, conflict) still run.
    trustSeen: true,
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
    ...(rollbackArtifactRef !== undefined ? { rollbackArtifactRef } : {}),
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
      "Prepare a multi-file source patch from line-numbered edit intents (never mutates files). Each edit is a record {kind, uri, snapshot_id, ...}: replace_lines {start_line, end_line?, replacement} | insert_before_line or insert_after_line {line, insertion} | delete_lines {start_line, end_line?} | create_file {content} | delete_file | rename_file {new_uri}. Line numbers come from source_read; only displayed lines are editable.",
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
      "Apply a prepared source patch plan after re-checking current file contents. This is the only source mutation gate.",
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
  // Skill discovery treats resolve(agentDir, "..") as the global skill root,
  // so the loader needs the real agent config dir; passing cwd here made the
  // first read walk the workspace parent (sibling repos, shared temp dirs).
  const agentDir = resolveBrewvaAgentDir();
  const cacheKey = `${input.cwd}\0${agentDir}\0${(input.roots ?? [input.cwd]).join("\0")}`;
  const cached = RESOURCE_ROUTERS.get(cacheKey);
  if (cached) {
    return cached;
  }
  const created = Promise.resolve(
    createBrewvaResourceRouter({
      cwd: input.cwd,
      loader: () => createHostedResourceLoader({ cwd: input.cwd, agentDir }),
      roots: input.roots,
    }),
  );
  RESOURCE_ROUTERS.set(cacheKey, created);
  return created;
}

function formatResourceRead(result: BrewvaResourceReadResult): string {
  if (result.status !== "ok") {
    const lines = [
      "[ResourceRead]",
      "status: unavailable",
      `uri: ${result.uri}`,
      `reason: ${result.reason ?? "provider_unavailable"}`,
    ];
    if (result.reason === "unknown_scheme") {
      lines.push(`hint: ${SOURCE_URI_GRAMMAR_HINT}`);
    }
    return lines.join("\n");
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
      const preflightPath = pathFromResourceUri(params.uri, scope);
      const preflightRuntimeArtifact = preflightPath
        ? resolveRuntimeArtifactReadRejection(preflightPath, scope)
        : null;
      if (preflightRuntimeArtifact) {
        return errTextResult(
          describeRuntimeArtifactReadRejection({
            tool: "resource_read",
            subject: "uri",
            offending: params.uri,
          }),
          {
            ok: false,
            reason: preflightRuntimeArtifact.reason,
            artifact: preflightRuntimeArtifact.artifact,
            artifactRoot: preflightRuntimeArtifact.artifactRoot,
          },
        );
      }
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
