import { randomUUID } from "node:crypto";
import { runHostedPromptTurn, selectNextModelPresetName } from "@brewva/brewva-gateway/hosted";
import { buildReasoningRevertSummaryDetails } from "@brewva/brewva-runtime/protocol";
import { SESSION_REWIND_DIVERGENCE_SCHEMA } from "@brewva/brewva-runtime/protocol";
import type {
  SessionRewindDivergenceNote,
  SessionWireFrame,
} from "@brewva/brewva-runtime/protocol";
import type {
  BrewvaPromptAssistantMessageEvent,
  BrewvaPromptSessionEvent,
  BrewvaModelPresetState,
  BrewvaPromptThinkingLevel,
} from "@brewva/brewva-substrate/session";
import {
  getCliRuntimeLineageTree,
  getCliRuntimeRewindState,
  listCliRuntimeRewindTargets,
  recordCliRuntimeLineageSelection,
  recordCliRuntimeRewindCheckpoint,
  redoCliRuntimeSession,
  rewindCliRuntimeSession,
} from "../../runtime/runtime-ports.js";
import type {
  CliShellSessionBundle,
  SessionLineageStatusView,
  SessionViewPort,
} from "./session-port.js";
export { createCliShellPromptStore } from "../domain/prompt-store.js";

function readSessionManagerLineageNodeId(sessionManager: unknown): string | null {
  const getLineageNodeId = (sessionManager as { getLineageNodeId?: unknown } | null | undefined)
    ?.getLineageNodeId;
  if (typeof getLineageNodeId !== "function") {
    return null;
  }
  const value = getLineageNodeId.call(sessionManager);
  return typeof value === "string" && value.trim() ? value : null;
}

function readSessionManagerLeafEntryId(sessionManager: unknown): string | null {
  const getLeafId = (sessionManager as { getLeafId?: unknown } | null | undefined)?.getLeafId;
  if (typeof getLeafId !== "function") {
    return null;
  }
  const value = getLeafId.call(sessionManager);
  return typeof value === "string" && value.trim() ? value : null;
}

function readSessionManagerCheckoutLineageNode(
  sessionManager: unknown,
): ((lineageNodeId: string, leafEntryId?: string | null) => void) | undefined {
  const checkoutLineageNode = (
    sessionManager as { checkoutLineageNode?: unknown } | null | undefined
  )?.checkoutLineageNode;
  return typeof checkoutLineageNode === "function"
    ? checkoutLineageNode.bind(sessionManager)
    : undefined;
}

