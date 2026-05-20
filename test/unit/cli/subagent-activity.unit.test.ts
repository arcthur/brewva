import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  type DelegationRunRecord,
} from "@brewva/brewva-runtime/protocol";
import { selectSubagentActivityItems } from "../../../packages/brewva-cli/src/shell/domain/subagent-activity.js";

function run(input: Partial<DelegationRunRecord> & { runId: string }): DelegationRunRecord {
  return {
    contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
    agent: "worker",
    targetName: "worker",
    delegate: "worker",
    taskName: "implement-widget",
    taskPath: "/implement-widget",
    nickname: "Implement widget",
    depth: 1,
    forkTurns: "none",
    gateReason: "implement_isolated",
    modelCategory: "isolated-execution",
    executionPrimitive: "named",
    visibility: "public",
    isolationStrategy: "shared",
    adoption: {
      contractId: "subagent-activity-test",
      decision: "require_human",
      reason: "Fixture run requires explicit adoption.",
    },
    parentSessionId: asBrewvaSessionId("parent-session"),
    status: "completed",
    createdAt: 100,
    updatedAt: 100,
    ...input,
  };
}

describe("subagent activity projection", () => {
  test("prioritizes active runs before recent terminal runs", () => {
    const items = selectSubagentActivityItems([
      run({ runId: "done-newer", status: "completed", updatedAt: 300 }),
      run({ runId: "active-older", status: "running", updatedAt: 200 }),
      run({ runId: "pending-oldest", status: "pending", updatedAt: 100 }),
    ]);

    expect(items.map((item) => item.runId)).toEqual([
      "active-older",
      "pending-oldest",
      "done-newer",
    ]);
    expect(items[0]).toMatchObject({
      icon: "◔",
      tone: "running",
      roleLabel: "Worker",
    });
  });

  test("uses label, summary, and status tone for compact UI rows", () => {
    const items = selectSubagentActivityItems([
      run({
        runId: "verifier-1",
        agent: "verifier",
        targetName: "qa-reviewer",
        delegate: "qa-reviewer",
        status: "failed",
        label: "Review regression",
        summary: "Snapshot mismatch",
        workerSessionId: asBrewvaSessionId("worker-session"),
      }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        runId: "verifier-1",
        roleLabel: "QA Reviewer",
        title: "Review regression",
        detail: "Snapshot mismatch",
        icon: "◍",
        tone: "error",
        workerSessionId: "worker-session",
      }),
    ]);
  });

  test("honors the visible activity limit", () => {
    const items = selectSubagentActivityItems(
      [
        run({ runId: "one", updatedAt: 1 }),
        run({ runId: "two", updatedAt: 2 }),
        run({ runId: "three", updatedAt: 3 }),
      ],
      { limit: 2 },
    );

    expect(items.map((item) => item.runId)).toEqual(["three", "two"]);
  });
});
