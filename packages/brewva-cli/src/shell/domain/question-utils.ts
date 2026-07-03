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

/** One option row as the overlay should render it. */
export interface QuestionOverlayOptionProjection {
  readonly index: number;
  readonly label: string;
  readonly description?: string;
  /** The row the keyboard highlight sits on — what Enter would act on. */
  readonly selected: boolean;
  /** Multi-select only: this option is currently in the answer set. */
  readonly checked: boolean;
  readonly isCustom: boolean;
}

/** The active question of the active request, ready for the overlay to render. */
export interface QuestionOverlayProjection {
  readonly header: string;
  readonly questionText: string;
  readonly multiple: boolean;
  readonly options: readonly QuestionOverlayOptionProjection[];
  readonly editingCustom: boolean;
  readonly customValue: string;
}

/**
 * Project the overlay payload into the exact rows the renderer draws, resolved
 * through the SAME `questionRequestsFromSnapshot` + `normalizeQuestionDraftState`
 * the input handler uses. Sharing this projection is what keeps the highlight
 * (and the multi-select checks) in lockstep with the handler's selection state,
 * instead of the renderer drawing a flat option list that knows nothing about
 * `selectedOptionIndex`. The custom-answer entry is appended as the final row
 * (matching the handler's `customIndex === options.length`) when the question
 * allows a custom answer. Returns undefined when no question is active.
 */
export function projectQuestionOverlay(
  payload: CliQuestionOverlayPayload,
): QuestionOverlayProjection | undefined {
  const requests = questionRequestsFromOverlay(payload);
  if (requests.length === 0) {
    return undefined;
  }
  const requestIndex = Math.max(0, Math.min(payload.selectedIndex, requests.length - 1));
  const request = requests[requestIndex];
  if (!request) {
    return undefined;
  }
  const draft = normalizeQuestionDraftState(
    request,
    payload.draftsByRequestId?.[request.requestId],
  );
  const questionIndex = Math.min(draft.activeTabIndex, Math.max(0, request.questions.length - 1));
  const question = request.questions[questionIndex];
  if (!question || draft.activeTabIndex >= request.questions.length) {
    return undefined;
  }
  const answers = normalizeQuestionAnswers(draft.answers[questionIndex]);
  const multiple = question.multiple === true;
  const options: QuestionOverlayOptionProjection[] = question.options.map((option, index) => ({
    index,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    selected: index === draft.selectedOptionIndex,
    checked: multiple && answers.includes(option.label),
    isCustom: false,
  }));
  if (question.custom !== false) {
    const customIndex = question.options.length;
    options.push({
      index: customIndex,
      label: "Custom",
      selected: customIndex === draft.selectedOptionIndex,
      checked: false,
      isCustom: true,
    });
  }
  return {
    header: question.header ?? "Question",
    questionText: question.questionText,
    multiple,
    options,
    editingCustom: draft.editingCustom,
    customValue: draft.customAnswers[questionIndex] ?? "",
  };
}
