import { describe, expect, test } from "bun:test";
import { asBrewvaToolCallId, asBrewvaToolName } from "@brewva/brewva-runtime/core";
import {
  OPERATOR_SAFETY_SHELL_COPY,
  buildOperatorSafetyShellAskEmptyView,
  buildOperatorSafetyShellAskView,
  buildOperatorSafetyShellSessionView,
  buildOperatorSafetyShellToolView,
  buildPendingApprovalAffordance,
} from "../../../packages/brewva-cli/src/shell/domain/operator-safety/shell-view.js";

describe("pending approval affordance", () => {
  test("is absent with no pending approvals", () => {
    expect(buildPendingApprovalAffordance({ count: 0, reviewShortcut: "leader a" })).toBe(
      undefined,
    );
  });

  test("names a single approval and points at the review shortcut", () => {
    expect(buildPendingApprovalAffordance({ count: 1, reviewShortcut: "leader a" })).toBe(
      "△ 1 approval · leader a review",
    );
  });

  test("pluralizes and still surfaces without a resolved shortcut", () => {
    expect(buildPendingApprovalAffordance({ count: 3, reviewShortcut: "leader a" })).toBe(
      "△ 3 approvals · leader a review",
    );
    expect(buildPendingApprovalAffordance({ count: 2 })).toBe("△ 2 approvals");
  });
});

describe("operator safety shell view", () => {
  test("maps read-only execution to inspect", () => {
    const shellView = buildOperatorSafetyShellToolView({
      toolName: "read",
      args: { path: "src/app.ts" },
      executionPhase: "execute",
      status: "running",
    });

    expect(shellView).toMatchObject({
      phase: "inspect",
      label: "Inspect",
      shortLabel: "inspect",
      actionClass: "workspace_read",
      policySource: "resolved",
    });
  });

  test("maps effectful execution to commit and record phases to record", () => {
    const commitShellView = buildOperatorSafetyShellToolView({
      toolName: "write",
      args: { path: "src/app.ts" },
      executionPhase: "execute",
      status: "running",
    });
    const recordShellView = buildOperatorSafetyShellToolView({
      toolName: "write",
      args: { path: "src/app.ts" },
      executionPhase: "record",
      status: "running",
    });

    expect(commitShellView.phase).toBe("commit");
    expect(commitShellView.label).toBe("Commit");
    expect(commitShellView.headline).toBe(OPERATOR_SAFETY_SHELL_COPY.reasonReceiptRecovery);
    expect(recordShellView.phase).toBe("record");
    expect(recordShellView.label).toBe("Record");
    expect(recordShellView.headline).toBe(OPERATOR_SAFETY_SHELL_COPY.inspectReplayUndo);
  });

  test("maps authorization phase to ask vocabulary", () => {
    const shellView = buildOperatorSafetyShellToolView({
      toolName: "write",
      args: { path: "src/app.ts" },
      executionPhase: "authorize",
      status: "running",
    });

    expect(shellView).toMatchObject({
      phase: "authorize",
      label: "Ask",
      tone: "warning",
    });
  });

  test("keeps unknown tools conservative", () => {
    const shellView = buildOperatorSafetyShellToolView({
      toolName: "custom_tool",
      args: { value: true },
      status: "running",
    });

    expect(shellView).toMatchObject({
      phase: "inspect",
      label: "Inspect",
      policySource: "missing",
    });
  });

  test("builds ask shell view with stable labels and effect details", () => {
    const shellView = buildOperatorSafetyShellAskView({
      request: {
        requestId: "approval-1",
        proposalId: "proposal-1",
        toolName: asBrewvaToolName("write"),
        toolCallId: asBrewvaToolCallId("tool-call-1"),
        subject: "Write src/app.ts",
        boundary: "effectful",
        effects: ["workspace_write"],
        defaultRisk: "high",
        argsDigest: "digest-1",
        argsSummary: "path=src/app.ts",
        evidenceRefs: [],
        turn: 1,
        createdAt: 1,
      },
    });

    expect(shellView.title).toBe("Ask operator");
    expect(shellView.headline).toBe(OPERATOR_SAFETY_SHELL_COPY.askBeforeEffectBoundary);
    expect(shellView.subline).toBe(OPERATOR_SAFETY_SHELL_COPY.reasonReceiptRecovery);
    expect(shellView.primaryActionLabel).toBe("Allow once");
    expect(shellView.denyActionLabel).toBe("Deny");
    expect(shellView.statusText).toBe("Ask");
    expect(shellView.details).toContainEqual({
      key: "subject",
      label: "Subject",
      value: "Write src/app.ts",
    });
    expect(shellView.details).toContainEqual({
      key: "summary",
      label: "Summary",
      value: "path=src/app.ts",
    });
    expect(shellView.details).toContainEqual({
      key: "boundary",
      label: "Boundary",
      value: "effectful",
    });
    expect(shellView.effectSummary).toBe("Effects: workspace_write");
  });

  test("builds ask empty state without permission vocabulary", () => {
    const shellView = buildOperatorSafetyShellAskEmptyView();

    expect(shellView).toMatchObject({
      kind: "ask_empty",
      phase: "authorize",
      title: "Operator safety",
      headline: "No pending asks.",
      subline: OPERATOR_SAFETY_SHELL_COPY.askBeforeEffectBoundary,
      statusText: "Ask",
    });
    expect(`${shellView.title} ${shellView.headline} ${shellView.subline}`).not.toContain(
      "permission",
    );
  });

  test("builds session shell view from asks, recovery, active tool, and idle states", () => {
    const activeTool = buildOperatorSafetyShellToolView({
      toolName: "write",
      executionPhase: "execute",
      status: "running",
    });

    expect(
      buildOperatorSafetyShellSessionView({
        pendingAskCount: 1,
      }),
    ).toMatchObject({ phase: "authorize", source: "ask", statusText: "Ask" });
    expect(
      buildOperatorSafetyShellSessionView({
        phase: { kind: "recovering", turn: 1 },
      }),
    ).toMatchObject({ phase: "recover", source: "recovery", statusText: "Recover" });
    expect(
      buildOperatorSafetyShellSessionView({
        phase: {
          kind: "tool_executing",
          toolCallId: "tool-call-1",
          toolName: "write",
          turn: 1,
        },
        activeTool,
      }),
    ).toMatchObject({ phase: "commit", source: "tool", statusText: "Commit" });
    expect(buildOperatorSafetyShellSessionView({ phase: { kind: "idle" } })).toMatchObject({
      phase: "record",
      source: "idle",
      statusText: "Record",
    });
  });
});
