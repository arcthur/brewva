import type { ChannelCommandMatch } from "./command/parser.js";

export type ChannelOperatorAction =
  | {
      kind: "status_summary";
      sourceCommand: "status";
      agentId?: string;
      directory?: string;
      top?: number;
      details?: boolean;
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
  if (match.kind === "status") {
    return {
      kind: "status_summary",
      sourceCommand: "status",
      agentId: match.agentId,
      directory: match.directory,
      top: match.top,
      details: match.details,
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
