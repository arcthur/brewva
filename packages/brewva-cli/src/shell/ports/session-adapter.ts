import { randomUUID } from "node:crypto";
import { runHostedPromptTurn, selectNextModelPresetName } from "@brewva/brewva-gateway/hosted";
import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  BrewvaPromptAssistantMessageEvent,
  BrewvaPromptSessionEvent,
  BrewvaModelPresetState,
  BrewvaPromptThinkingLevel,
  BrewvaSessionEntry,
  SessionPhase,
} from "@brewva/brewva-substrate/session";
import type { ContextEntryRecord } from "@brewva/brewva-vocabulary/context";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { buildReasoningRevertSummaryDetails } from "@brewva/brewva-vocabulary/iteration";
import type { BrewvaOutcome } from "@brewva/brewva-vocabulary/outcome";
import { SESSION_REWIND_DIVERGENCE_SCHEMA } from "@brewva/brewva-vocabulary/session";
import type { SessionRewindDivergenceNote } from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import {
  getCliRuntimeLineageTree,
  getCliRuntimeRewindState,
  getCliRuntimeSessionWire,
  listCliRuntimeEvents,
  listCliRuntimeRewindTargets,
  recordCliRuntimeLineageSelection,
  recordCliRuntimeRewindCheckpoint,
  redoCliRuntimeSession,
  rewindCliRuntimeSession,
} from "../../runtime/runtime-ports.js";
import { createShellCockpitWireFoldStore } from "../domain/cockpit/wire-fold.js";
import type {
  CliShellSessionBundle,
  SessionLineageStatusView,
  SessionProjectionMode,
  SessionTreeCheckoutResult,
  SessionTreeEntryView,
  SessionTreeProjectionView,
  SessionTreeRewindTargetResolution,
  SessionViewPort,
  SessionWireFrameReadOptions,
} from "./session-port.js";
export { createCliShellPromptStore } from "../domain/prompt-store.js";

const BRANCH_CARRY_SUMMARY_SCHEMA = "brewva.session.tree.branch-carry-summary.v1";
const BRANCH_CARRY_SUMMARY_MAX_CHARS = 1_600;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

interface TreeCapableSessionManager {
  getSessionId(): string;
  getLeafId(): string | null | undefined;
  getLineageNodeId(): string;
  getBranch(fromId?: string | null): BrewvaSessionEntry[];
  buildSessionContext(): {
    messages: unknown;
  };
  branch(entryId: string): void;
  resetLeaf(): void;
  branchWithSummary(
    targetLeafEntryId: string | null,
    summaryText: string,
    summaryDetails: Record<string, unknown>,
    replaceCurrent: boolean,
  ): string;
  checkoutLineageNode(lineageNodeId: string, leafEntryId?: string | null): void;
  resolveLineageLeafEntryId(lineageNodeId: string): string | null;
}

const TREE_SESSION_MANAGER_METHODS = [
  "getSessionId",
  "getLeafId",
  "getLineageNodeId",
  "getBranch",
  "buildSessionContext",
  "branch",
  "resetLeaf",
  "branchWithSummary",
  "checkoutLineageNode",
  "resolveLineageLeafEntryId",
] satisfies readonly (keyof TreeCapableSessionManager)[];

function readTreeSessionManager(bundle: CliShellSessionBundle): TreeCapableSessionManager {
  const sessionManager = bundle.session.sessionManager as
    | Partial<TreeCapableSessionManager>
    | null
    | undefined;
  for (const method of TREE_SESSION_MANAGER_METHODS) {
    if (typeof sessionManager?.[method] !== "function") {
      throw new Error(`session_manager_tree_contract_missing:${method}`);
    }
  }
  return sessionManager as TreeCapableSessionManager;
}

function readSessionManagerLineageNodeId(sessionManager: TreeCapableSessionManager): string {
  const value = sessionManager.getLineageNodeId();
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("session_manager_tree_contract_invalid:getLineageNodeId");
  }
  return value;
}

function readSessionManagerLeafEntryId(sessionManager: TreeCapableSessionManager): string | null {
  const value = sessionManager.getLeafId();
  return typeof value === "string" && value.trim() ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function takeGraphemes(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) {
    return { text: "", truncated: text.length > 0 };
  }
  const segments: string[] = [];
  let count = 0;
  for (const part of GRAPHEME_SEGMENTER.segment(text)) {
    if (count >= maxChars) {
      return { text: segments.join(""), truncated: true };
    }
    segments.push(part.segment);
    count += 1;
  }
  return { text, truncated: false };
}

function truncatePreview(text: string, maxChars = 96): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const head = takeGraphemes(normalized, maxChars - 3);
  if (!head.truncated) {
    return normalized;
  }
  return `${head.text.trimEnd()}...`;
}

function truncateText(text: string, maxChars: number): string {
  return takeGraphemes(text, maxChars).text.trimEnd();
}

