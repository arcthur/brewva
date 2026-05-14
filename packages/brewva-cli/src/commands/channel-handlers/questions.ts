import type {
  ChannelQuestionsCommandInput,
  ChannelQuestionsCommandResult,
} from "@brewva/brewva-gateway";
import { classifyOpenQuestion, collectOpenQuestionsForSessions } from "@brewva/brewva-gateway";
import { clampText } from "../../operator/inspect-analysis.js";

const MAX_QUESTIONS = 4;
const MAX_QUESTION_CHARS = 180;
const MAX_WARNINGS = 2;

function formatHeader(input: {
  agentId: string;
  focusedAgentId: string;
  questionCount: number;
  inputPromptCount: number;
  followUpCount: number;
  warningCount: number;
}): string {
  const targetLabel =
    input.agentId === input.focusedAgentId
      ? `Operator inbox @${input.agentId}`
      : `Operator inbox @${input.agentId} (focus @${input.focusedAgentId})`;
  return `${targetLabel} — pending=${input.questionCount} · input=${input.inputPromptCount} · follow-up=${input.followUpCount} · warnings=${input.warningCount}`;
}

function formatQuestionLine(input: {
  kindLabel: string;
  questionId: string;
  sourceLabel: string;
  questionText: string;
}): string {
  return `- [${input.questionId}] ${input.sourceLabel} :: ${input.kindLabel} :: ${clampText(input.questionText, MAX_QUESTION_CHARS)}`;
}

export async function handleQuestionsChannelCommand(
  input: ChannelQuestionsCommandInput,
): Promise<ChannelQuestionsCommandResult> {
  if (!input.questionSurface || input.questionSurface.sessionIds.length === 0) {
    return {
      text: `Operator inbox unavailable: no durable session history exists for @${input.targetAgentId} in this conversation yet. Send that agent a message first.`,
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
  const inputPrompts = collection.questions.filter(
    (question) => classifyOpenQuestion(question) === "input_request",
  );
  const followUpQuestions = collection.questions.filter(
    (question) => classifyOpenQuestion(question) === "follow_up",
  );
  const lines = [
    formatHeader({
      agentId: input.targetAgentId,
      focusedAgentId: input.focusedAgentId,
      questionCount: collection.questions.length,
      inputPromptCount: inputPrompts.length,
      followUpCount: followUpQuestions.length,
      warningCount: collection.warnings.length,
    }),
  ];

  if (collection.questions.length === 0) {
    lines.push("Operator inbox: empty.");
  } else {
    if (inputPrompts.length > 0) {
      lines.push("Pending input prompts:");
      for (const question of inputPrompts.slice(0, MAX_QUESTIONS)) {
        lines.push(
          formatQuestionLine({
            kindLabel: "input",
            questionId: question.questionId,
            sourceLabel: question.sourceLabel,
            questionText: question.questionText,
          }),
        );
      }
      const hiddenInputCount = inputPrompts.length - Math.min(MAX_QUESTIONS, inputPrompts.length);
      if (hiddenInputCount > 0) {
        lines.push(`- ... ${hiddenInputCount} more input prompt(s)`);
      }
    }
    if (followUpQuestions.length > 0) {
      lines.push("Follow-up questions:");
      for (const question of followUpQuestions.slice(0, MAX_QUESTIONS)) {
        lines.push(
          formatQuestionLine({
            kindLabel: "follow-up",
            questionId: question.questionId,
            sourceLabel: question.sourceLabel,
            questionText: question.questionText,
          }),
        );
      }
      const hiddenFollowUpCount =
        followUpQuestions.length - Math.min(MAX_QUESTIONS, followUpQuestions.length);
      if (hiddenFollowUpCount > 0) {
        lines.push(`- ... ${hiddenFollowUpCount} more follow-up question(s)`);
      }
    }
    lines.push("Use /answer [@agent] <question-id> <answer> to resolve one prompt at a time.");
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
