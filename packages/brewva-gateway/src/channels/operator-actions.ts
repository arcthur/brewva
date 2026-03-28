import type { ChannelCommandMatch } from "./command-router.js";

export type ChannelOperatorAction =
  | {
      kind: "inspect_cost";
      sourceCommand: "cost";
      agentId?: string;
      top?: number;
    }
  | {
      kind: "inspect_questions";
      sourceCommand: "questions";
      agentId?: string;
    }
  | {
      kind: "answer_question";
      sourceCommand: "answer";
      agentId?: string;
      questionId: string;
      answerText: string;
    };

export function resolveChannelOperatorAction(
  match: ChannelCommandMatch,
): ChannelOperatorAction | null {
  if (match.kind === "cost") {
    return {
      kind: "inspect_cost",
      sourceCommand: "cost",
      agentId: match.agentId,
      top: match.top,
    };
  }
  if (match.kind === "questions") {
    return {
      kind: "inspect_questions",
      sourceCommand: "questions",
      agentId: match.agentId,
    };
  }
  if (match.kind === "answer") {
    return {
      kind: "answer_question",
      sourceCommand: "answer",
      agentId: match.agentId,
      questionId: match.questionId,
      answerText: match.answerText,
    };
  }
  return null;
}