function normalizeSummaryText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function readMessageText(content: unknown): {
  text: string;
  omittedNonText: boolean;
  fileReference: boolean;
} {
  if (typeof content === "string") {
    return { text: content, omittedNonText: false, fileReference: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", omittedNonText: true, fileReference: false };
  }
  let text = "";
  let omittedNonText = false;
  let fileReference = false;
  for (const part of content) {
    if (!isRecord(part)) {
      omittedNonText = true;
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
      continue;
    }
    if (part.type === "file") {
      fileReference = true;
      text +=
        readString(part.displayText) ?? readString(part.name) ?? readString(part.uri) ?? "[file]";
      continue;
    }
    omittedNonText = true;
  }
  return { text, omittedNonText, fileReference };
}

function readTreeEntryText(input: {
  sourceEvent?: BrewvaEventRecord;
  contextEntry: ContextEntryRecord;
}): {
  role: string | null;
  preview: string;
  searchableText: string;
  restorablePromptText: string | null;
  restorationAdvisory: string | null;
} {
  const payload = isRecord(input.sourceEvent?.payload) ? input.sourceEvent.payload : {};
  const message = isRecord(payload.message) ? payload.message : null;
  if (message) {
    const role = readString(message.role);
    const content = readMessageText(message.content);
    const preview = truncatePreview(content.text || role || input.contextEntry.entryKind);
    const restorablePromptText = role === "user" ? content.text : null;
    const referenceAdvisory =
      restorablePromptText &&
      (content.fileReference ||
        /(^|\s)@\S+/u.test(restorablePromptText) ||
        restorablePromptText.trimStart().startsWith("/"));
    const restorationAdvisory =
      role === "user" && (content.omittedNonText || referenceAdvisory)
        ? [
            "Restored literal prompt text.",
            referenceAdvisory
              ? "References will be re-resolved against the current workspace."
              : "",
            content.omittedNonText ? "One or more non-text prompt parts were omitted." : "",
          ]
            .filter((part) => part.length > 0)
            .join(" ")
        : null;
    return {
      role,
      preview,
      searchableText: content.text,
      restorablePromptText,
      restorationAdvisory,
    };
  }

  const summary = readString(payload.summary) ?? readString(payload.sanitizedSummary);
  if (summary) {
    return {
      role: input.contextEntry.entryKind === "compaction" ? "compactionSummary" : "branchSummary",
      preview: truncatePreview(summary),
      searchableText: summary,
      restorablePromptText: null,
      restorationAdvisory: null,
    };
  }

  const fallbackText = input.contextEntry.text ?? input.contextEntry.entryKind;
  return {
    role: null,
    preview: truncatePreview(fallbackText),
    searchableText: fallbackText,
    restorablePromptText: null,
    restorationAdvisory: null,
  };
}

async function ensureSessionInitialPersistence(session: unknown): Promise<void> {
  const ensureInitialPersistence = (
    session as { ensureInitialPersistence?: unknown } | null | undefined
  )?.ensureInitialPersistence;
  if (typeof ensureInitialPersistence !== "function") {
    return;
  }
  await ensureInitialPersistence.call(session);
}

function readLineageStatus(bundle: CliShellSessionBundle): SessionLineageStatusView {
  try {
    const sessionManager = readTreeSessionManager(bundle);
    const sessionId = sessionManager.getSessionId();
    const tree = getCliRuntimeLineageTree(bundle.runtime, sessionId);
    const lineageNodeId = readSessionManagerLineageNodeId(sessionManager);
    const node = tree.nodes.find((candidate) => candidate.lineageNodeId === lineageNodeId) ?? null;
    const childCount = tree.edges.filter(
      (edge) => edge.parentLineageNodeId === lineageNodeId,
    ).length;
    return {
      lineageNodeId,
      kind: node?.kind ?? null,
      title: node?.title ?? null,
      childCount,
      nodeCount: tree.nodes.length,
      unsupportedReason: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      lineageNodeId: null,
      kind: null,
      title: null,
      childCount: 0,
      nodeCount: 0,
      unsupportedReason: reason,
    };
  }
}

function buildTreeProjection(bundle: CliShellSessionBundle): SessionTreeProjectionView {
  const sessionManager = readTreeSessionManager(bundle);
  const sessionId = sessionManager.getSessionId();
  const contextEntries: ContextEntryRecord[] =
    bundle.runtime.ops.session.lineage.getContextEntryPath(sessionId, {});
  const eventsById = new Map(
    listCliRuntimeEvents(bundle.runtime, sessionId).map((event) => [event.id, event] as const),
  );
  const entries: SessionTreeEntryView[] = contextEntries.map((contextEntry) => {
    const sourceEvent = eventsById.get(contextEntry.sourceEventId);
    const text = readTreeEntryText({ sourceEvent, contextEntry });
    return {
      entryId: contextEntry.entryId,
      parentEntryId: contextEntry.parentEntryId,
      lineageNodeId: contextEntry.lineageNodeId,
      sourceEventId: contextEntry.sourceEventId,
      sourceEventType: contextEntry.sourceEventType,
      entryKind: contextEntry.entryKind,
      admission: contextEntry.admission,
      presentTo: contextEntry.presentTo,
      timestamp: contextEntry.timestamp,
      role: text.role,
      preview: text.preview,
      searchableText: text.searchableText,
      workspaceEffectPatchSetCount: 0,
      restorablePromptText: text.restorablePromptText,
      hasRestorationAdvisory: text.restorationAdvisory !== null,
      restorationAdvisory: text.restorationAdvisory,
    };
  });
  const workspaceEffectCounts = buildWorkspaceEffectPatchSetCounts(bundle, sessionId, entries);
  for (const entry of entries) {
    entry.workspaceEffectPatchSetCount = workspaceEffectCounts.get(entry.entryId) ?? 0;
  }
  return {
    sessionId,
    currentEntryId: readSessionManagerLeafEntryId(sessionManager),
    currentLineageNodeId: readSessionManagerLineageNodeId(sessionManager),
    entries,
  };
}

function buildWorkspaceEffectPatchSetCounts(
  bundle: CliShellSessionBundle,
  sessionId: string,
  entries: readonly SessionTreeEntryView[],
): Map<string, number> {
  const entriesById = new Map(entries.map((entry) => [entry.entryId, entry] as const));
  const activeTargetsByCheckpointId = new Map(
    listCliRuntimeRewindTargets(bundle.runtime, sessionId)
      .filter((target) => target.lineage.kind === "active")
      .map((target) => [target.checkpointId, target] as const),
  );
  const checkpoints = getCliRuntimeRewindState(bundle.runtime, sessionId).checkpoints;
  const counts = new Map<string, number>();

  for (const entry of entries) {
    const path = entryPath(entry.entryId, entriesById);
    let best:
      | {
          pathIndex: number;
          timestamp: number;
          patchSetCountAfter: number;
        }
      | undefined;
    for (const checkpoint of checkpoints) {
      if (!checkpoint.leafEntryId) {
        continue;
      }
      const target = activeTargetsByCheckpointId.get(checkpoint.checkpointId);
      if (!target) {
        continue;
      }
      const pathIndex = path.findIndex((pathEntry) => pathEntry.entryId === checkpoint.leafEntryId);
      if (pathIndex < 0) {
        continue;
      }
      if (
        !best ||
        pathIndex > best.pathIndex ||
        (pathIndex === best.pathIndex && target.timestamp > best.timestamp)
      ) {
        best = {
          pathIndex,
          timestamp: target.timestamp,
          patchSetCountAfter: target.patchSetCountAfter,
        };
      }
    }
    counts.set(entry.entryId, best?.patchSetCountAfter ?? 0);
  }

  return counts;
}

function entryPath(
  entryId: string | null,
  entriesById: ReadonlyMap<string, SessionTreeEntryView>,
): SessionTreeEntryView[] {
  const path: SessionTreeEntryView[] = [];
  const seen = new Set<string>();
  let cursor = entryId ? entriesById.get(entryId) : undefined;
  while (cursor && !seen.has(cursor.entryId)) {
    seen.add(cursor.entryId);
    path.unshift(cursor);
    cursor = cursor.parentEntryId ? entriesById.get(cursor.parentEntryId) : undefined;
  }
  return path;
}

function resolveTreeRewindTargetForProjection(
  bundle: CliShellSessionBundle,
  projection: SessionTreeProjectionView,
  entryId: string,
): SessionTreeRewindTargetResolution {
  const entriesById = new Map(projection.entries.map((entry) => [entry.entryId, entry] as const));
  const path = entryPath(entryId, entriesById);
  if (path.length === 0) {
    return { kind: "none", entryId };
  }
  const activeTargetsByCheckpointId = new Map(
    listCliRuntimeRewindTargets(bundle.runtime, projection.sessionId)
      .filter((target) => target.lineage.kind === "active")
      .map((target) => [target.checkpointId, target] as const),
  );
  const checkpoints = getCliRuntimeRewindState(bundle.runtime, projection.sessionId).checkpoints;
  let best:
    | {
        checkpointId: string;
        turn: number;
        pathIndex: number;
      }
    | undefined;
  for (const checkpoint of checkpoints) {
    const target = activeTargetsByCheckpointId.get(checkpoint.checkpointId);
    if (!target || !checkpoint.leafEntryId) {
      continue;
    }
    const pathIndex = path.findIndex((entry) => entry.entryId === checkpoint.leafEntryId);
    if (pathIndex < 0) {
      continue;
    }
    if (
      !best ||
      pathIndex > best.pathIndex ||
      (pathIndex === best.pathIndex &&
        target.timestamp > activeTargetsByCheckpointId.get(best.checkpointId)!.timestamp)
    ) {
      best = {
        checkpointId: checkpoint.checkpointId,
        turn: target.turn,
        pathIndex,
      };
    }
  }
  if (!best) {
    return { kind: "none", entryId };
  }
  return {
    kind: "checkpoint",
    entryId,
    checkpointId: best.checkpointId,
    turn: best.turn,
    exact: path[best.pathIndex]?.entryId === entryId,
    crossedEntryCount: Math.max(0, path.length - 1 - best.pathIndex),
  };
}

function buildGeneratedBranchCarrySummary(input: {
  abandonedEntries: readonly BrewvaSessionEntry[];
  fromEntryId: string | null;
  toEntryId: string | null;
  instructions?: string;
}): string {
  const contentLines = input.abandonedEntries
    .map(formatAbandonedEntrySummaryLine)
    .filter((line): line is string => line !== null);
  const lines = [
    "Branch carry summary",
    `from: ${input.fromEntryId ?? "root"}`,
    `to: ${input.toEntryId ?? "root"}`,
    input.instructions ? `operator_instructions: ${input.instructions}` : "",
    "abandoned_branch_content:",
    ...(contentLines.length > 0
      ? contentLines.map((line) => `- ${line}`)
      : ["- No textual content found."]),
  ].filter((line) => line.length > 0);
  return truncateText(lines.join("\n"), BRANCH_CARRY_SUMMARY_MAX_CHARS);
}

function formatAbandonedEntrySummaryLine(entry: BrewvaSessionEntry): string | null {
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    const role = readString(message.role) ?? "message";
    const content = readMessageText(message.content);
    const text = normalizeSummaryText(content.text);
    return text.length > 0
      ? `${entry.id} ${role}: ${text}`
      : `${entry.id} ${role}: [non-text message omitted]`;
  }
  if (entry.type === "custom_message") {
    const content = readMessageText(entry.content);
    const text = normalizeSummaryText(content.text);
    return text.length > 0
      ? `${entry.id} custom:${entry.customType}: ${text}`
      : `${entry.id} custom:${entry.customType}: [non-text message omitted]`;
  }
  if (entry.type === "branch_summary") {
    return `${entry.id} branch_summary: ${normalizeSummaryText(entry.summary)}`;
  }
  if (entry.type === "compaction") {
    return `${entry.id} compaction: ${normalizeSummaryText(entry.summary)}`;
  }
  if (entry.type === "model_change") {
    return `${entry.id} model_change: ${entry.provider}/${entry.modelId}`;
  }
  if (entry.type === "model_preset_select") {
    return `${entry.id} model_preset_select: ${entry.presetName}`;
  }
  if (entry.type === "thinking_level_change") {
    return `${entry.id} thinking_level_change: ${entry.thinkingLevel}`;
  }
  return null;
}

