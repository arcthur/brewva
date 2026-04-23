import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  buildOperatorQuestionAnswerPrompt,
  buildOperatorQuestionAnsweredPayload,
  collectOpenSessionQuestions,
  resolveOpenSessionQuestion,
} from "@brewva/brewva-gateway";
import { runHostedPromptTurn } from "@brewva/brewva-gateway/host";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { BrewvaPromptThinkingLevel } from "@brewva/brewva-substrate";
import type {
  CliShellSessionBundle,
  OperatorSurfacePort,
  SessionViewPort,
  ShellConfigPort,
  WorkspaceCompletionPort,
} from "../types.js";
export { createCliShellPromptStore } from "../prompt-store.js";

const SLASH_COMMANDS = [
  {
    command: "inspect",
    description: "Replay-first inspect report for the current session.",
    argumentMode: "none",
  },
  {
    command: "undo",
    description: "Undo the last submitted turn and restore its prompt.",
    argumentMode: "none",
  },
  {
    command: "redo",
    description: "Redo the last undone turn.",
    argumentMode: "none",
  },
  {
    command: "models",
    description: "Select a model for the current session.",
    argumentMode: "optional",
  },
  {
    command: "connect",
    description: "Connect a model provider.",
    argumentMode: "optional",
  },
  {
    command: "think",
    description: "Select the model thinking level for future turns.",
    argumentMode: "none",
  },
  {
    command: "thinking",
    description: "Show or hide reasoning blocks in the transcript.",
    argumentMode: "none",
  },
  {
    command: "tool-details",
    description: "Show or hide completed tool details in the transcript.",
    argumentMode: "none",
  },
  {
    command: "diffwrap",
    description: "Toggle wrapping in diff views.",
    argumentMode: "none",
  },
  {
    command: "diffstyle",
    description: "Toggle automatic split diffs and stacked unified diffs.",
    argumentMode: "none",
  },
  {
    command: "insights",
    description: "Workspace-level insights without entering a model turn.",
    argumentMode: "optional",
  },
  {
    command: "sessions",
    description: "Browse and switch replay sessions.",
    argumentMode: "none",
  },
  {
    command: "approvals",
    description: "Review queued approval requests.",
    argumentMode: "none",
  },
  {
    command: "tasks",
    description: "Inspect background task runs.",
    argumentMode: "none",
  },
  {
    command: "notifications",
    description: "Open the operator notification inbox.",
    argumentMode: "none",
  },
  {
    command: "questions",
    description: "List unresolved operator questions.",
    argumentMode: "none",
  },
  {
    command: "theme",
    description: "List or switch interactive shell themes.",
    argumentMode: "optional",
  },
  {
    command: "answer",
    description: "Answer a queued operator question.",
    argumentMode: "required",
  },
  {
    command: "agent-overlays",
    description: "Inspect authored agent overlays.",
    argumentMode: "optional",
  },
  {
    command: "update",
    description: "Queue Brewva update workflow.",
    argumentMode: "none",
  },
  {
    command: "new",
    description: "Create a new interactive session.",
    argumentMode: "none",
  },
  {
    command: "stash",
    description: "Browse stashed prompt drafts.",
    argumentMode: "optional",
  },
  {
    command: "unstash",
    description: "Restore the latest stashed prompt.",
    argumentMode: "none",
  },
  {
    command: "quit",
    description: "Exit the interactive shell.",
    argumentMode: "none",
  },
] as const;

function resolvePathBase(cwd: string, prefix: string): { directory: string; search: string } {
  const normalized = prefix.replace(/^@/u, "");
  const resolved = resolve(cwd, normalized);
  const directory =
    normalized.endsWith("/") || normalized.endsWith("\\") ? resolved : dirname(resolved);
  const search =
    normalized.endsWith("/") || normalized.endsWith("\\")
      ? ""
      : resolved.slice(directory.length + 1);
  return { directory, search };
}

function formatPathSuggestion(cwd: string, fullPath: string): string {
  const rel = relative(cwd, fullPath);
  const normalized = rel.length > 0 ? rel : ".";
  return normalized.includes(" ") ? `"${normalized}"` : normalized;
}