function readSessionManagerResolveLineageLeafEntryId(
  sessionManager: unknown,
): ((lineageNodeId: string) => string | null) | undefined {
  const resolveLineageLeafEntryId = (
    sessionManager as { resolveLineageLeafEntryId?: unknown } | null | undefined
  )?.resolveLineageLeafEntryId;
  return typeof resolveLineageLeafEntryId === "function"
    ? resolveLineageLeafEntryId.bind(sessionManager)
    : undefined;
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
  const sessionId = bundle.session.sessionManager.getSessionId();
  try {
    const tree = getCliRuntimeLineageTree(bundle.runtime, sessionId);
    const lineageNodeId =
      readSessionManagerLineageNodeId(bundle.session.sessionManager) ??
      tree.selectedByChannel["cli"] ??
      tree.rootNodeId;
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

interface RuntimeTurnSessionProjectionState {
  assistantText: string;
  projectedAssistantEnd: boolean;
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

function buildRuntimeToolResultPayload(frame: RuntimeToolSessionWireFrame): {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: { readonly verdict: string };
  readonly display?: RuntimeToolSessionWireFrame["display"];
  readonly isError: boolean;
} {
  return {
    content: frame.text.length > 0 ? [{ type: "text", text: frame.text }] : [],
    details: { verdict: frame.verdict },
    ...(frame.display ? { display: frame.display } : {}),
    isError: frame.isError,
  };
}

function emitRuntimeTurnSessionFrame(input: {
  frame: SessionWireFrame;
  state: RuntimeTurnSessionProjectionState;
  emit(event: BrewvaPromptSessionEvent): void;
}): void {
  const frame = input.frame;
  const state = input.state;
  if (frame.type === "assistant.delta" && frame.lane === "answer" && frame.delta.length > 0) {
    state.assistantText += frame.delta;
    input.emit(
      buildAssistantDeltaEvent({ delta: frame.delta, assistantText: state.assistantText }),
    );
    return;
  }
  if (frame.type === "tool.started") {
    input.emit({
      type: "tool_execution_start",
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
    });
    return;
  }
  if (frame.type === "tool.progress") {
    input.emit({
      type: "tool_execution_update",
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
      partialResult: buildRuntimeToolResultPayload(frame),
    });
    return;
  }
  if (frame.type === "tool.finished") {
    input.emit({
      type: "tool_execution_end",
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
      result: buildRuntimeToolResultPayload(frame),
      isError: frame.isError,
    });
    return;
  }
  if (frame.type === "turn.committed" && frame.assistantText.length > 0) {
    input.emit({
      type: "message_end",
      message: buildAssistantTextMessage(frame.assistantText),
    });
    state.projectedAssistantEnd = true;
  }
}

export function createSessionViewPort(bundle: CliShellSessionBundle): SessionViewPort {
  const localListeners = new Set<SessionViewPortListener>();
  const emitLocalSessionEvent = (event: BrewvaPromptSessionEvent): void => {
    for (const listener of localListeners) {
      listener(event);
    }
  };
  const fallbackPresetState = (): BrewvaModelPresetState => ({
    activeName: "Default",
    defaultName: "Default",
    presets: [{ name: "Default", delegationModels: {}, synthetic: true }],
  });
  return {
    session: bundle.session,
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
      const resolveLineageLeafEntryId = readSessionManagerResolveLineageLeafEntryId(
        bundle.session.sessionManager,
      );
      if (!resolveLineageLeafEntryId) {
        throw new Error(
          "Session lineage overlay requires sessionManager.resolveLineageLeafEntryId().",
        );
      }
      return resolveLineageLeafEntryId(lineageNodeId);
    },
    async checkoutLineageNode(input) {
      const sessionId = bundle.session.sessionManager.getSessionId();
      const previousLineageNodeId = readSessionManagerLineageNodeId(bundle.session.sessionManager);
      const previousLeafEntryId = readSessionManagerLeafEntryId(bundle.session.sessionManager);
      const checkoutLineageNode = readSessionManagerCheckoutLineageNode(
        bundle.session.sessionManager,
      );
      if (!checkoutLineageNode) {
        throw new Error("Session lineage checkout requires sessionManager.checkoutLineageNode().");
      }
      checkoutLineageNode(input.lineageNodeId, input.leafEntryId);
      try {
        await replaceSessionMessagesFromCurrentContext(bundle);
      } catch (error) {
        if (previousLineageNodeId) {
          try {
            checkoutLineageNode(previousLineageNodeId, previousLeafEntryId);
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
        ...(previousLineageNodeId ? { previousLineageNodeId } : {}),
        reason: input.reason ?? "cli_checkout",
      });
      return readLineageStatus(bundle);
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
          effectiveMainModel: state.presets[0]?.mainModel,
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
        await bundle.session.prompt(parts, options);
        return;
      }
      const projectionState: RuntimeTurnSessionProjectionState = {
        assistantText: "",
        projectedAssistantEnd: false,
      };
      const output = await runHostedPromptTurn({
        session: bundle.session,
        parts,
        source: "interactive",
        runtime: bundle.runtime,
        sessionId: bundle.session.sessionManager.getSessionId(),
        onFrame(frame) {
          emitRuntimeTurnSessionFrame({
            frame,
            state: projectionState,
            emit: emitLocalSessionEvent,
          });
        },
      });
      if (output.status === "failed") {
        throw output.error instanceof Error ? output.error : new Error(String(output.error));
      }
      if (
        output.status === "completed" &&
        !projectionState.projectedAssistantEnd &&
        output.assistantText.length > 0
      ) {
        emitLocalSessionEvent({
          type: "message_end",
          message: buildAssistantTextMessage(output.assistantText),
        });
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
    getTranscriptSeed() {
      const messages = bundle.session.sessionManager.buildSessionContext?.().messages;
      return Array.isArray(messages) ? messages : [];
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