function abandonedEntriesBetween(input: {
  sessionManager: TreeCapableSessionManager;
  oldLeafEntryId: string | null;
  targetLeafEntryId: string | null;
}): BrewvaSessionEntry[] {
  const oldPath = input.sessionManager.getBranch(input.oldLeafEntryId);
  const targetPath = input.sessionManager.getBranch(input.targetLeafEntryId);
  const targetIds = new Set(targetPath.map((entry) => entry.id));
  let commonIndex = -1;
  for (const [index, entry] of oldPath.entries()) {
    if (targetIds.has(entry.id)) {
      commonIndex = index;
    }
  }
  return oldPath.slice(commonIndex + 1);
}

async function checkoutTreeEntryInSession(
  bundle: CliShellSessionBundle,
  input: {
    entryId: string;
    channelId?: string;
    reason?: string;
    carry?: {
      mode: "none" | "summary";
      instructions?: string;
    };
  },
): Promise<SessionTreeCheckoutResult> {
  const sessionManager = readTreeSessionManager(bundle);
  const projection = buildTreeProjection(bundle);
  const target = projection.entries.find((entry) => entry.entryId === input.entryId);
  if (!target) {
    throw new Error(`session_tree_entry_missing:${input.entryId}`);
  }

  const oldLeafEntryId = sessionManager.getLeafId() ?? null;
  const targetLeafEntryId =
    target.restorablePromptText !== null ? target.parentEntryId : target.entryId;
  const previousLineageNodeId = readSessionManagerLineageNodeId(sessionManager);

  const abandonedEntries =
    input.carry?.mode === "summary"
      ? abandonedEntriesBetween({
          sessionManager,
          oldLeafEntryId,
          targetLeafEntryId,
        })
      : [];

  if (targetLeafEntryId) {
    sessionManager.branch(targetLeafEntryId);
  } else {
    sessionManager.resetLeaf();
  }

  let summaryRecordedId: string | undefined;
  if (input.carry?.mode === "summary" && abandonedEntries.length > 0) {
    const summary = buildGeneratedBranchCarrySummary({
      abandonedEntries,
      fromEntryId: oldLeafEntryId,
      toEntryId: targetLeafEntryId,
      instructions: input.carry.instructions,
    });
    summaryRecordedId = sessionManager.branchWithSummary(
      targetLeafEntryId,
      summary,
      {
        schema: BRANCH_CARRY_SUMMARY_SCHEMA,
        source: "tree_checkout",
        activeSummaryKey: `context_entry:${targetLeafEntryId ?? "root"}`,
        forkPointEntryId: targetLeafEntryId,
        fromEntryId: oldLeafEntryId,
        toEntryId: targetLeafEntryId,
        abandonedEntryIds: abandonedEntries.map((entry) => entry.id),
        abandonedRange: {
          fromEntryId: oldLeafEntryId,
          toEntryId: targetLeafEntryId,
          entryIds: abandonedEntries.map((entry) => entry.id),
        },
        generation: {
          kind: "deterministic",
          maxChars: BRANCH_CARRY_SUMMARY_MAX_CHARS,
          generatedAt: new Date().toISOString(),
        },
        ...(input.carry.instructions ? { instructions: input.carry.instructions } : {}),
      },
      false,
    );
  }

  await replaceSessionMessagesFromCurrentContext(bundle);
  const lineageNodeId = readSessionManagerLineageNodeId(sessionManager);
  recordCliRuntimeLineageSelection(bundle.runtime, projection.sessionId, {
    selectionId: `cli:${randomUUID()}`,
    channelId: input.channelId ?? "cli",
    lineageNodeId,
    previousLineageNodeId,
    reason: input.reason ?? "tree_checkout",
  });

  return {
    entryId: target.entryId,
    activeLeafEntryId: sessionManager.getLeafId() ?? null,
    lineageNodeId,
    ...(target.restorablePromptText !== null
      ? { restoredPrompt: { text: target.restorablePromptText } }
      : {}),
    ...(target.restorationAdvisory ? { restorationAdvisory: target.restorationAdvisory } : {}),
    ...(summaryRecordedId ? { summaryRecordedId } : {}),
  };
}