function buildReasoningSummaryDetails(input: {
  revertId: string;
  toCheckpointId: string;
  trigger: string;
  linkedRollbackReceiptIds: readonly string[];
}): Record<string, unknown> {
  return {
    schema: "brewva.reasoning.continuity.v1",
    revertId: input.revertId,
    toCheckpointId: input.toCheckpointId,
    trigger: input.trigger,
    linkedRollbackReceiptIds: [...input.linkedRollbackReceiptIds],
  };
}

function replaceSessionMessagesFromCurrentContext(bundle: CliShellSessionBundle): void {
  const context = bundle.session.sessionManager.buildSessionContext?.();
  if (!context || !Array.isArray(context.messages)) {
    throw new Error("Correction undo/redo requires sessionManager.buildSessionContext().");
  }
  if (typeof bundle.session.replaceMessages !== "function") {
    throw new Error("Correction undo/redo requires session.replaceMessages().");
  }
  bundle.session.replaceMessages(context.messages);
}

export function createSessionViewPort(bundle: CliShellSessionBundle): SessionViewPort {
  return {
    session: bundle.session,
    getSessionId() {
      return bundle.session.sessionManager.getSessionId();
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
      const output = await runHostedPromptTurn({
        session: bundle.session,
        parts,
        source: "interactive",
        runtime: bundle.runtime,
        sessionId: bundle.session.sessionManager.getSessionId(),
      });
      if (output.status === "failed") {
        throw output.error instanceof Error ? output.error : new Error(String(output.error));
      }
    },
    waitForIdle() {
      return bundle.session.waitForIdle();
    },
    abort() {
      return bundle.session.abort();
    },
    subscribe(listener) {
      return bundle.session.subscribe(listener);
    },
    getTranscriptSeed() {
      const messages = bundle.session.sessionManager.buildSessionContext?.().messages;
      return Array.isArray(messages) ? messages : [];
    },
    recordCorrectionCheckpoint(input) {
      bundle.runtime.authority.correction.recordCheckpoint(
        bundle.session.sessionManager.getSessionId(),
        {
          ...input,
          leafEntryId: input.leafEntryId ?? bundle.session.sessionManager.getLeafId?.() ?? null,
        },
      );
    },
    undoCorrection() {
      const sessionId = bundle.session.sessionManager.getSessionId();
      const redoLeafEntryId = bundle.session.sessionManager.getLeafId?.() ?? null;
      if (typeof bundle.session.sessionManager.branchWithSummary !== "function") {
        throw new Error("Correction undo requires sessionManager.branchWithSummary().");
      }
      if (typeof bundle.session.replaceMessages !== "function") {
        throw new Error("Correction undo requires session.replaceMessages().");
      }
      const result = bundle.runtime.authority.correction.undo(sessionId, {
        redoLeafEntryId,
      });
      if (!result.ok) {
        return result;
      }
      bundle.session.sessionManager.branchWithSummary(
        result.reasoningRevert.targetLeafEntryId,
        result.reasoningRevert.continuityPacket.text,
        buildReasoningSummaryDetails({
          revertId: result.reasoningRevert.revertId,
          toCheckpointId: result.reasoningRevert.toCheckpointId,
          trigger: result.reasoningRevert.trigger,
          linkedRollbackReceiptIds: result.reasoningRevert.linkedRollbackReceiptIds,
        }),
        true,
      );
      replaceSessionMessagesFromCurrentContext(bundle);
      return result;
    },
    redoCorrection() {
      const sessionId = bundle.session.sessionManager.getSessionId();
      const pendingRedo = bundle.runtime.inspect.correction.getState(sessionId).nextRedoable;
      if (
        pendingRedo?.redoLeafEntryId &&
        typeof bundle.session.sessionManager.branch !== "function"
      ) {
        throw new Error("Correction redo requires sessionManager.branch().");
      }
      if (typeof bundle.session.replaceMessages !== "function") {
        throw new Error("Correction redo requires session.replaceMessages().");
      }
      const result = bundle.runtime.authority.correction.redo(sessionId);
      if (!result.ok) {
        return result;
      }
      if (result.redoLeafEntryId) {
        bundle.session.sessionManager.branch?.(result.redoLeafEntryId);
      }
      replaceSessionMessagesFromCurrentContext(bundle);
      return result;
    },
    getCorrectionState() {
      return bundle.runtime.inspect.correction.getState(
        bundle.session.sessionManager.getSessionId(),
      );
    },
  };
}

