import { validateQuestionRequestAnswers } from "@brewva/brewva-gateway";
import type { ShellEffect } from "../../domain/effects.js";
import type { CliShellInput } from "../../domain/input.js";
import { normalizeShellInputKey } from "../../domain/keymap.js";
import type {
  CliQuestionDraftState,
  CliShellOverlayPayload,
} from "../../domain/overlays/payloads.js";
import {
  cloneQuestionDraftState,
  isImmediateQuestionRequest,
  normalizeQuestionAnswers,
  normalizeQuestionDraftState,
  questionRequestsFromSnapshot,
  questionTabCount,
} from "../../domain/question-utils.js";

type QuestionOverlayPayload = Extract<CliShellOverlayPayload, { kind: "question" }>;

/** Maps ^n/^p to down/up for question lists (shift does not block; matches shell-input-router). */
function remapEmacsNav(input: CliShellInput): CliShellInput {
  if (!input.ctrl || input.meta) {
    return input;
  }
  const k = normalizeShellInputKey(input.key);
  if (k === "n") {
    return { ...input, ctrl: false, key: "down" };
  }
  if (k === "p") {
    return { ...input, ctrl: false, key: "up" };
  }
  return input;
}

export interface ShellQuestionOverlayHandlerContext {
  notify(message: string, level: "info" | "warning" | "error"): void;
  replaceActiveOverlay(payload: CliShellOverlayPayload): void;
  closeActiveOverlay(cancelled: boolean): void;
  runShellEffects(effects: readonly ShellEffect[]): Promise<void>;
  refreshOperatorSnapshot(): Promise<void>;
  settleInteractiveQuestionRequest(
    requestId: string,
    value: readonly (readonly string[])[] | undefined,
  ): void;
}

export class ShellQuestionOverlayHandler {
  constructor(private readonly context: ShellQuestionOverlayHandlerContext) {}