function buildDivergenceSummaryDetails(note: SessionRewindDivergenceNote): Record<string, unknown> {
  return {
    schema: SESSION_REWIND_DIVERGENCE_SCHEMA,
    kind: note.kind,
    patchSetCount: note.patchSetCount,
    parentLeafEntryId: note.parentLeafEntryId,
  };
}

async function replaceSessionMessagesFromCurrentContext(
  bundle: CliShellSessionBundle,
): Promise<void> {
  const context = bundle.session.sessionManager.buildSessionContext?.();
  if (!context || !Array.isArray(context.messages)) {
    throw new Error("Session rewind requires sessionManager.buildSessionContext().");
  }
  if (typeof bundle.session.replaceMessages !== "function") {
    throw new Error("Session rewind requires session.replaceMessages().");
  }
  await bundle.session.replaceMessages(context.messages);
}

function appendRewindDivergenceSummary(
  bundle: CliShellSessionBundle,
  note: SessionRewindDivergenceNote,
  fallbackLeafEntryId: string | null,
): void {
  const sessionManager = bundle.session.sessionManager;
  if (typeof sessionManager.branchWithSummary !== "function") {
    throw new Error("Session rewind divergence requires sessionManager.branchWithSummary().");
  }
  const parentLeafEntryId =
    sessionManager.getLeafId?.() ?? note.parentLeafEntryId ?? fallbackLeafEntryId;
  sessionManager.branchWithSummary(
    parentLeafEntryId,
    note.text,
    buildDivergenceSummaryDetails(note),
    true,
  );
}

type SessionViewPortListener = (event: BrewvaPromptSessionEvent) => void;

type RuntimeToolSessionWireFrame = Extract<
  SessionWireFrame,
  { type: "tool.progress" | "tool.finished" }
>;
type RuntimeThinkingDeltaFrame = Extract<SessionWireFrame, { type: "assistant.delta" }>;
type ModelStreamingSessionPhase = Extract<SessionPhase, { kind: "model_streaming" }>;
type ToolExecutingSessionPhase = Extract<SessionPhase, { kind: "tool_executing" }>;

const LIVE_SESSION_WIRE_FRAME_LIMIT = 512;

function readReplayItemSequence(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("sequence" in value)) {
    return undefined;
  }
  const sequence = value.sequence;
  return typeof sequence === "number" && Number.isFinite(sequence) ? sequence : undefined;
}

interface RuntimeTurnSessionProjectionState {
  assistantSegmentText: string;
  assistantSegmentProjected: boolean;
  emittedAssistantMessage: boolean;
  phaseKey: string | null;
  currentPhase: SessionPhase;
  lastModelPhase: ModelStreamingSessionPhase | null;
  lastToolPhase: ToolExecutingSessionPhase | null;
}

function buildAssistantTextMessage(text: string): {
  readonly role: "assistant";
  readonly stopReason: "stop";
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly timestamp: number;
} {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function buildAssistantDeltaEvent(input: {
  delta: string;
  assistantText: string;
}): Extract<BrewvaPromptSessionEvent, { type: "message_update" }> {
  return {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: input.delta,
      partial: buildAssistantTextMessage(input.assistantText),
    } satisfies Extract<BrewvaPromptAssistantMessageEvent, { type: "text_delta" }>,
  };
}

function createRuntimeTurnSessionProjectionState(): RuntimeTurnSessionProjectionState {
  return {
    assistantSegmentText: "",
    assistantSegmentProjected: false,
    emittedAssistantMessage: false,
    phaseKey: null,
    currentPhase: { kind: "idle" },
    lastModelPhase: null,
    lastToolPhase: null,
  };
}

function sessionWireFrameKey(frame: SessionWireFrame): string {
  return frame.sourceEventId
    ? `${frame.sourceEventId}:${frame.type}`
    : `${frame.sessionId}:${frame.frameId}`;
}

function sessionWireFrameTurnId(frame: SessionWireFrame): string | undefined {
  return "turnId" in frame && typeof frame.turnId === "string" ? frame.turnId : undefined;
}

function isEvictableLiveSessionWireFrame(frame: SessionWireFrame): boolean {
  return frame.type === "assistant.delta" || frame.type === "tool.progress";
}

function rememberLiveSessionWireFrame(
  frames: Map<string, SessionWireFrame>,
  frame: SessionWireFrame,
  limit = LIVE_SESSION_WIRE_FRAME_LIMIT,
): void {
  const turnId = sessionWireFrameTurnId(frame);
  if (turnId && frame.type === "turn.committed") {
    for (const [key, current] of frames) {
      if (
        sessionWireFrameTurnId(current) === turnId &&
        current.type === "assistant.delta" &&
        current.durability === "cache"
      ) {
        frames.delete(key);
      }
    }
  }
  frames.set(sessionWireFrameKey(frame), frame);
  while (frames.size > limit) {
    let oldestKey: string | undefined;
    for (const [key, candidate] of frames) {
      if (isEvictableLiveSessionWireFrame(candidate)) {
        oldestKey = key;
        break;
      }
    }
    oldestKey ??= frames.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    frames.delete(oldestKey);
  }
}

export function createLiveSessionWireFrameStore(limit = LIVE_SESSION_WIRE_FRAME_LIMIT): {
  remember(frame: SessionWireFrame): void;
  values(): IterableIterator<SessionWireFrame>;
} {
  const frames = new Map<string, SessionWireFrame>();
  return {
    remember(frame) {
      rememberLiveSessionWireFrame(frames, frame, limit);
    },
    values() {
      return frames.values();
    },
  };
}

function mergedSessionWireFrames(input: {
  readonly durableFrames: readonly SessionWireFrame[];
  readonly liveFrames: Iterable<SessionWireFrame>;
  readonly sessionId: string;
}): SessionWireFrame[] {
  const framesByKey = new Map<string, SessionWireFrame>();
  for (const frame of input.durableFrames) {
    framesByKey.set(sessionWireFrameKey(frame), frame);
  }
  for (const frame of input.liveFrames) {
    if (frame.sessionId !== input.sessionId) {
      continue;
    }
    framesByKey.set(sessionWireFrameKey(frame), frame);
  }
  return [...framesByKey.values()].toSorted((left, right) => {
    const timestampOrder = left.ts - right.ts;
    return timestampOrder === 0 ? left.frameId.localeCompare(right.frameId) : timestampOrder;
  });
}

function createDurableSessionWireReader(bundle: CliShellSessionBundle): {
  read(sessionId: string, options?: SessionWireFrameReadOptions): readonly SessionWireFrame[];
} {
  let cache:
    | {
        readonly sessionId: string;
        readonly frames: readonly SessionWireFrame[];
      }
    | undefined;

  return {
    read(sessionId, options) {
      const refreshDurable = options?.refreshDurable ?? true;
      if (refreshDurable || cache?.sessionId !== sessionId) {
        cache = {
          sessionId,
          frames: getCliRuntimeSessionWire(bundle.runtime, sessionId),
        };
      }
      return cache.frames;
    },
  };
}

