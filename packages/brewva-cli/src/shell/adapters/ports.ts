import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  buildOperatorQuestionAnswerPrompt,
  buildOperatorQuestionRequestAnswerPrompt,
  buildOperatorQuestionAnsweredPayload,
  collectOpenSessionQuestions,
  flattenQuestionRequest,
  resolveOpenSessionQuestion,
  resolveOpenSessionQuestionRequest,
  validateQuestionRequestAnswers,
  validateSingleQuestionAnswer,
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
  async function deliverOperatorPrompt(inputValue: {
    bundle: CliShellSessionBundle;
    sessionId: string;
    prompt: string;
  }): Promise<void> {
    if (inputValue.bundle.session.isStreaming) {
      await inputValue.bundle.session.prompt([{ type: "text", text: inputValue.prompt }], {
        source: "interactive",
        streamingBehavior: "followUp",
      });
      return;
    }
    const output = await runHostedPromptTurn({
      session: inputValue.bundle.session,
      parts: [{ type: "text", text: inputValue.prompt }],
      source: "interactive",
      runtime: inputValue.bundle.runtime,
      sessionId: inputValue.sessionId,
    });
    if (output.status === "failed") {
      throw output.error instanceof Error ? output.error : new Error(String(output.error));
    }
  }

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
      const validatedAnswer = validateSingleQuestionAnswer({ question, answerText });
      if (!validatedAnswer.ok) {
        throw new Error(validatedAnswer.error);
      }
      const prompt = buildOperatorQuestionAnswerPrompt({
        question,
        answerText: validatedAnswer.answerText,
      });
      await deliverOperatorPrompt({ bundle, sessionId, prompt });
      recordRuntimeEvent(bundle.runtime, {
        sessionId,
        type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
        payload: buildOperatorQuestionAnsweredPayload({
          question,
          answerText: validatedAnswer.answerText,
          source: "runtime_plugin",
        }),
      });
    },
    async answerQuestionRequest(requestId, answers) {
      const bundle = input.getBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      const request = await resolveOpenSessionQuestionRequest(bundle.runtime, sessionId, requestId);
      if (!request) {
        throw new Error(`question_request_not_found:${requestId}`);
      }
      const validatedAnswers = validateQuestionRequestAnswers({ request, answers });
      if (!validatedAnswers.ok) {
        throw new Error(validatedAnswers.error);
      }
      const prompt = buildOperatorQuestionRequestAnswerPrompt({
        request,
        answers: validatedAnswers.answers,
      });
      await deliverOperatorPrompt({ bundle, sessionId, prompt });
      const flatQuestions = flattenQuestionRequest(request);
      for (const [index, question] of flatQuestions.entries()) {
        const answerText = validatedAnswers.answers[index]?.join(", ");
        if (!answerText) {
          continue;
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
      }
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
