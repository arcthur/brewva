import {
  buildOperatorQuestionAnswerPrompt,
  buildOperatorQuestionAnsweredPayload,
  classifyQuestionRequest,
  collectOpenSessionQuestions,
  listOpenQuestionRequests,
  resolveOpenSessionQuestion,
  validateSingleQuestionAnswer,
} from "@brewva/brewva-gateway";
import {
  defineHostedExtensionPlugin,
  type HostedExtensionPlugin,
  type HostedExtensionApi,
} from "@brewva/brewva-gateway/extensions";
import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import { clampText } from "../../operator/inspect-analysis.js";

const MAX_NOTIFICATION_LINES = 28;
const MAX_LINE_CHARS = 220;

function toNotificationMessage(summary: string, text: string): string {
  const rawLines = text.split(/\r?\n/u).map((line) => clampText(line, MAX_LINE_CHARS));
  if (rawLines.length > MAX_NOTIFICATION_LINES) {
    const kept = rawLines.slice(0, Math.max(1, MAX_NOTIFICATION_LINES - 1));
    kept.push(`...[questions truncated: ${rawLines.length - kept.length} more lines]`);
    return [summary, "", ...kept].join("\n");
  }
  return [summary, "", ...rawLines].join("\n");
}

function formatPromptCount(count: number): string {
  return `${count} input prompt${count === 1 ? "" : "s"}`;
}

function formatQuestionsText(input: {
  questions: Awaited<ReturnType<typeof collectOpenSessionQuestions>>["questions"];
  warnings: string[];
}): string {
  const requests = listOpenQuestionRequests(input.questions);
  const inputRequests = requests.filter(
    (request) => classifyQuestionRequest(request) === "input_request",
  );
  const followUpQuestions = requests.filter(
    (request) => classifyQuestionRequest(request) === "follow_up",
  );
  const lines = [
    `Operator inbox: ${requests.length}`,
    `Input requests: ${inputRequests.length} · Follow-up questions: ${followUpQuestions.length}`,
  ];
  if (requests.length === 0) {
    lines.push("No pending operator input.");
  } else {
    if (inputRequests.length > 0) {
      lines.push("Pending input requests:");
      for (const request of inputRequests) {
        lines.push(
          `- [${request.requestId}] ${request.sourceLabel} :: ${formatPromptCount(request.questions.length)}`,
        );
      }
    }
    if (followUpQuestions.length > 0) {
      lines.push("Follow-up questions:");
      for (const request of followUpQuestions) {
        const question = request.questions[0];
        if (!question) {
          continue;
        }
        lines.push(
          `- [${question.questionId}] ${request.sourceLabel} :: ${clampText(question.questionText, 180)}`,
        );
      }
    }
    if (inputRequests.length > 0 && followUpQuestions.length > 0) {
      lines.push(
        "Use /answer <question-id> <answer> for a single follow-up, or open the operator inbox overlay for a full input request.",
      );
    } else if (inputRequests.length > 0) {
      lines.push("Open the operator inbox overlay to resolve the pending input request.");
    } else {
      lines.push("Use /answer <question-id> <answer> to resolve one.");
    }
  }
  if (input.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of input.warnings) {
      lines.push(`- ${clampText(warning, 180)}`);
    }
  }
  return lines.join("\n");
}

function normalizeArgs(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAnswerArgs(
  args: string,
): { questionId: string; answerText: string } | { error: string } {
  const normalized = normalizeArgs(args);
  if (!normalized) {
    return { error: "Usage: /answer <question-id> <answer>" };
  }
  const tokens = normalized.split(/\s+/u);
  const questionId = tokens[0]?.trim();
  const answerText = tokens.slice(1).join(" ").trim();
  if (!questionId || !answerText) {
    return { error: "Usage: /answer <question-id> <answer>" };
  }
  return { questionId, answerText };
}

export function createQuestionsCommandExtension(
  runtime: HostedRuntimeAdapterPort,
): HostedExtensionPlugin {
  return defineHostedExtensionPlugin({
    name: "cli.questions_command",
    capabilities: ["tool_registration.write", "user_message.enqueue"],
    register(extensionApi: HostedExtensionApi) {
      extensionApi.registerCommand("questions", {
        description: "Inspect the operator inbox without entering a model turn (usage: /questions)",
        handler: async (args, ctx) => {
          const normalizedArgs = normalizeArgs(args);
          if (normalizedArgs) {
            if (ctx.hasUI) {
              ctx.ui.notify("Usage: /questions", "warning");
            }
            return;
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const collection = await collectOpenSessionQuestions(runtime, sessionId);
          const requestCount = listOpenQuestionRequests(collection.questions).length;
          if (ctx.hasUI) {
            const summary =
              requestCount > 0
                ? `Operator inbox updated (${requestCount} pending).`
                : "Operator inbox is empty.";
            ctx.ui.notify(
              toNotificationMessage(summary, formatQuestionsText(collection)),
              requestCount > 0 ? "info" : "warning",
            );
          }
        },
      });

      extensionApi.registerCommand("answer", {
        description:
          "Record an operator answer for an open session question and route it back into the current session (usage: /answer <question-id> <answer>)",
        handler: async (args, ctx) => {
          const parsed = parseAnswerArgs(args);
          if ("error" in parsed) {
            if (ctx.hasUI) {
              ctx.ui.notify(parsed.error, "warning");
            }
            return;
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const question = await resolveOpenSessionQuestion(runtime, sessionId, parsed.questionId);
          if (!question) {
            if (ctx.hasUI) {
              ctx.ui.notify(`Pending operator prompt not found: ${parsed.questionId}`, "warning");
            }
            return;
          }
          const validatedAnswer = validateSingleQuestionAnswer({
            question,
            answerText: parsed.answerText,
          });
          if (!validatedAnswer.ok) {
            if (ctx.hasUI) {
              ctx.ui.notify(validatedAnswer.error, "warning");
            }
            return;
          }
          const prompt = buildOperatorQuestionAnswerPrompt({
            question,
            answerText: validatedAnswer.answerText,
          });
          if (ctx.isIdle()) {
            extensionApi.sendUserMessage([{ type: "text", text: prompt }]);
          } else {
            extensionApi.sendUserMessage([{ type: "text", text: prompt }], {
              deliverAs: "followUp",
            });
          }
          runtime.ops.tools.operatorQuestions.answerRecorded({
            sessionId,
            payload: buildOperatorQuestionAnsweredPayload({
              question,
              answerText: validatedAnswer.answerText,
              source: "hosted",
            }),
          });
          if (ctx.hasUI) {
            ctx.ui.notify(
              ctx.isIdle()
                ? `Queued answer for ${parsed.questionId}.`
                : `Queued answer for ${parsed.questionId} after the current run.`,
              "info",
            );
          }
        },
      });
    },
  });
}