function parseRuntimeTurnNumber(turnId: string): number {
  const numeric = turnId.match(/\d+/u)?.[0];
  if (!numeric) {
    return 0;
  }
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? parsed : 0;
}

function runtimeAttemptId(frame: { readonly attemptId?: string }): string {
  return "attemptId" in frame && typeof frame.attemptId === "string"
    ? frame.attemptId
    : "attempt-1";
}

function modelStreamingPhase(frame: {
  readonly turnId: string;
  readonly attemptId?: string;
}): SessionPhase {
  return {
    kind: "model_streaming",
    modelCallId: `runtime-turn:${frame.turnId}:${runtimeAttemptId(frame)}`,
    turn: parseRuntimeTurnNumber(frame.turnId),
  };
}

function toolExecutingPhase(
  frame: Extract<SessionWireFrame, { type: "tool.started" | "tool.progress" | "tool.finished" }>,
): ToolExecutingSessionPhase {
  return {
    kind: "tool_executing",
    toolCallId: frame.toolCallId,
    toolName: frame.toolName,
    turn: parseRuntimeTurnNumber(frame.turnId),
  };
}

function sessionPhaseKey(phase: SessionPhase): string {
  switch (phase.kind) {
    case "model_streaming":
      return `${phase.kind}:${phase.turn}:${phase.modelCallId}`;
    case "tool_executing":
      return `${phase.kind}:${phase.turn}:${phase.toolCallId}`;
    case "waiting_approval":
      return `${phase.kind}:${phase.turn}:${phase.requestId}`;
    case "recovering":
      return `${phase.kind}:${phase.turn}:${phase.recoveryAnchor ?? ""}`;
    case "crashed":
      return `${phase.kind}:${phase.turn}:${phase.crashAt}:${phase.modelCallId ?? ""}:${
        phase.toolCallId ?? ""
      }`;
    case "terminated":
      return `${phase.kind}:${phase.reason}`;
    case "idle":
    default:
      return phase.kind;
  }
}

function emitRuntimeSessionPhase(input: {
  state: RuntimeTurnSessionProjectionState;
  phase: SessionPhase;
  emit(event: BrewvaPromptSessionEvent): void;
}): void {
  input.state.currentPhase = input.phase;
  if (input.phase.kind === "model_streaming") {
    input.state.lastModelPhase = input.phase;
  }
  if (input.phase.kind === "tool_executing") {
    input.state.lastToolPhase = input.phase;
  }
  if (input.phase.kind === "idle" || input.phase.kind === "terminated") {
    input.state.lastModelPhase = null;
    input.state.lastToolPhase = null;
  }
  const nextKey = sessionPhaseKey(input.phase);
  if (input.state.phaseKey === nextKey) {
    return;
  }
  input.state.phaseKey = nextKey;
  input.emit({
    type: "session_phase_change",
    phase: input.phase,
  });
}

function emitRuntimeThinkingProgress(input: {
  frame: RuntimeThinkingDeltaFrame;
  state: RuntimeTurnSessionProjectionState;
  emit(event: BrewvaPromptSessionEvent): void;
}): void {
  emitRuntimeSessionPhase({
    state: input.state,
    phase: modelStreamingPhase(input.frame),
    emit: (event) => input.emit(event),
  });
  input.emit({
    type: "session_wire_progress",
    frameType: "assistant.delta",
    lane: "thinking",
    turnId: input.frame.turnId,
    attemptId: input.frame.attemptId,
  });
}

function finishRuntimeTurnAssistantSegment(input: {
  state: RuntimeTurnSessionProjectionState;
  emit(event: BrewvaPromptSessionEvent): void;
}): void {
  const text = input.state.assistantSegmentText;
  input.state.assistantSegmentText = "";
  input.state.assistantSegmentProjected = false;
  if (text.trim().length === 0) {
    return;
  }
  input.state.emittedAssistantMessage = true;
  input.emit({
    type: "message_end",
    message: buildAssistantTextMessage(text),
  });
}

function runtimeToolDetails(frame: RuntimeToolSessionWireFrame): unknown {
  return frame.details ?? { verdict: frame.verdict };
}

function readRuntimeToolOutcomeReason(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const reason = (value as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

function buildRuntimeToolOutcome(frame: RuntimeToolSessionWireFrame): BrewvaOutcome {
  const details = runtimeToolDetails(frame);
  if (frame.isError || frame.verdict === "fail") {
    return { kind: "err", error: details };
  }
  if (frame.verdict === "inconclusive") {
    const reason = readRuntimeToolOutcomeReason(details);
    return {
      kind: "inconclusive",
      ...(reason ? { reason } : {}),
      value: details,
    };
  }
  return { kind: "ok", value: details };
}

function buildRuntimeToolResultPayload(frame: RuntimeToolSessionWireFrame): {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: unknown;
  readonly display?: RuntimeToolSessionWireFrame["display"];
  readonly verdict: RuntimeToolSessionWireFrame["verdict"];
  readonly isError: boolean;
  readonly outcome: BrewvaOutcome;
} {
  return {
    content: frame.text.length > 0 ? [{ type: "text", text: frame.text }] : [],
    details: runtimeToolDetails(frame),
    ...(frame.display ? { display: frame.display } : {}),
    verdict: frame.verdict,
    isError: frame.isError,
    outcome: buildRuntimeToolOutcome(frame),
  };
}

export function buildSessionWireTranscriptSeedMessages(
  frames: readonly SessionWireFrame[],
): unknown[] {
  const turnInputsById = new Map<string, Extract<SessionWireFrame, { type: "turn.input" }>>();
  const emittedTurnInputs = new Set<string>();
  const messages: unknown[] = [];
  type ReplaySeedItem = {
    readonly ts: number;
    readonly sequence?: number;
    readonly order: number;
    readonly message: unknown;
  };
  const sortedFrames = [...frames].toSorted((left, right) => {
    if (left.ts !== right.ts) {
      return left.ts - right.ts;
    }
    return left.frameId.localeCompare(right.frameId);
  });

  for (const frame of sortedFrames) {
    if (frame.type === "turn.input") {
      turnInputsById.set(frame.turnId, turnInputsById.get(frame.turnId) ?? frame);
    }
  }

  for (const frame of sortedFrames) {
    if (frame.type !== "turn.committed") {
      continue;
    }

    const inputFrame = turnInputsById.get(frame.turnId);
    if (inputFrame && !emittedTurnInputs.has(frame.turnId)) {
      emittedTurnInputs.add(frame.turnId);
      if (inputFrame.promptText.trim().length > 0) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: inputFrame.promptText }],
          timestamp: inputFrame.ts,
        });
      }
    }

    const replayItems: ReplaySeedItem[] = [];
    const assistantSegments =
      frame.assistantSegments?.filter((segment) => segment.text.trim().length > 0) ?? [];
    let order = 0;
    for (const segment of assistantSegments) {
      replayItems.push({
        ts: segment.ts,
        sequence: readReplayItemSequence(segment),
        order,
        message: {
          role: "assistant",
          stopReason: frame.status === "completed" ? "stop" : "error",
          content: [{ type: "text", text: segment.text }],
          timestamp: segment.ts,
        },
      });
      order += 1;
    }
    for (const toolOutput of frame.toolOutputs) {
      replayItems.push({
        ts: toolOutput.ts ?? frame.ts,
        sequence: readReplayItemSequence(toolOutput),
        order,
        message: {
          role: "toolResult",
          toolCallId: toolOutput.toolCallId,
          toolName: toolOutput.toolName,
          content: toolOutput.text.length > 0 ? [{ type: "text", text: toolOutput.text }] : [],
          details: toolOutput.details ?? { verdict: toolOutput.verdict },
          ...(toolOutput.display ? { display: toolOutput.display } : {}),
          verdict: toolOutput.verdict,
          isError: toolOutput.isError,
          timestamp: toolOutput.ts ?? frame.ts,
        },
      });
      order += 1;
    }
    if (assistantSegments.length === 0 && frame.assistantText.trim().length > 0) {
      replayItems.push({
        ts: frame.ts,
        order,
        message: {
          role: "assistant",
          stopReason: frame.status === "completed" ? "stop" : "error",
          content: [{ type: "text", text: frame.assistantText }],
          timestamp: frame.ts,
        },
      });
    }
    for (const item of replayItems.toSorted((left, right) => {
      if (left.sequence !== undefined && right.sequence !== undefined) {
        const sequenceOrder = left.sequence - right.sequence;
        if (sequenceOrder !== 0) {
          return sequenceOrder;
        }
      }
      if (left.ts !== right.ts) {
        return left.ts - right.ts;
      }
      return left.order - right.order;
    })) {
      messages.push(item.message);
    }
  }

  return messages;
}

