import { describe, expect, test } from "bun:test";
import type { OperatorSurfaceSnapshot } from "../../../packages/brewva-cli/src/shell/domain/operator-snapshot.js";
import type {
  CliQuestionDraftState,
  CliQuestionOverlayPayload,
} from "../../../packages/brewva-cli/src/shell/domain/overlays/payloads.js";
import { projectQuestionOverlay } from "../../../packages/brewva-cli/src/shell/domain/question-utils.js";

function openQuestion(
  overrides: Partial<OperatorSurfaceSnapshot["questions"][number]> = {},
): OperatorSurfaceSnapshot["questions"][number] {
  return {
    questionId: "q-1",
    sessionId: "session-1",
    createdAt: 1,
    sourceKind: "tool",
    sourceEventId: "evt-1",
    questionText: "Which scope?",
    sourceLabel: "tool:question",
    requestId: "req-1",
    header: "Scope",
    options: [{ label: "From scratch" }, { label: "Skeleton first", description: "minimal" }],
    custom: false,
    ...overrides,
  };
}

function payload(input: {
  question: OperatorSurfaceSnapshot["questions"][number];
  draft?: CliQuestionDraftState;
}): CliQuestionOverlayPayload {
  return {
    kind: "question",
    mode: "interactive",
    selectedIndex: 0,
    snapshot: { approvals: [], questions: [input.question], taskRuns: [], sessions: [] },
    ...(input.draft ? { draftsByRequestId: { "req-1": input.draft } } : {}),
  };
}

describe("projectQuestionOverlay", () => {
  test("marks the highlighted option — the one Enter acts on", () => {
    const view = projectQuestionOverlay(payload({ question: openQuestion() }));
    expect(view?.header).toBe("Scope");
    expect(view?.questionText).toBe("Which scope?");
    expect(
      view?.options.map((option) => ({ label: option.label, selected: option.selected })),
    ).toEqual([
      { label: "From scratch", selected: true },
      { label: "Skeleton first", selected: false },
    ]);
    // Default highlight is the first option, so Enter (which acts on the
    // highlighted row) resolves to option 1 — the exact ambiguity the operator hit.
    expect(view?.options[0]?.description).toBe(undefined);
    expect(view?.options[1]?.description).toBe("minimal");
  });

  test("moves the highlight with selectedOptionIndex", () => {
    const view = projectQuestionOverlay(
      payload({
        question: openQuestion(),
        draft: {
          activeTabIndex: 0,
          selectedOptionIndex: 1,
          editingCustom: false,
          answers: [[]],
          customAnswers: [""],
        },
      }),
    );
    expect(view?.options.map((option) => option.selected)).toEqual([false, true]);
  });

  test("checks chosen options for a multi-select question", () => {
    const view = projectQuestionOverlay(
      payload({
        question: openQuestion({ multiple: true }),
        draft: {
          activeTabIndex: 0,
          selectedOptionIndex: 0,
          editingCustom: false,
          answers: [["Skeleton first"]],
          customAnswers: [""],
        },
      }),
    );
    expect(view?.multiple).toBe(true);
    expect(view?.options.map((option) => option.checked)).toEqual([false, true]);
  });

  test("appends the custom row when the question allows a custom answer", () => {
    const view = projectQuestionOverlay(payload({ question: openQuestion({ custom: true }) }));
    const custom = view?.options.at(-1);
    expect(custom?.isCustom).toBe(true);
    expect(custom?.index).toBe(2);
    expect(view?.options).toHaveLength(3);
  });

  test("returns undefined when no question is pending", () => {
    expect(
      projectQuestionOverlay({
        kind: "question",
        mode: "interactive",
        selectedIndex: 0,
        snapshot: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      }),
    ).toBe(undefined);
  });
});
