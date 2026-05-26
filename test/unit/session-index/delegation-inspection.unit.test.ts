import { describe, expect, test } from "bun:test";
import {
  projectDelegationInspectionState,
  projectSessionDelegationState,
} from "@brewva/brewva-session-index";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
  SOURCE_PATCH_PREPARED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_REJECTED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";

function event(input: {
  readonly id: string;
  readonly type: string;
  readonly timestamp: number;
  readonly payload: Record<string, unknown>;
  readonly sessionId?: string;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "session-delegation-inspection",
    turn: Math.trunc(input.timestamp / 100),
    type: input.type,
    timestamp: input.timestamp,
    payload: input.payload,
  };
}

function runPayload(input: {
  readonly runId: string;
  readonly agent: "navigator" | "explorer" | "worker" | "verifier" | "librarian";
  readonly kind: "evidence" | "consult" | "patch" | "verifier" | "knowledge";
  readonly status: "pending" | "running" | "completed" | "failed" | "cancelled";
  readonly updatedAt: number;
  readonly summary?: string;
  readonly error?: string;
  readonly patchSetId?: string;
}): Record<string, unknown> {
  return {
    contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
    runId: input.runId,
    agent: input.agent,
    targetName: input.agent,
    delegate: input.agent,
    taskName: `Inspect ${input.agent}`,
    taskPath: `/inspect/${input.agent}`,
    nickname: `Inspect ${input.agent}`,
    depth: 1,
    forkTurns: "none",
    gateReason: input.agent === "worker" ? "implement_isolated" : "find_evidence",
    modelCategory: input.agent === "worker" ? "isolated-execution" : "read-only",
    executionPrimitive: "named",
    visibility: "public",
    isolationStrategy: input.agent === "verifier" ? "ephemeral_exec" : "shared",
    adoption: {
      contractId: "delegation-inspection-test",
      decision: input.kind === "patch" ? "patch_apply" : "none",
      reason: "Inspection projection owns adoption state.",
    },
    lifecycleReason: "none",
    retention: "live",
    createdAt: 1_000,
    updatedAt: input.updatedAt,
    label: `Inspect ${input.agent}`,
    kind: input.kind,
    status: input.status,
    summary: input.summary,
    error: input.error,
    resultData: input.patchSetId
      ? {
          kind: input.kind,
          patches: {
            id: input.patchSetId,
            changes: [{ action: "modify", path: "src/file.ts", artifactRef: "artifact.txt" }],
          },
        }
      : { kind: input.kind },
    patches: input.patchSetId
      ? {
          id: input.patchSetId,
          changes: [{ action: "modify", path: "src/file.ts", artifactRef: "artifact.txt" }],
        }
      : undefined,
  };
}