function emitRuntimeTurnSessionFrame(input: {
  frame: SessionWireFrame;
  state: RuntimeTurnSessionProjectionState;
  emit(event: BrewvaPromptSessionEvent): void;
}): void {
  const frame = input.frame;
  const state = input.state;
  const emit = (event: BrewvaPromptSessionEvent): void => {
    input.emit(event);
  };
  if (frame.type === "turn.input") {
    emitRuntimeSessionPhase({
      state,
      phase: modelStreamingPhase(frame),
      emit,
    });
    return;
  }
  if (frame.type === "assistant.delta" && frame.lane === "answer" && frame.delta.length > 0) {
    emitRuntimeSessionPhase({
      state,
      phase: modelStreamingPhase(frame),
      emit,
    });
    const previousSegmentText = state.assistantSegmentText;
    state.assistantSegmentText += frame.delta;
    if (state.assistantSegmentText.trim().length === 0) {
      return;
    }
    const projectedDelta = state.assistantSegmentProjected
      ? frame.delta
      : `${previousSegmentText}${frame.delta}`;
    state.assistantSegmentProjected = true;
    input.emit(
      buildAssistantDeltaEvent({
        delta: projectedDelta,
        assistantText: state.assistantSegmentText,
      }),
    );
    return;
  }
  if (frame.type === "assistant.delta" && frame.lane === "thinking" && frame.delta.length > 0) {
    emitRuntimeThinkingProgress({ frame, state, emit });
    return;
  }
  if (frame.type === "tool.started") {
    finishRuntimeTurnAssistantSegment(input);
    emitRuntimeSessionPhase({
      state,
      phase: toolExecutingPhase(frame),
      emit,
    });
    input.emit({
      type: "tool_execution_start",
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
    });
    return;
  }
  if (frame.type === "tool.progress") {
    finishRuntimeTurnAssistantSegment(input);
    emitRuntimeSessionPhase({
      state,
      phase: toolExecutingPhase(frame),
      emit,
    });
    input.emit({
      type: "tool_execution_update",
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
      partialResult: buildRuntimeToolResultPayload(frame),
    });
    return;
  }
  if (frame.type === "tool.finished") {
    finishRuntimeTurnAssistantSegment(input);
    input.emit({
      type: "tool_execution_end",
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
      result: buildRuntimeToolResultPayload(frame),
      isError: frame.isError,
    });
    emitRuntimeSessionPhase({
      state,
      phase: modelStreamingPhase(frame),
      emit,
    });
    return;
  }
  if (frame.type === "approval.requested") {
    finishRuntimeTurnAssistantSegment(input);
    emitRuntimeSessionPhase({
      state,
      phase: {
        kind: "waiting_approval",
        requestId: frame.requestId,
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        turn: parseRuntimeTurnNumber(frame.turnId),
      },
      emit,
    });
    return;
  }
  if (frame.type === "approval.decided") {
    if (state.currentPhase.kind === "waiting_approval") {
      emitRuntimeSessionPhase({
        state,
        phase: state.lastToolPhase ?? state.lastModelPhase ?? { kind: "idle" },
        emit,
      });
    }
    return;
  }
  if (frame.type === "turn.transition") {
    finishRuntimeTurnAssistantSegment(input);
    if (
      frame.status === "entered" &&
      (frame.family === "recovery" || frame.family === "output_budget")
    ) {
      emitRuntimeSessionPhase({
        state,
        phase: {
          kind: "recovering",
          recoveryAnchor: `transition:${frame.reason}`,
          turn: parseRuntimeTurnNumber(frame.turnId),
        },
        emit,
      });
      return;
    }
    if (frame.status === "entered" && frame.family === "approval" && state.lastToolPhase) {
      emitRuntimeSessionPhase({
        state,
        phase: {
          kind: "waiting_approval",
          requestId: `transition:${frame.reason}`,
          toolCallId: state.lastToolPhase.toolCallId,
          toolName: state.lastToolPhase.toolName,
          turn: parseRuntimeTurnNumber(frame.turnId),
        },
        emit,
      });
      return;
    }
    if (
      (frame.status === "completed" || frame.status === "skipped") &&
      frame.family === "approval" &&
      state.currentPhase.kind === "waiting_approval"
    ) {
      emitRuntimeSessionPhase({
        state,
        phase: state.lastToolPhase ?? state.lastModelPhase ?? modelStreamingPhase(frame),
        emit,
      });
      return;
    }
    if (
      (frame.status === "completed" || frame.status === "skipped") &&
      (frame.family === "recovery" || frame.family === "output_budget") &&
      state.currentPhase.kind === "recovering"
    ) {
      emitRuntimeSessionPhase({
        state,
        phase: modelStreamingPhase(frame),
        emit,
      });
      return;
    }
    return;
  }
  if (frame.type === "attempt.started") {
    emitRuntimeSessionPhase({
      state,
      phase: modelStreamingPhase(frame),
      emit,
    });
    return;
  }
  if (frame.type === "session.closed") {
    finishRuntimeTurnAssistantSegment(input);
    emitRuntimeSessionPhase({
      state,
      phase: { kind: "terminated", reason: "host_closed" },
      emit,
    });
    return;
  }
  if (frame.type === "turn.committed") {
    finishRuntimeTurnAssistantSegment(input);
    if (!state.emittedAssistantMessage && frame.assistantText.trim().length > 0) {
      state.emittedAssistantMessage = true;
      input.emit({
        type: "message_end",
        message: buildAssistantTextMessage(frame.assistantText),
      });
    }
    emitRuntimeSessionPhase({
      state,
      phase: { kind: "idle" },
      emit,
    });
  }
}

