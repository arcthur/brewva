import { describe, expect, test } from "bun:test";
import { asBrewvaToolCallId, asBrewvaToolName } from "@brewva/brewva-runtime";
import {
  TRUST_LOOP_COPY,
  buildTrustLoopApprovalEmptyProjection,
  buildTrustLoopApprovalProjection,
  buildTrustLoopSessionProjection,
  buildTrustLoopToolProjection,
} from "../../../packages/brewva-cli/src/shell/trust-loop/projection.js";

describe("trust loop projection", () => {
  test("maps read-only execution to inspect", () => {
    const projection = buildTrustLoopToolProjection({
      toolName: "read",
      args: { path: "src/app.ts" },
      executionPhase: "execute",
      status: "running",
    });

    expect(projection).toMatchObject({
      phase: "inspect",
      label: "Inspect",
      shortLabel: "inspect",
      actionClass: "workspace_read",
      policySource: "resolved",
    });
  });

  test("maps effectful execution to commit and record phases to record", () => {
    const commitProjection = buildTrustLoopToolProjection({
      toolName: "write",
      args: { path: "src/app.ts" },
      executionPhase: "execute",
      status: "running",
    });
    const recordProjection = buildTrustLoopToolProjection({
      toolName: "write",
      args: { path: "src/app.ts" },
      executionPhase: "record",
      status: "running",
    });

    expect(commitProjection.phase).toBe("commit");
    expect(commitProjection.label).toBe("Commit");
    expect(commitProjection.headline).toBe(TRUST_LOOP_COPY.reasonReceiptRecovery);
    expect(recordProjection.phase).toBe("record");
    expect(recordProjection.label).toBe("Record");
    expect(recordProjection.headline).toBe(TRUST_LOOP_COPY.inspectReplayUndo);
  });

  test("maps authorization phase to authorize", () => {
    const projection = buildTrustLoopToolProjection({
      toolName: "write",
      args: { path: "src/app.ts" },
      executionPhase: "authorize",
      status: "running",
    });

    expect(projection).toMatchObject({
      phase: "authorize",
      label: "Authorize",
      tone: "warning",
    });
  });

  test("keeps unknown tools conservative", () => {
    const projection = buildTrustLoopToolProjection({
      toolName: "custom_tool",
      args: { value: true },
      status: "running",
    });

    expect(projection).toMatchObject({
      phase: "inspect",
      label: "Inspect",
      policySource: "missing",
    });
  });

  test("builds approval projection with stable labels and effect details", () => {
    const projection = buildTrustLoopApprovalProjection({
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

    expect(projection.title).toBe("Authorize effect");
    expect(projection.headline).toBe(TRUST_LOOP_COPY.askBeforeEffectBoundary);
    expect(projection.subline).toBe(TRUST_LOOP_COPY.reasonReceiptRecovery);
    expect(projection.primaryActionLabel).toBe("Authorize once");
    expect(projection.statusText).toBe("Authorize");
    expect(projection.details).toContainEqual({
      key: "subject",
      label: "Subject",
      value: "Write src/app.ts",
    });
    expect(projection.details).toContainEqual({
      key: "summary",
      label: "Summary",
      value: "path=src/app.ts",
    });
    expect(projection.details).toContainEqual({
      key: "boundary",
      label: "Boundary",
      value: "effectful",
    });
    expect(projection.effectSummary).toBe("Effects: workspace_write");
  });

  test("builds approval empty state without permission vocabulary", () => {
    const projection = buildTrustLoopApprovalEmptyProjection();

    expect(projection).toMatchObject({
      kind: "approval_empty",
      phase: "authorize",
      title: "Authorize effects",
      headline: "No pending effects to authorize.",
      subline: TRUST_LOOP_COPY.askBeforeEffectBoundary,
      statusText: "Authorize",
    });
    expect(`${projection.title} ${projection.headline} ${projection.subline}`).not.toContain(
      "permission",
    );
  });

  test("projects session trust from approval, recovery, active tool, and idle states", () => {
    const activeTool = buildTrustLoopToolProjection({
      toolName: "write",
      executionPhase: "execute",
      status: "running",
    });

    expect(
      buildTrustLoopSessionProjection({
        pendingApprovalCount: 1,
      }),
    ).toMatchObject({ phase: "authorize", source: "approval", statusText: "Authorize" });
    expect(
      buildTrustLoopSessionProjection({
        phase: { kind: "recovering", turn: 1 },
      }),
    ).toMatchObject({ phase: "recover", source: "recovery", statusText: "Recover" });
    expect(
      buildTrustLoopSessionProjection({
        phase: {
          kind: "tool_executing",
          toolCallId: "tool-call-1",
          toolName: "write",
          turn: 1,
        },
        activeTool,
      }),
    ).toMatchObject({ phase: "commit", source: "tool", statusText: "Commit" });
    expect(buildTrustLoopSessionProjection({ phase: { kind: "idle" } })).toMatchObject({
      phase: "record",
      source: "idle",
      statusText: TRUST_LOOP_COPY.inspectReplayUndo,
    });
  });
});
