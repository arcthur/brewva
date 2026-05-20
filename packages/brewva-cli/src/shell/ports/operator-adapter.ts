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
  listCliRuntimeReplaySessions,
} from "../../runtime/runtime-ports.js";
import type { OperatorSurfacePort } from "./operator-port.js";
import type { CliShellSessionBundle } from "./session-port.js";

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
    async decideApproval(requestId, inputDecision) {
      const bundle = input.getSessionBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      decideCliRuntimeProposalRequest(bundle.runtime, sessionId, requestId, inputDecision);
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
