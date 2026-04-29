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
import {
  SESSION_REWIND_DIVERGENCE_SCHEMA,
  buildReasoningRevertSummaryDetails,
  type SessionRewindDivergenceNote,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { BrewvaPromptThinkingLevel } from "@brewva/brewva-substrate";
import type {
  CliShellSessionBundle,
  OperatorSurfacePort,
  SessionViewPort,
  ShellConfigPort,
} from "../types.js";
export { createCliShellPromptStore } from "../prompt-store.js";

function buildDivergenceSummaryDetails(note: SessionRewindDivergenceNote): Record<string, unknown> {
  return {
    schema: SESSION_REWIND_DIVERGENCE_SCHEMA,
    kind: note.kind,
    patchSetCount: note.patchSetCount,
    parentLeafEntryId: note.parentLeafEntryId,
  };
}

function replaceSessionMessagesFromCurrentContext(bundle: CliShellSessionBundle): void {
  const context = bundle.session.sessionManager.buildSessionContext?.();
  if (!context || !Array.isArray(context.messages)) {
    throw new Error("Session rewind requires sessionManager.buildSessionContext().");
  }
  if (typeof bundle.session.replaceMessages !== "function") {
    throw new Error("Session rewind requires session.replaceMessages().");
  }
  bundle.session.replaceMessages(context.messages);
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
      return bundle.session.subscribe(listener);
    },
    getTranscriptSeed() {
      const messages = bundle.session.sessionManager.buildSessionContext?.().messages;
      return Array.isArray(messages) ? messages : [];
    },
    recordRewindCheckpoint(input) {
      bundle.runtime.authority.session.recordRewindCheckpoint(
        bundle.session.sessionManager.getSessionId(),
        {
          ...input,
          leafEntryId: input.leafEntryId ?? bundle.session.sessionManager.getLeafId?.() ?? null,
        },
      );
    },
    rewindSession(input) {
      const sessionId = bundle.session.sessionManager.getSessionId();
      const returnLeafEntryId =
        input?.returnLeafEntryId ?? bundle.session.sessionManager.getLeafId?.() ?? null;
      if (typeof bundle.session.replaceMessages !== "function") {
        throw new Error("Session rewind requires session.replaceMessages().");
      }
      const result = bundle.runtime.authority.session.rewind(sessionId, {
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
      replaceSessionMessagesFromCurrentContext(bundle);
      return result;
    },
    redoSession(input) {
      const sessionId = bundle.session.sessionManager.getSessionId();
      if (typeof bundle.session.replaceMessages !== "function") {
        throw new Error("Session redo requires session.replaceMessages().");
      }
      const result = bundle.runtime.authority.session.redo(sessionId, input);
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
      replaceSessionMessagesFromCurrentContext(bundle);
      return result;
    },
    getRewindState() {
      return bundle.runtime.inspect.session.getRewindState(
        bundle.session.sessionManager.getSessionId(),
      );
    },
    listRewindTargets() {
      return bundle.runtime.inspect.session.listRewindTargets(
        bundle.session.sessionManager.getSessionId(),
      );
    },
  };
}

export function createOperatorSurfacePort(input: {
  getSessionBundle(): CliShellSessionBundle;
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
      const bundle = input.getSessionBundle();
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
      const bundle = input.getSessionBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      bundle.runtime.authority.proposals.decideEffectCommitment(
        sessionId,
        requestId,
        inputDecision,
      );
    },
    async answerQuestion(questionId, answerText) {
      const bundle = input.getSessionBundle();
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
      const bundle = input.getSessionBundle();
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
      const bundle = input.getSessionBundle();
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

export function createShellConfigPort(): ShellConfigPort {
  return {
    getEditorCommand() {
      return process.env.VISUAL ?? process.env.EDITOR;
    },
  };
}
