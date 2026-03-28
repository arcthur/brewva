import { describe, expect, test } from "bun:test";
import { resolveChannelOperatorAction } from "../../../packages/brewva-gateway/src/channels/operator-actions.js";

describe("channel operator actions", () => {
  test("maps /cost command matches into typed operator actions", () => {
    expect(
      resolveChannelOperatorAction({
        kind: "cost",
        agentId: "reviewer",
        top: 7,
      }),
    ).toEqual({
      kind: "inspect_cost",
      sourceCommand: "cost",
      agentId: "reviewer",
      top: 7,
    });
  });

  test("maps question commands into typed operator actions", () => {
    expect(
      resolveChannelOperatorAction({
        kind: "questions",
        agentId: "reviewer",
      }),
    ).toEqual({
      kind: "inspect_questions",
      sourceCommand: "questions",
      agentId: "reviewer",
    });
    expect(
      resolveChannelOperatorAction({
        kind: "answer",
        agentId: "reviewer",
        questionId: "skill:event-1:1",
        answerText: "Use the canonical route.",
      }),
    ).toEqual({
      kind: "answer_question",
      sourceCommand: "answer",
      agentId: "reviewer",
      questionId: "skill:event-1:1",
      answerText: "Use the canonical route.",
    });
  });

  test("ignores non-operator channel commands", () => {
    expect(resolveChannelOperatorAction({ kind: "agents" })).toBeNull();
    expect(
      resolveChannelOperatorAction({
        kind: "route-agent",
        agentId: "reviewer",
        task: "Inspect the current diff",
        viaMention: true,
      }),
    ).toBeNull();
  });
});