export function projectRuntimeTurnSessionWireFrames(
  frames: readonly SessionWireFrame[],
): BrewvaPromptSessionEvent[] {
  const events: BrewvaPromptSessionEvent[] = [];
  const state = createRuntimeTurnSessionProjectionState();
  for (const frame of frames) {
    emitRuntimeTurnSessionFrame({
      frame,
      state,
      emit(event) {
        events.push(event);
      },
    });
  }
  return events;
}

export function createSessionViewPort(bundle: CliShellSessionBundle): SessionViewPort {
  const localListeners = new Set<SessionViewPortListener>();
  const liveSessionWireFrames = createLiveSessionWireFrameStore();
  const cockpitWireFold = createShellCockpitWireFoldStore();
  const durableSessionWire = createDurableSessionWireReader(bundle);
  let projectionMode: SessionProjectionMode = "legacySessionEvents";
  const emitLocalSessionEvent = (event: BrewvaPromptSessionEvent): void => {
    for (const listener of localListeners) {
      listener(event);
    }
  };
  const fallbackPresetState = (): BrewvaModelPresetState => ({
    activeName: "Default",
    defaultName: "Default",
    presets: [{ name: "Default", roles: {}, synthetic: true }],
  });
  return {
    session: bundle.session,
    getProjectionMode() {
      return projectionMode;
    },
    getSessionId() {
      return bundle.session.sessionManager.getSessionId();
    },
    getLineageStatus() {
      return readLineageStatus(bundle);
    },
    getLineageTree() {
      return getCliRuntimeLineageTree(bundle.runtime, bundle.session.sessionManager.getSessionId());
    },
    resolveLineageLeafEntryId(lineageNodeId) {
      return readTreeSessionManager(bundle).resolveLineageLeafEntryId(lineageNodeId);
    },
    async checkoutLineageNode(input) {
      const sessionManager = readTreeSessionManager(bundle);
      const sessionId = sessionManager.getSessionId();
      const previousLineageNodeId = readSessionManagerLineageNodeId(sessionManager);
      const previousLeafEntryId = readSessionManagerLeafEntryId(sessionManager);
      sessionManager.checkoutLineageNode(input.lineageNodeId, input.leafEntryId);
      try {
        await replaceSessionMessagesFromCurrentContext(bundle);
      } catch (error) {
        if (previousLineageNodeId) {
          try {
            sessionManager.checkoutLineageNode(previousLineageNodeId, previousLeafEntryId);
          } catch {
            // Preserve the transcript replacement failure; rollback is best-effort controller state.
          }
        }
        throw error;
      }
      recordCliRuntimeLineageSelection(bundle.runtime, sessionId, {
        selectionId: `cli:${randomUUID()}`,
        channelId: input.channelId ?? "cli",
        lineageNodeId: input.lineageNodeId,
        previousLineageNodeId,
        reason: input.reason ?? "cli_checkout",
      });
      return readLineageStatus(bundle);
    },
    getTreeProjection() {
      return buildTreeProjection(bundle);
    },
    async checkoutTreeEntry(input) {
      return await checkoutTreeEntryInSession(bundle, input);
    },
    resolveTreeRewindTarget(entryId) {
      return resolveTreeRewindTargetForProjection(bundle, buildTreeProjection(bundle), entryId);
    },
    getModelLabel() {
      return bundle.session.model?.provider && bundle.session.model?.id
        ? `${bundle.session.model.provider}/${bundle.session.model.id}`
        : "unresolved-model";
    },
    getThinkingLevel() {
      return bundle.session.thinkingLevel ?? "off";
    },
    async listModels(options) {
      const fallback = bundle.session.model ? [bundle.session.model] : [];
      if (options?.includeUnavailable) {
        return bundle.session.modelRegistry?.getAll?.() ?? fallback;
      }
      return [
        ...(await Promise.resolve(bundle.session.modelRegistry?.getAvailable?.() ?? fallback)),
      ];
    },
    async setModel(model) {
      if (typeof bundle.session.setModel !== "function") {
        throw new Error("This session does not support model switching.");
      }
      await bundle.session.setModel(model);
    },
    getModelPresetState() {
      return bundle.session.getModelPresetState?.() ?? fallbackPresetState();
    },
    async selectNextModelPreset(options) {
      const state = bundle.session.getModelPresetState?.() ?? fallbackPresetState();
      if (state.presets.length <= 1) {
        return {
          selectedName: state.activeName,
          previousName: state.activeName,
          modelChanged: false,
          queued: false,
          effectiveDefaultModel: state.presets[0]?.roles.default,
        };
      }
      const nextName = selectNextModelPresetName(
        options?.queueOnly ? state : { ...state, pendingName: undefined },
      );
      if (options?.queueOnly) {
        if (typeof bundle.session.queueModelPresetForNextTurn !== "function") {
          throw new Error("This session does not support model preset selection.");
        }
        return bundle.session.queueModelPresetForNextTurn(nextName);
      }
      if (typeof bundle.session.selectModelPreset !== "function") {
        throw new Error("This session does not support model preset selection.");
      }
      return bundle.session.selectModelPreset({ name: nextName, source: "tui" });
    },
    getAvailableThinkingLevels() {
      return (
        bundle.session.getAvailableThinkingLevels?.() ?? [bundle.session.thinkingLevel ?? "off"]
      );
    },
    setThinkingLevel(level) {
      if (typeof bundle.session.setThinkingLevel !== "function") {
        throw new Error("This session does not support thinking-level selection.");
      }
      bundle.session.setThinkingLevel(level as BrewvaPromptThinkingLevel);
    },
    getModelPreferences() {
      return (
        bundle.session.settingsManager?.getModelPreferences?.() ?? {
          recent: [],
          favorite: [],
        }
      );
    },
    setModelPreferences(preferences) {
      bundle.session.settingsManager?.setModelPreferences?.(preferences);
    },
    getDiffPreferences() {
      return (
        bundle.session.settingsManager?.getDiffPreferences?.() ?? {
          style: "auto",
          wrapMode: "word",
        }
      );
    },
    setDiffPreferences(preferences) {
      bundle.session.settingsManager?.setDiffPreferences?.(preferences);
    },
    getShellViewPreferences() {
      return (
        bundle.session.settingsManager?.getShellViewPreferences?.() ?? {
          showThinking: true,
          toolDetails: true,
        }
      );
    },
    setShellViewPreferences(preferences) {
      bundle.session.settingsManager?.setShellViewPreferences?.(preferences);
    },
    async prompt(parts, options) {
      if (
        bundle.session.isStreaming ||
        options?.streamingBehavior ||
        options?.source !== "interactive"
      ) {
        projectionMode = "legacySessionEvents";
        await bundle.session.prompt(parts, options);
        return;
      }
      projectionMode = "wireFold";
      const projectionState = createRuntimeTurnSessionProjectionState();
      const output = await runHostedPromptTurn({
        session: bundle.session,
        parts,
        source: "interactive",
        runtime: bundle.runtime,
        sessionId: bundle.session.sessionManager.getSessionId(),
        onFrame(frame) {
          liveSessionWireFrames.remember(frame);
          cockpitWireFold.remember(frame);
          emitRuntimeTurnSessionFrame({
            frame,
            state: projectionState,
            emit: emitLocalSessionEvent,
          });
        },
      });
      finishRuntimeTurnAssistantSegment({
        state: projectionState,
        emit: emitLocalSessionEvent,
      });
      if (
        output.status === "completed" &&
        !projectionState.emittedAssistantMessage &&
        output.assistantText.trim().length > 0
      ) {
        emitLocalSessionEvent({
          type: "message_end",
          message: buildAssistantTextMessage(output.assistantText),
        });
      }
      if (output.status !== "suspended") {
        emitRuntimeSessionPhase({
          state: projectionState,
          phase: { kind: "idle" },
          emit: emitLocalSessionEvent,
        });
      }
      if (output.status === "failed") {
        throw output.error instanceof Error ? output.error : new Error(String(output.error));
      }
    },
    getQueuedPrompts() {
      return bundle.session.getQueuedPrompts();
    },
    removeQueuedPrompt(promptId) {
      return bundle.session.removeQueuedPrompt(promptId);
    },
    steer(text, options) {
      return bundle.session.steer(text, options);
    },
    waitForIdle() {
      return bundle.session.waitForIdle();
    },
    abort() {
      return bundle.session.abort();
    },
    subscribe(listener) {
      localListeners.add(listener);
      let unsubscribeSession: () => void;
      try {
        unsubscribeSession = bundle.session.subscribe(listener);
      } catch (error) {
        localListeners.delete(listener);
        throw error;
      }
      return () => {
        localListeners.delete(listener);
        unsubscribeSession();
      };
    },
    getSessionWireFrames(
      targetSessionId = bundle.session.sessionManager.getSessionId(),
      options?: SessionWireFrameReadOptions,
    ) {
      return mergedSessionWireFrames({
        durableFrames: durableSessionWire.read(targetSessionId, options),
        liveFrames: liveSessionWireFrames.values(),
        sessionId: targetSessionId,
      });
    },
    getCockpitWireFoldSnapshot(
      targetSessionId = bundle.session.sessionManager.getSessionId(),
      options?: SessionWireFrameReadOptions,
    ) {
      if (options?.refreshDurable ?? true) {
        cockpitWireFold.hydrateSession(
          targetSessionId,
          durableSessionWire.read(targetSessionId, options),
        );
      }
      return cockpitWireFold.snapshot(targetSessionId);
    },
    getTranscriptSeed() {
      const messages = bundle.session.sessionManager.buildSessionContext?.().messages;
      if (Array.isArray(messages) && messages.length > 0) {
        return messages;
      }
      try {
        const sessionId = bundle.session.sessionManager.getSessionId();
        return buildSessionWireTranscriptSeedMessages(
          mergedSessionWireFrames({
            durableFrames: durableSessionWire.read(sessionId, { refreshDurable: true }),
            liveFrames: liveSessionWireFrames.values(),
            sessionId,
          }),
        );
      } catch {
        return [];
      }
    },
    async recordRewindCheckpoint(input) {
      await ensureSessionInitialPersistence(bundle.session);
      recordCliRuntimeRewindCheckpoint(
        bundle.runtime,
        bundle.session.sessionManager.getSessionId(),
        {
          ...input,
          leafEntryId: input.leafEntryId ?? bundle.session.sessionManager.getLeafId?.() ?? null,
        },
      );
    },
    rollbackLastPatchSet() {
      const sessionId = bundle.session.sessionManager.getSessionId();
      return bundle.runtime.capabilities.tools.patches.rollbackLastPatchSet(sessionId);
    },
    async rewindSession(input) {
      const sessionId = bundle.session.sessionManager.getSessionId();
      const returnLeafEntryId =
        input?.returnLeafEntryId ?? bundle.session.sessionManager.getLeafId?.() ?? null;
      if (typeof bundle.session.replaceMessages !== "function") {
        throw new Error("Session rewind requires session.replaceMessages().");
      }
      const result = rewindCliRuntimeSession(bundle.runtime, sessionId, {
        ...input,
        returnLeafEntryId,
      });
      if (!result.ok) {
        return result;
      }
      if (result.reasoningRevert) {
        const sessionManager = bundle.session.sessionManager;
        if (result.summary === "carry") {
          if (typeof sessionManager.branchWithSummary !== "function") {
            throw new Error(
              "Session rewind with summary requires sessionManager.branchWithSummary().",
            );
          }
          sessionManager.branchWithSummary(
            result.reasoningRevert.targetLeafEntryId,
            result.reasoningRevert.continuityPacket.text,
            buildReasoningRevertSummaryDetails(result.reasoningRevert),
            true,
          );
        } else if (result.reasoningRevert.targetLeafEntryId) {
          if (typeof sessionManager.branch !== "function") {
            throw new Error("Session rewind requires sessionManager.branch() for clean rewind.");
          }
          sessionManager.branch(result.reasoningRevert.targetLeafEntryId);
        } else {
          if (typeof sessionManager.resetLeaf !== "function") {
            throw new Error("Session rewind to root requires sessionManager.resetLeaf().");
          }
          sessionManager.resetLeaf();
        }
      }
      if (result.divergenceNote) {
        appendRewindDivergenceSummary(bundle, result.divergenceNote, returnLeafEntryId);
      }
      await replaceSessionMessagesFromCurrentContext(bundle);
      return result;
    },
    async redoSession(input) {
      const sessionId = bundle.session.sessionManager.getSessionId();
      if (typeof bundle.session.replaceMessages !== "function") {
        throw new Error("Session redo requires session.replaceMessages().");
      }
      const result = redoCliRuntimeSession(bundle.runtime, sessionId, input);
      if (!result.ok) {
        return result;
      }
      if (result.reasoningCheckpoint) {
        const sessionManager = bundle.session.sessionManager;
        if (result.returnLeafEntryId) {
          if (typeof sessionManager.branch !== "function") {
            throw new Error("Session redo requires sessionManager.branch().");
          }
          sessionManager.branch(result.returnLeafEntryId);
        } else {
          if (typeof sessionManager.resetLeaf !== "function") {
            throw new Error("Session redo to root requires sessionManager.resetLeaf().");
          }
          sessionManager.resetLeaf();
        }
      }
      await replaceSessionMessagesFromCurrentContext(bundle);
      return result;
    },
    getRewindState() {
      return getCliRuntimeRewindState(bundle.runtime, bundle.session.sessionManager.getSessionId());
    },
    listRewindTargets() {
      return listCliRuntimeRewindTargets(
        bundle.runtime,
        bundle.session.sessionManager.getSessionId(),
      );
    },
  };
}
