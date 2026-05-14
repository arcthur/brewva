import {
  classifyQuestionRequest,
  flattenQuestionRequest,
  listOpenQuestionRequests,
  type SessionOpenQuestion,
  type SessionQuestionRequest,
} from "@brewva/brewva-gateway";
import type { OperatorSurfaceSnapshot } from "./operator-snapshot.js";
import type { CliQuestionDraftState, CliQuestionOverlayPayload } from "./overlays/payloads.js";

export function questionRequestsFromSnapshot(
  snapshot: OperatorSurfaceSnapshot,
): SessionQuestionRequest[] {
  return listOpenQuestionRequests(snapshot.questions);
}

export function questionRequestsFromOverlay(
  payload: CliQuestionOverlayPayload,
): SessionQuestionRequest[] {
  return questionRequestsFromSnapshot(payload.snapshot);
}

export function resolveQuestionOverlayTitle(payload: CliQuestionOverlayPayload): string {
  if (typeof payload.requestTitle === "string" && payload.requestTitle.trim().length > 0) {
    return payload.requestTitle.trim();
  }
  return payload.mode === "interactive" ? "Agent needs input" : "Operator Inbox";
}

export function countQuestionRequestKinds(requests: readonly SessionQuestionRequest[]): {
  inputRequestCount: number;
  followUpCount: number;
} {
  let inputRequestCount = 0;
  let followUpCount = 0;
  for (const request of requests) {
    if (classifyQuestionRequest(request) === "follow_up") {
      followUpCount += 1;
      continue;
    }
    inputRequestCount += 1;
  }
  return { inputRequestCount, followUpCount };
}

export function describeQuestionRequestSummary(request: SessionQuestionRequest): string {
  if (classifyQuestionRequest(request) === "follow_up") {
    return "follow-up question";
  }
  return `${request.questions.length} input prompt${request.questions.length === 1 ? "" : "s"}`;
}

export function buildOpenQuestionsFromRequest(
  request: SessionQuestionRequest,
): SessionOpenQuestion[] {
  return flattenQuestionRequest(request);
}

export function cloneQuestionDraftState(draft: CliQuestionDraftState): CliQuestionDraftState {
  return {
    activeTabIndex: draft.activeTabIndex,
    selectedOptionIndex: draft.selectedOptionIndex,
    editingCustom: draft.editingCustom,
    answers: draft.answers.map((answer) => [...answer]),
    customAnswers: draft.customAnswers.map((value) => value),
  };
}

export function isImmediateQuestionRequest(request: SessionQuestionRequest): boolean {
  return request.questions.length === 1 && request.questions[0]?.multiple !== true;
}

export function questionTabCount(request: SessionQuestionRequest): number {
  return isImmediateQuestionRequest(request) ? 1 : request.questions.length + 1;
}

export function buildDefaultQuestionDraftState(
  request: SessionQuestionRequest,
): CliQuestionDraftState {
  return {
    activeTabIndex: 0,
    selectedOptionIndex: 0,
    editingCustom: false,
    answers: request.questions.map(() => []),
    customAnswers: request.questions.map(() => ""),
  };
}

export function normalizeQuestionAnswers(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

export function normalizeQuestionDraftState(
  request: SessionQuestionRequest,
  draft: CliQuestionDraftState | undefined,
): CliQuestionDraftState {
  const base = draft ? cloneQuestionDraftState(draft) : buildDefaultQuestionDraftState(request);
  const answers = request.questions.map((_, index) =>
    normalizeQuestionAnswers(base.answers[index]),
  );
  const customAnswers = request.questions.map((_, index) => base.customAnswers[index] ?? "");
  const maxTabIndex = Math.max(0, questionTabCount(request) - 1);
  const activeTabIndex = Math.max(0, Math.min(base.activeTabIndex, maxTabIndex));
  const question = request.questions[activeTabIndex];
  if (!question || activeTabIndex >= request.questions.length) {
    return {
      activeTabIndex,
      selectedOptionIndex: 0,
      editingCustom: false,
      answers,
      customAnswers,
    };
  }
  const optionCount = question.options.length + (question.custom !== false ? 1 : 0);
  return {
    activeTabIndex,
    selectedOptionIndex:
      optionCount > 0 ? Math.max(0, Math.min(base.selectedOptionIndex, optionCount - 1)) : 0,
    editingCustom: base.editingCustom && question.custom !== false,
    answers,
    customAnswers,
  };
}

export function questionRequestIsComplete(
  request: SessionQuestionRequest,
  draft: CliQuestionDraftState,
): boolean {
  return request.questions.every(
    (_, index) => normalizeQuestionAnswers(draft.answers[index]).length > 0,
  );
}