export function createOperatorSurfacePort(input: {
  getBundle(): CliShellSessionBundle;
  openSession(sessionId: string): Promise<CliShellSessionBundle>;
  createSession(): Promise<CliShellSessionBundle>;
}): OperatorSurfacePort {
  return {
    async getSnapshot() {
      const bundle = input.getBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      const approvals = bundle.runtime.inspect.proposals.listPendingEffectCommitments(sessionId);
      const questions = (await collectOpenSessionQuestions(bundle.runtime, sessionId)).questions;
      const taskStatus = await bundle.orchestration?.subagents?.status?.({
        fromSessionId: sessionId,
        query: {
          includeTerminal: true,
          limit: 20,
        },
      });
      const taskRuns = taskStatus?.ok ? taskStatus.runs : [];
      const sessions = bundle.runtime.inspect.events.listReplaySessions(20);
      return { approvals, questions, taskRuns, sessions };
    },
    async decideApproval(requestId, inputDecision) {
      const bundle = input.getBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      bundle.runtime.authority.proposals.decideEffectCommitment(
        sessionId,
        requestId,
        inputDecision,
      );
    },
    async answerQuestion(questionId, answerText) {
      const bundle = input.getBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      const question = await resolveOpenSessionQuestion(bundle.runtime, sessionId, questionId);
      if (!question) {
        throw new Error(`question_not_found:${questionId}`);
      }
      const prompt = buildOperatorQuestionAnswerPrompt({ question, answerText });
      if (bundle.session.isStreaming) {
        await bundle.session.prompt([{ type: "text", text: prompt }], {
          source: "interactive",
          streamingBehavior: "followUp",
        });
      } else {
        const output = await runHostedPromptTurn({
          session: bundle.session,
          parts: [{ type: "text", text: prompt }],
          source: "interactive",
          runtime: bundle.runtime,
          sessionId,
        });
        if (output.status === "failed") {
          throw output.error instanceof Error ? output.error : new Error(String(output.error));
        }
      }
      recordRuntimeEvent(bundle.runtime, {
        sessionId,
        type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
        payload: buildOperatorQuestionAnsweredPayload({
          question,
          answerText,
          source: "runtime_plugin",
        }),
      });
    },
    async stopTask(runId) {
      const bundle = input.getBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      const result = await bundle.orchestration?.subagents?.cancel?.({
        fromSessionId: sessionId,
        runId,
        reason: "cli_tui_stop_task",
      });
      if (!result?.ok) {
        throw new Error(result?.error ?? `cancel_failed:${runId}`);
      }
    },
    openSession(sessionId) {
      return input.openSession(sessionId);
    },
    createSession() {
      return input.createSession();
    },
  };
}

export function createWorkspaceCompletionPort(cwd: string): WorkspaceCompletionPort {
  return {
    listSlashCommands() {
      return SLASH_COMMANDS;
    },
    listPaths(prefix) {
      const { directory, search } = resolvePathBase(cwd, prefix);
      try {
        return readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.name.startsWith(search))
          .map((entry) => {
            const isDirectory = entry.isDirectory();
            const suggestion = formatPathSuggestion(cwd, join(directory, entry.name));
            return {
              value: isDirectory ? `${suggestion}/` : suggestion,
              kind: isDirectory ? ("directory" as const) : ("file" as const),
              description: isDirectory ? "directory" : "file",
            };
          })
          .slice(0, 20);
      } catch {
        return [];
      }
    },
  };
}

export function createShellConfigPort(): ShellConfigPort {
  return {
    getEditorCommand() {
      return process.env.VISUAL ?? process.env.EDITOR;
    },
  };
}
