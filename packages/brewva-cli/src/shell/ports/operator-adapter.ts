import {
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
import { runHostedPromptTurn } from "@brewva/brewva-gateway/hosted";
import {
  decideCliRuntimeProposalRequest,
  listCliRuntimePendingProposalRequests,
  listCliRuntimeProposalRequests,
  listCliRuntimeReplaySessions,
} from "../../runtime/runtime-ports.js";
import type { OperatorSurfacePort } from "./operator-port.js";
import type { CliShellSessionBundle } from "./session-port.js";

const MAX_APPROVAL_RESOLUTION_ATTEMPTS = 3;

function resolveApprovalTurnId(input: {
  turnId?: string;
  proposalId?: string;
}): string | undefined {
  if (input.turnId) {
    return input.turnId;
  }
  const parts = input.proposalId?.split(":");
  if (parts?.length === 4 && parts[0] === "tool" && parts[2]) {
    return decodeURIComponent(parts[2]);
  }
  return undefined;
}

async function resolveApprovalRequest(input: {
  bundle: CliShellSessionBundle;
  sessionId: string;
  requestId: string;
  turnId?: string;
}): Promise<void> {
  if (!input.turnId) {
    return;
  }
  const output = await runHostedPromptTurn({
    session: input.bundle.session,
    parts: [],
    source: "interactive",
    runtime: input.bundle.runtime,
    sessionId: input.sessionId,
    turnId: input.turnId,
    resolveApproval: { requestId: input.requestId },
  });
  if (output.status === "failed") {
    throw output.error instanceof Error ? output.error : new Error(String(output.error));
  }
  if (output.status === "suspended") {
    throw new Error(`approval_resolution_suspended:${input.requestId}`);
  }
}

export function createOperatorSurfacePort(input: {
  getSessionBundle(): CliShellSessionBundle;
  openSession(sessionId: string): Promise<CliShellSessionBundle>;
  createSession(): Promise<CliShellSessionBundle>;
}): OperatorSurfacePort {
  const approvalResolutionAttempts = new Map<string, number>();
  const activeApprovalResolutions = new Map<string, Promise<void>>();

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

  function scheduleApprovalResolution(inputValue: {
    bundle: CliShellSessionBundle;
    sessionId: string;
    requestId: string;
    turnId?: string;
  }): void {
    if (!inputValue.turnId || activeApprovalResolutions.has(inputValue.requestId)) {
      return;
    }
    const attempts = approvalResolutionAttempts.get(inputValue.requestId) ?? 0;
    if (attempts >= MAX_APPROVAL_RESOLUTION_ATTEMPTS) {
      return;
    }
    approvalResolutionAttempts.set(inputValue.requestId, attempts + 1);
    const task = resolveApprovalRequest(inputValue).finally(() => {
      activeApprovalResolutions.delete(inputValue.requestId);
    });
    activeApprovalResolutions.set(inputValue.requestId, task);
    void task.catch(() => undefined);
  }

  function scheduleAcceptedApprovalRecovery(inputValue: {
    bundle: CliShellSessionBundle;
    sessionId: string;
  }): void {
    const accepted = listCliRuntimeProposalRequests(
      inputValue.bundle.runtime,
      inputValue.sessionId,
      {
        state: "accepted",
      },
    );
    for (const request of accepted) {
      const turnId = resolveApprovalTurnId({
        turnId: request.turnId,
        proposalId: request.proposalId,
      });
      scheduleApprovalResolution({
        bundle: inputValue.bundle,
        sessionId: inputValue.sessionId,
        requestId: request.requestId,
        turnId,
      });
    }
  }

  return {
    async getSnapshot() {
      const bundle = input.getSessionBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      const approvals = listCliRuntimePendingProposalRequests(bundle.runtime, sessionId);
      const questions = (await collectOpenSessionQuestions(bundle.runtime, sessionId)).questions;
      const taskStatus = await bundle.orchestration?.subagents?.status?.({
        fromSessionId: sessionId,
        query: {
          includeTerminal: true,
          limit: 20,
        },
      });
      const taskRuns = taskStatus?.ok ? taskStatus.runs : [];
      const sessions = listCliRuntimeReplaySessions(bundle.runtime, 20);
      return { approvals, questions, taskRuns, sessions };
    },
    async recoverAcceptedApprovals() {
      const bundle = input.getSessionBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      scheduleAcceptedApprovalRecovery({ bundle, sessionId });
    },
    async decideApproval(requestId, inputDecision) {
      const bundle = input.getSessionBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      const request = listCliRuntimePendingProposalRequests(bundle.runtime, sessionId).find(
        (entry) => entry.requestId === requestId,
      );
      decideCliRuntimeProposalRequest(bundle.runtime, sessionId, requestId, inputDecision);
      const turnId = resolveApprovalTurnId({
        turnId: request?.turnId,
        proposalId: request?.proposalId,
      });
      scheduleApprovalResolution({
        bundle,
        sessionId,
        requestId,
        turnId,
      });
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
      bundle.runtime.ops.tools.operatorQuestions.answerRecorded({
        sessionId,
        payload: buildOperatorQuestionAnsweredPayload({
          question,
          answerText: validatedAnswer.answerText,
          source: "hosted",
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
        bundle.runtime.ops.tools.operatorQuestions.answerRecorded({
          sessionId,
          payload: buildOperatorQuestionAnsweredPayload({
            question,
            answerText,
            source: "hosted",
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
