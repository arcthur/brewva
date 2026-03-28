import {
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  buildOperatorQuestionAnswerPrompt,
  buildOperatorQuestionAnsweredPayload,
  collectOpenSessionQuestions,
  resolveOpenSessionQuestion,
} from "@brewva/brewva-gateway";
import type { RuntimePlugin, RuntimePluginApi } from "@brewva/brewva-gateway/runtime-plugins";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { clampText } from "./inspect-analysis.js";

const QUESTIONS_WIDGET_ID = "brewva-questions";
const MAX_WIDGET_LINES = 28;
const MAX_LINE_CHARS = 220;

function clearQuestionsWidget(ctx: ExtensionContext, widgetId: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(widgetId, undefined, {
    placement: "belowEditor",
  });
}

function toWidgetLines(text: string): string[] {
  const rawLines = text.split(/\r?\n/u).map((line) => clampText(line, MAX_LINE_CHARS));
  if (rawLines.length <= MAX_WIDGET_LINES) {
    return rawLines;
  }
  const kept = rawLines.slice(0, Math.max(1, MAX_WIDGET_LINES - 1));
  kept.push(`...[questions truncated: ${rawLines.length - kept.length} more lines]`);
  return kept;
}

function formatQuestionsText(input: {
  questions: Awaited<ReturnType<typeof collectOpenSessionQuestions>>["questions"];
  warnings: string[];
}): string {
  const lines = [`Open questions: ${input.questions.length}`];
  if (input.questions.length === 0) {
    lines.push("No open questions.");
  } else {
    for (const question of input.questions) {
      lines.push(
        `- [${question.questionId}] ${question.sourceLabel} :: ${clampText(question.questionText, 180)}`,
      );
    }
    lines.push("Use /answer <question-id> <answer> to resolve one.");
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

export function createQuestionsCommandRuntimePlugin(runtime: BrewvaRuntime): RuntimePlugin {
  return (runtimePluginApi: RuntimePluginApi) => {
    runtimePluginApi.on("session_start", async (_event, ctx) => {
      clearQuestionsWidget(ctx, QUESTIONS_WIDGET_ID);
    });
    runtimePluginApi.on("session_switch", async (_event, ctx) => {
      clearQuestionsWidget(ctx, QUESTIONS_WIDGET_ID);
    });
    runtimePluginApi.on("session_shutdown", async (_event, ctx) => {
      clearQuestionsWidget(ctx, QUESTIONS_WIDGET_ID);
    });

    runtimePluginApi.registerCommand("questions", {
      description:
        "Inspect unresolved session questions without entering a model turn (usage: /questions | /questions clear)",
      handler: async (args, ctx) => {
        const normalizedArgs = normalizeArgs(args);
        if (normalizedArgs === "clear") {
          clearQuestionsWidget(ctx, QUESTIONS_WIDGET_ID);
          if (ctx.hasUI) {
            ctx.ui.notify("Questions widget cleared.", "info");
          }
          return;
        }
        if (normalizedArgs) {
          if (ctx.hasUI) {
            ctx.ui.notify("Usage: /questions | /questions clear", "warning");
          }
          return;
        }
        const sessionId = ctx.sessionManager.getSessionId();
        const collection = await collectOpenSessionQuestions(runtime, sessionId);
        if (ctx.hasUI) {
          ctx.ui.setWidget(QUESTIONS_WIDGET_ID, toWidgetLines(formatQuestionsText(collection)), {
            placement: "belowEditor",
          });
          ctx.ui.notify(
            collection.questions.length > 0
              ? `Questions updated (${collection.questions.length} open).`
              : "No open questions found.",
            collection.questions.length > 0 ? "info" : "warning",
          );
        }
      },
    });

    runtimePluginApi.registerCommand("answer", {
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
            ctx.ui.notify(`Open question not found: ${parsed.questionId}`, "warning");
          }
          return;
        }
        const prompt = buildOperatorQuestionAnswerPrompt({
          question,
          answerText: parsed.answerText,
        });
        if (ctx.isIdle()) {
          runtimePluginApi.sendUserMessage(prompt);
        } else {
          runtimePluginApi.sendUserMessage(prompt, { deliverAs: "followUp" });
        }
        runtime.events.record({
          sessionId,
          type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
          payload: buildOperatorQuestionAnsweredPayload({
            question,
            answerText: parsed.answerText,
            source: "runtime_plugin",
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
  };
}