describe("delegation inspection projection", () => {
  test("keeps worker lifecycle completed when explicit apply changes only disposition", () => {
    const records = [
      event({
        id: "evt-worker-spawned",
        type: SUBAGENT_SPAWNED_EVENT_TYPE,
        timestamp: 1_000,
        payload: runPayload({
          runId: "worker-1",
          agent: "worker",
          kind: "patch",
          status: "pending",
          updatedAt: 1_000,
        }),
      }),
      event({
        id: "evt-worker-completed",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 1_100,
        payload: runPayload({
          runId: "worker-1",
          agent: "worker",
          kind: "patch",
          status: "completed",
          updatedAt: 1_100,
          summary: "Prepared a patch.",
          patchSetId: "patch-worker-1",
        }),
      }),
      event({
        id: "evt-source-prepared",
        type: SOURCE_PATCH_PREPARED_EVENT_TYPE,
        timestamp: 1_200,
        payload: {
          id: "plan-worker-1",
          status: "prepared",
          createdAt: 1_200,
          summary: "Prepared a patch.",
          snapshots: [],
          intents: [],
          changes: [{ action: "modify", path: "src/file.ts" }],
          conflicts: [],
          preflight: { ok: true, staleRecovered: false, generatedFileRejected: false },
          preview: "diff -- src/file.ts\n-SECRET_TOKEN=abc\n+SECRET_TOKEN=def",
          metadata: {
            source: "worker_results_apply",
            workerIds: ["worker-1"],
            mergedPatchSetId: "patch-worker-1",
          },
        },
      }),
      event({
        id: "evt-worker-applied",
        type: WORKER_RESULTS_APPLIED_EVENT_TYPE,
        timestamp: 1_300,
        payload: {
          workerIds: ["worker-1"],
          planId: "plan-worker-1",
          appliedPatchSetId: "patch-worker-1",
        },
      }),
    ];

    const replayState = projectSessionDelegationState({
      sessionId: "session-delegation-inspection",
      records,
    });
    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(replayState.runs).toHaveLength(1);
    expect(replayState.runs[0]?.status).toBe("completed");
    expect(replayState.runs[0]?.status).not.toBe("merged");
    expect(inspection.runCards[0]).toMatchObject({
      runId: "worker-1",
      role: "worker",
      resultMode: "patch",
      lifecycle: "completed",
      lifecycleReason: "none",
      adoptionRequirement: "patch_apply",
      disposition: "applied",
    });
    expect(inspection.workboard.pendingWorkerPatches).toHaveLength(0);
  });

  test("filters inspection input to the requested session id", () => {
    const records = [
      event({
        id: "evt-target-worker",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 1_000,
        payload: runPayload({
          runId: "worker-target",
          agent: "worker",
          kind: "patch",
          status: "completed",
          updatedAt: 1_000,
          summary: "Target session patch.",
        }),
      }),
      event({
        id: "evt-other-worker",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 1_100,
        sessionId: "other-session",
        payload: runPayload({
          runId: "worker-other",
          agent: "worker",
          kind: "patch",
          status: "completed",
          updatedAt: 1_100,
          summary: "Other session patch.",
        }),
      }),
    ];

    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(inspection.runCards.map((card) => card.runId)).toEqual(["worker-target"]);
    expect(inspection.timeline.groups.map((group) => group.eventIds)).toEqual([
      ["evt-target-worker"],
    ]);
    expect(JSON.stringify(inspection)).not.toContain("worker-other");
  });

  test("does not treat non-rejection worker result clears as worker rejection", () => {
    const records = [
      event({
        id: "evt-worker-completed",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 1_000,
        payload: runPayload({
          runId: "worker-clear",
          agent: "worker",
          kind: "patch",
          status: "completed",
          updatedAt: 1_000,
          summary: "Prepared a patch.",
          patchSetId: "patch-worker-clear",
        }),
      }),
      event({
        id: "evt-worker-cleared-after-apply",
        type: "worker.results.cleared",
        timestamp: 1_100,
        payload: {
          workerIds: ["worker-clear"],
          decision: "applied",
          reason: "worker_results_apply",
        },
      }),
    ];

    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(inspection.runCards[0]).toMatchObject({
      runId: "worker-clear",
      disposition: "pending_apply",
    });
    expect(inspection.inbox.items).toEqual([
      expect.objectContaining({
        kind: "worker_patch",
        runId: "worker-clear",
      }),
    ]);
  });

  test("does not surface running worker runs as pullable patch inbox items", () => {
    const records = [
      event({
        id: "evt-worker-running",
        type: SUBAGENT_SPAWNED_EVENT_TYPE,
        timestamp: 1_000,
        payload: runPayload({
          runId: "worker-running",
          agent: "worker",
          kind: "patch",
          status: "running",
          updatedAt: 1_000,
        }),
      }),
    ];

    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(inspection.runCards[0]).toMatchObject({
      runId: "worker-running",
      lifecycle: "running",
      disposition: "pending_apply",
    });
    expect(inspection.workboard.pendingWorkerPatches).toHaveLength(0);
    expect(inspection.inbox.items).toHaveLength(0);
    expect(inspection.recoveryPreview.primitives).not.toContainEqual(
      expect.objectContaining({
        kind: "reject_adoption",
        target: "worker_patch",
        runId: "worker-running",
      }),
    );
  });

  test("derives in-memory parallel budget from delegation lifecycle events", () => {
    const records = [
      event({
        id: "evt-worker-a-spawned",
        type: SUBAGENT_SPAWNED_EVENT_TYPE,
        timestamp: 1_000,
        payload: runPayload({
          runId: "worker-a",
          agent: "worker",
          kind: "patch",
          status: "pending",
          updatedAt: 1_000,
        }),
      }),
      event({
        id: "evt-worker-b-spawned",
        type: SUBAGENT_SPAWNED_EVENT_TYPE,
        timestamp: 1_010,
        payload: runPayload({
          runId: "worker-b",
          agent: "worker",
          kind: "patch",
          status: "pending",
          updatedAt: 1_010,
        }),
      }),
      event({
        id: "evt-worker-a-completed",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 1_100,
        payload: runPayload({
          runId: "worker-a",
          agent: "worker",
          kind: "patch",
          status: "completed",
          updatedAt: 1_100,
        }),
      }),
    ];

    const replayState = projectSessionDelegationState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(replayState.parallelBudget).toMatchObject({
      activeRunIds: ["worker-b"],
      totalStarted: 2,
      eventCount: records.length,
      latestEventId: "evt-worker-a-completed",
    });
  });

  test("maps explicit worker result rejection to rejected disposition", () => {
    const records = [
      event({
        id: "evt-worker-completed",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 1_000,
        payload: runPayload({
          runId: "worker-reject",
          agent: "worker",
          kind: "patch",
          status: "completed",
          updatedAt: 1_000,
          summary: "Prepared a patch.",
          patchSetId: "patch-worker-reject",
        }),
      }),
      event({
        id: "evt-worker-rejected",
        type: WORKER_RESULTS_REJECTED_EVENT_TYPE,
        timestamp: 1_100,
        payload: {
          workerIds: ["worker-reject"],
          reason: "Parent declined the patch.",
        },
      }),
    ];

    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });
    const replayState = projectSessionDelegationState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(inspection.runCards[0]).toMatchObject({
      runId: "worker-reject",
      disposition: "rejected",
    });
    expect(inspection.inbox.items).toHaveLength(0);
    expect(replayState.workerResults).toHaveLength(0);
  });

  test("maps timeout to failed lifecycle reason without exposing timeout status", () => {
    const records = [
      event({
        id: "evt-verifier-timeout",
        type: SUBAGENT_FAILED_EVENT_TYPE,
        timestamp: 2_000,
        payload: {
          ...runPayload({
            runId: "verifier-timeout",
            agent: "verifier",
            kind: "verifier",
            status: "failed",
            updatedAt: 2_000,
            error: "Timed out waiting for checks.",
          }),
          status: "timeout",
          reason: "timeout",
        },
      }),
    ];

    const replayState = projectSessionDelegationState({
      sessionId: "session-delegation-inspection",
      records,
    });
    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(replayState.runs[0]?.status).toBe("failed");
    expect(replayState.runs[0]?.record.status).toBe("failed");
    expect(replayState.runs[0]?.record.lifecycleReason).toBe("timeout");
    expect(JSON.stringify(inspection)).not.toContain('"lifecycle":"timeout"');
    expect(inspection.runCards[0]).toMatchObject({
      runId: "verifier-timeout",
      role: "verifier",
      lifecycle: "failed",
      lifecycleReason: "timeout",
      disposition: "unread",
    });
  });

  test("marks older verifier evidence as superseded advisory debt", () => {
    const records = [
      event({
        id: "evt-verifier-old",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 2_000,
        payload: runPayload({
          runId: "verifier-old",
          agent: "verifier",
          kind: "verifier",
          status: "completed",
          updatedAt: 2_000,
          summary: "Old verification evidence.",
        }),
      }),
      event({
        id: "evt-verifier-new",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 2_100,
        payload: {
          ...runPayload({
            runId: "verifier-new",
            agent: "verifier",
            kind: "verifier",
            status: "completed",
            updatedAt: 2_100,
            summary: "Fresh verification evidence.",
          }),
          taskPath: "/inspect/verifier",
        },
      }),
    ];

    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    const oldCard = inspection.runCards.find((card) => card.runId === "verifier-old");
    const newCard = inspection.runCards.find((card) => card.runId === "verifier-new");
    expect(oldCard).toMatchObject({
      disposition: "superseded",
      adoptionRequirement: "none",
    });
    expect(newCard).toMatchObject({ disposition: "unread" });
    expect(inspection.workboard.verificationDebt).toEqual([
      expect.objectContaining({ runId: "verifier-old", disposition: "superseded" }),
    ]);
    expect(inspection.inbox.items).toContainEqual(
      expect.objectContaining({
        kind: "verification_debt",
        runId: "verifier-old",
      }),
    );
  });

  test("projects librarian knowledge adoption without treating knowledge as durable authority", () => {
    const records = [
      event({
        id: "evt-librarian-completed",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 3_000,
        payload: runPayload({
          runId: "librarian-1",
          agent: "librarian",
          kind: "knowledge",
          status: "completed",
          updatedAt: 3_000,
          summary: "Found a reusable delegation precedent.",
        }),
      }),
      event({
        id: "evt-librarian-adopted",
        type: SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE,
        timestamp: 3_100,
        payload: {
          runId: "librarian-1",
          decision: "accept",
          reason: "Parent captured the precedent in docs.",
          artifactRefs: ["docs/solutions/delegation/example.md"],
        },
      }),
    ];

    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(inspection.runCards[0]).toMatchObject({
      runId: "librarian-1",
      role: "librarian",
      resultMode: "knowledge",
      adoptionRequirement: "knowledge_adopt",
      disposition: "adopted",
    });
    expect(inspection.inbox.items).toHaveLength(0);
  });

  test("maps librarian rejection and deferral decisions to role dispositions", () => {
    const records = [
      event({
        id: "evt-librarian-reject",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 3_000,
        payload: runPayload({
          runId: "librarian-reject",
          agent: "librarian",
          kind: "knowledge",
          status: "completed",
          updatedAt: 3_000,
          summary: "Rejected precedent.",
        }),
      }),
      event({
        id: "evt-librarian-defer",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 3_010,
        payload: runPayload({
          runId: "librarian-defer",
          agent: "librarian",
          kind: "knowledge",
          status: "completed",
          updatedAt: 3_010,
          summary: "Deferred precedent.",
        }),
      }),
      event({
        id: "evt-librarian-rejected",
        type: SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE,
        timestamp: 3_100,
        payload: {
          runId: "librarian-reject",
          decision: "reject",
          reason: "Outdated knowledge.",
        },
      }),
      event({
        id: "evt-librarian-deferred",
        type: SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE,
        timestamp: 3_110,
        payload: {
          runId: "librarian-defer",
          decision: "defer",
          reason: "Need a follow-up.",
        },
      }),
    ];

    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(inspection.runCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "librarian-reject", disposition: "rejected" }),
        expect.objectContaining({ runId: "librarian-defer", disposition: "deferred" }),
      ]),
    );
    expect(inspection.inbox.items).toHaveLength(0);
  });

  test("builds explicit-pull redacted timeline and recovery preview primitives", () => {
    const records = [
      event({
        id: "evt-worker-completed",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 4_000,
        payload: runPayload({
          runId: "worker-secret",
          agent: "worker",
          kind: "patch",
          status: "completed",
          updatedAt: 4_000,
          summary: "Patch contains a credential rotation.",
          patchSetId: "patch-secret",
        }),
      }),
      event({
        id: "evt-tool-call",
        type: "tool_call_ended",
        timestamp: 4_100,
        payload: {
          toolName: "exec",
          command: "printenv SECRET_TOKEN && echo done",
          output: "SECRET_TOKEN=abc123",
        },
      }),
      event({
        id: "evt-noise-approval",
        type: "preapproval_shadow_signal",
        timestamp: 4_110,
        payload: {
          summary: "This is not an approval receipt.",
        },
      }),
      event({
        id: "evt-approval-requested",
        type: "approval.requested",
        timestamp: 4_120,
        payload: {
          requestId: "approval-1",
        },
      }),
      event({
        id: "evt-source-applied",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 4_200,
        payload: {
          ok: true,
          patchSetId: "patch-secret",
          appliedPaths: ["src/file.ts"],
          failedPaths: [],
        },
      }),
    ];

    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(inspection.timeline.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "delegation",
          eventIds: ["evt-worker-completed"],
          canonicalRefs: ["event:evt-worker-completed", "delegation:worker-secret"],
        }),
        expect.objectContaining({
          kind: "tool",
          eventIds: ["evt-tool-call"],
          canonicalRefs: ["event:evt-tool-call"],
        }),
        expect.objectContaining({
          kind: "adoption",
          eventIds: ["evt-source-applied"],
          canonicalRefs: ["event:evt-source-applied"],
        }),
      ]),
    );
    expect(JSON.stringify(inspection.timeline)).not.toContain("abc123");
    expect(JSON.stringify(inspection.timeline)).not.toContain("printenv SECRET_TOKEN");
    expect(inspection.recoveryPreview.continuationAnchor).toEqual({
      kind: "event",
      id: "evt-source-applied",
    });
    expect(inspection.recoveryPreview.activeTrust).toMatchObject({
      toolCalls: 1,
      approvals: 1,
      mutations: 1,
    });
    expect(inspection.recoveryPreview.primitives).toEqual(
      expect.arrayContaining([
        { kind: "resume" },
        { kind: "rollback_last_patch" },
        {
          kind: "reject_adoption",
          target: "worker_patch",
          runId: "worker-secret",
        },
      ]),
    );
    expect(inspection.recoveryPreview.nextReceiptOwner).toBe("parent");
  });

  test("groups replay timeline events by turn and kind", () => {
    const records = [
      event({
        id: "evt-worker-1",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 5_000,
        payload: runPayload({
          runId: "worker-1",
          agent: "worker",
          kind: "patch",
          status: "completed",
          updatedAt: 5_000,
          summary: "First patch.",
        }),
      }),
      event({
        id: "evt-worker-2",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 5_010,
        payload: runPayload({
          runId: "worker-2",
          agent: "worker",
          kind: "patch",
          status: "completed",
          updatedAt: 5_010,
          summary: "Second patch.",
        }),
      }),
    ];

    const inspection = projectDelegationInspectionState({
      sessionId: "session-delegation-inspection",
      records,
    });

    expect(inspection.timeline.groups).toEqual([
      expect.objectContaining({
        kind: "delegation",
        eventIds: ["evt-worker-1", "evt-worker-2"],
        canonicalRefs: [
          "event:evt-worker-1",
          "delegation:worker-1",
          "event:evt-worker-2",
          "delegation:worker-2",
        ],
      }),
    ]);
  });
});