  async handleInput(active: QuestionOverlayPayload, rawInput: CliShellInput): Promise<boolean> {
    const input = remapEmacsNav(rawInput);

    if (input.ctrl || input.meta) {
      return false;
    }

    const requests = questionRequestsFromSnapshot(active.snapshot);
    const selectedIndex =
      requests.length > 0 ? Math.max(0, Math.min(active.selectedIndex, requests.length - 1)) : 0;
    const request = requests[selectedIndex];
    const key = normalizeShellInputKey(input.key);

    if (!request) {
      if (key === "escape") {
        this.context.closeActiveOverlay(true);
        return true;
      }
      return typeof input.text === "string" || input.key.length > 0;
    }

    const replaceRequestDraft = (draft: CliQuestionDraftState): CliQuestionDraftState => {
      const nextDraft = normalizeQuestionDraftState(request, draft);
      this.context.replaceActiveOverlay({
        ...active,
        selectedIndex,
        draftsByRequestId: {
          ...active.draftsByRequestId,
          [request.requestId]: nextDraft,
        },
      });
      return nextDraft;
    };

    const replaceSelectedRequest = (nextIndex: number): void => {
      if (requests.length === 0) {
        return;
      }
      this.context.replaceActiveOverlay({
        ...active,
        selectedIndex: (nextIndex + requests.length) % requests.length,
      });
    };

    const draft = normalizeQuestionDraftState(
      request,
      active.draftsByRequestId?.[request.requestId],
    );
    const confirmTab =
      !isImmediateQuestionRequest(request) && draft.activeTabIndex === request.questions.length;
    const questionIndex = Math.min(draft.activeTabIndex, Math.max(0, request.questions.length - 1));
    const question = request.questions[questionIndex];
    const optionCount = question
      ? question.options.length + (question.custom !== false ? 1 : 0)
      : 0;
    const customIndex = question ? question.options.length : -1;

    const submitRequest = async (nextDraft: CliQuestionDraftState): Promise<void> => {
      const validatedAnswers = validateQuestionRequestAnswers({
        request,
        answers: nextDraft.answers,
      });
      if (!validatedAnswers.ok) {
        this.context.notify(validatedAnswers.error, "warning");
        return;
      }
      if (active.mode === "interactive") {
        this.context.settleInteractiveQuestionRequest(request.requestId, validatedAnswers.answers);
        this.context.notify("Operator input submitted.", "info");
      } else {
        await this.context.runShellEffects([
          {
            type: "operator.answerQuestionRequest",
            requestId: request.requestId,
            answers: validatedAnswers.answers,
          },
        ]);
        this.context.notify(`Submitted input for ${request.requestId}.`, "info");
      }
      this.context.closeActiveOverlay(false);
      if (active.mode === "operator") {
        await this.context.refreshOperatorSnapshot();
      }
    };

    const advanceAfterSingleChoice = async (
      nextDraft: CliQuestionDraftState,
      nextQuestionIndex: number,
    ): Promise<void> => {
      if (isImmediateQuestionRequest(request)) {
        await submitRequest(nextDraft);
        return;
      }
      replaceRequestDraft({
        ...nextDraft,
        activeTabIndex: Math.min(nextQuestionIndex + 1, questionTabCount(request) - 1),
        selectedOptionIndex: 0,
        editingCustom: false,
      });
    };

    const commitCustomAnswer = async (): Promise<void> => {
      if (!question) {
        return;
      }
      const nextDraft = cloneQuestionDraftState(draft);
      const previousValue = (draft.customAnswers[questionIndex] ?? "").trim();
      const nextValue = (nextDraft.customAnswers[questionIndex] ?? "").trim();
      nextDraft.customAnswers[questionIndex] = nextValue;
      nextDraft.editingCustom = false;

      if (question.multiple) {
        const values = normalizeQuestionAnswers(nextDraft.answers[questionIndex]).filter(
          (value) => value !== previousValue,
        );
        nextDraft.answers[questionIndex] = nextValue ? [...values, nextValue] : values;
        replaceRequestDraft(nextDraft);
        return;
      }

      nextDraft.answers[questionIndex] = nextValue ? [nextValue] : [];
      const normalized = replaceRequestDraft(nextDraft);
      if (nextValue) {
        await advanceAfterSingleChoice(normalized, questionIndex);
      }
    };

    const selectOption = async (optionIndex: number): Promise<void> => {
      if (!question) {
        return;
      }
      if (question.custom !== false && optionIndex === customIndex) {
        replaceRequestDraft({
          ...draft,
          selectedOptionIndex: optionIndex,
          editingCustom: true,
        });
        return;
      }

      const option = question.options[optionIndex];
      if (!option) {
        return;
      }

      if (question.multiple) {
        const nextDraft = cloneQuestionDraftState(draft);
        const values = normalizeQuestionAnswers(nextDraft.answers[questionIndex]);
        nextDraft.answers[questionIndex] = values.includes(option.label)
          ? values.filter((value) => value !== option.label)
          : [...values, option.label];
        nextDraft.selectedOptionIndex = optionIndex;
        replaceRequestDraft(nextDraft);
        return;
      }

      const nextDraft = cloneQuestionDraftState(draft);
      nextDraft.answers[questionIndex] = [option.label];
      nextDraft.selectedOptionIndex = optionIndex;
      const normalized = replaceRequestDraft(nextDraft);
      await advanceAfterSingleChoice(normalized, questionIndex);
    };

    if (key === "escape") {
      if (draft.editingCustom) {
        replaceRequestDraft({
          ...draft,
          editingCustom: false,
        });
      } else {
        this.context.closeActiveOverlay(true);
      }
      return true;
    }

    if (key === "pageup" && requests.length > 1) {
      replaceSelectedRequest(selectedIndex - 1);
      return true;
    }
    if (key === "pagedown" && requests.length > 1) {
      replaceSelectedRequest(selectedIndex + 1);
      return true;
    }

    if (draft.editingCustom) {
      if (key === "backspace") {
        const value = draft.customAnswers[questionIndex] ?? "";
        replaceRequestDraft({
          ...draft,
          customAnswers: draft.customAnswers.map((item, index) =>
            index === questionIndex ? value.slice(0, -1) : item,
          ),
        });
        return true;
      }
      if (key === "enter") {
        await commitCustomAnswer();
        return true;
      }
      if (key === "character" && typeof input.text === "string") {
        replaceRequestDraft({
          ...draft,
          customAnswers: draft.customAnswers.map((item, index) =>
            index === questionIndex ? `${item}${input.text}` : item,
          ),
        });
        return true;
      }
      return true;
    }

    if (typeof input.text === "string") {
      const lowered = input.text.toLowerCase();
      if ((lowered === "h" || lowered === "l") && questionTabCount(request) > 1) {
        replaceRequestDraft({
          ...draft,
          activeTabIndex:
            (draft.activeTabIndex + (lowered === "l" ? 1 : -1) + questionTabCount(request)) %
            questionTabCount(request),
          selectedOptionIndex: 0,
          editingCustom: false,
        });
        return true;
      }
      if ((lowered === "j" || lowered === "k") && !confirmTab && optionCount > 0) {
        replaceRequestDraft({
          ...draft,
          selectedOptionIndex:
            (draft.selectedOptionIndex + (lowered === "j" ? 1 : -1) + optionCount) % optionCount,
        });
        return true;
      }
      if (/^[1-9]$/u.test(lowered) && !confirmTab) {
        const optionIndex = Number(lowered) - 1;
        if (optionIndex < optionCount) {
          await selectOption(optionIndex);
        }
        return true;
      }
    }

    if ((key === "left" || key === "right" || key === "tab") && questionTabCount(request) > 1) {
      const delta = key === "left" || (key === "tab" && input.shift) ? -1 : 1;
      replaceRequestDraft({
        ...draft,
        activeTabIndex:
          (draft.activeTabIndex + delta + questionTabCount(request)) % questionTabCount(request),
        selectedOptionIndex: 0,
        editingCustom: false,
      });
      return true;
    }

    if (!confirmTab && optionCount > 0 && (key === "up" || key === "down")) {
      replaceRequestDraft({
        ...draft,
        selectedOptionIndex:
          (draft.selectedOptionIndex + (key === "down" ? 1 : -1) + optionCount) % optionCount,
      });
      return true;
    }

    if (key === "enter") {
      if (confirmTab) {
        await submitRequest(draft);
        return true;
      }
      if (optionCount > 0) {
        await selectOption(draft.selectedOptionIndex);
        return true;
      }
      if (question?.custom !== false) {
        replaceRequestDraft({
          ...draft,
          editingCustom: true,
        });
        return true;
      }
    }

    return false;
  }
}
