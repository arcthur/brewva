import { describe, expect, test } from "bun:test";
import { resolveChannelOperatorAction } from "../../../packages/brewva-gateway/src/channels/operator-actions.js";

describe("channel operator actions", () => {
  test("maps /status command matches into typed operator actions", () => {
    expect(
      resolveChannelOperatorAction({
        kind: "status",
        agentId: "reviewer",
        directory: "src/runtime",
        top: 7,
        details: true,
      }),
    ).toEqual({
      kind: "status_summary",
      sourceCommand: "status",
      agentId: "reviewer",
      directory: "src/runtime",
      top: 7,
      details: true,
    });
  });

  test("maps answer commands into typed operator actions", () => {
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
