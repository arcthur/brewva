import type {
  ChannelQuestionsCommandInput,
  ChannelQuestionsCommandResult,
} from "@brewva/brewva-gateway";
import { collectOpenQuestionsForSessions } from "@brewva/brewva-gateway";
import { clampText } from "./inspect-analysis.js";

const MAX_QUESTIONS = 4;
const MAX_QUESTION_CHARS = 180;
const MAX_WARNINGS = 2;

function formatHeader(input: {
  agentId: string;
  focusedAgentId: string;
  questionCount: number;
  warningCount: number;
}): string {
  const targetLabel =
    input.agentId === input.focusedAgentId
      ? `Questions @${input.agentId}`
      : `Questions @${input.agentId} (focus @${input.focusedAgentId})`;
  return `${targetLabel} — open=${input.questionCount} · warnings=${input.warningCount}`;
}

function formatQuestionLine(input: {
  questionId: string;
  sourceLabel: string;
  questionText: string;
}): string {
  return `- [${input.questionId}] ${input.sourceLabel} :: ${clampText(input.questionText, MAX_QUESTION_CHARS)}`;
}

export async function handleQuestionsChannelCommand(
  input: ChannelQuestionsCommandInput,
): Promise<ChannelQuestionsCommandResult> {
  if (!input.questionSurface || input.questionSurface.sessionIds.length === 0) {
    return {
      text: `Questions unavailable: no durable session history exists for @${input.targetAgentId} in this conversation yet. Send that agent a message first.`,
      meta: {
        command: "questions",
        agentId: input.targetAgentId,
        status: "session_not_found",
      },
    };
  }

  const collection = await collectOpenQuestionsForSessions(
    input.questionSurface.runtime,
    input.questionSurface.sessionIds,
  );
  const lines = [
    formatHeader({
      agentId: input.targetAgentId,
      focusedAgentId: input.focusedAgentId,
      questionCount: collection.questions.length,
      warningCount: collection.warnings.length,
    }),
  ];

  if (collection.questions.length === 0) {
    lines.push("Open questions: none.");
  } else {
    lines.push("Open questions:");
    for (const question of collection.questions.slice(0, MAX_QUESTIONS)) {
      lines.push(
        formatQuestionLine({
          questionId: question.questionId,
          sourceLabel: question.sourceLabel,
          questionText: question.questionText,
        }),
      );
    }
    const hiddenCount =
      collection.questions.length - Math.min(MAX_QUESTIONS, collection.questions.length);
    if (hiddenCount > 0) {
      lines.push(`- ... ${hiddenCount} more open question(s)`);
    }
    lines.push("Use /answer [@agent] <question-id> <answer> to resolve one.");
  }

  if (collection.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of collection.warnings.slice(0, MAX_WARNINGS)) {
      lines.push(`- ${clampText(warning, MAX_QUESTION_CHARS)}`);
    }
    const hiddenWarnings =
      collection.warnings.length - Math.min(MAX_WARNINGS, collection.warnings.length);
    if (hiddenWarnings > 0) {
      lines.push(`- ... ${hiddenWarnings} more warning(s)`);
    }
  }

  return {
    text: lines.join("\n"),
    meta: {
      command: "questions",
      agentId: input.targetAgentId,
      agentSessionIds: [...input.questionSurface.sessionIds],
      liveSessionId: input.questionSurface.liveSessionId,
      questionCount: collection.questions.length,
      warningCount: collection.warnings.length,
    },
  };
}
