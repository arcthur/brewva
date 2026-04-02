import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_EVENT_TYPE, type BrewvaEventRecord } from "@brewva/brewva-runtime";
import { ProjectionEngine } from "../../../packages/brewva-runtime/src/projection/engine.js";

function taskSpecEvent(input: {
  id: string;
  sessionId: string;
  goal: string;
  turn?: number;
  timestamp?: number;
}): BrewvaEventRecord {
  const timestamp = input.timestamp ?? Date.now();
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: TASK_EVENT_TYPE,
    turn: input.turn,
    timestamp,
    payload: {
      schema: "brewva.task.ledger.v1",
      kind: "spec_set",
      spec: {
        schema: "brewva.task.v1",
        goal: input.goal,
      },
    },
  };
}

function workingSnapshotPath(
  rootDir: string,
  sessionId: string,
  workingFile = "working.md",
): string {
  return join(
    rootDir,
    "sessions",
    `sess_${Buffer.from(sessionId, "utf8").toString("base64url")}`,
    workingFile,
  );
}

describe("projection engine", () => {
  test("publishes working projection when projection events are ingested", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-projection-engine-"));
    const engine = new ProjectionEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-1",
        sessionId: "projection-engine-session",
        goal: "Ship governance projection",
      }),
    );

    const snapshot = engine.refreshIfNeeded({
      sessionId: "projection-engine-session",
    });

    expect(snapshot).toBeDefined();
    expect(snapshot?.content).toContain("[WorkingProjection]");
    expect(snapshot?.content).toContain("Ship governance projection");

    const workingPath = workingSnapshotPath(workspace, "projection-engine-session");
    expect(existsSync(workingPath)).toBe(true);
    expect(readFileSync(workingPath, "utf8")).toContain("[WorkingProjection]");
  });

  test("rebuildSessionFromTape honors missing_only semantics", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-projection-engine-rebuild-"));
    const engine = new ProjectionEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });

    const sessionId = "projection-engine-rebuild";
    const events = [
      taskSpecEvent({
        id: "evt-task-spec-rebuild",
        sessionId,
        goal: "Rebuild projection from tape",
      }),
    ];

    const first = engine.rebuildSessionFromTape({
      sessionId,
      events,
      mode: "missing_only",
    });
    const second = engine.rebuildSessionFromTape({
      sessionId,
      events,
      mode: "missing_only",
    });

    expect(first.reason).toBe("replayed");
    expect(first.replayedEvents).toBe(1);
    expect(second.reason).toBe("already_present");
  });

  test("refresh rebuilds snapshot from persisted units when cache is cold", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-projection-engine-cold-refresh-"));
    const sessionId = "projection-engine-cold-refresh";

    const firstEngine = new ProjectionEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });
    firstEngine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-cold-refresh",
        sessionId,
        goal: "Rebuild working snapshot from persisted units",
      }),
    );
    firstEngine.refreshIfNeeded({ sessionId });

    rmSync(workingSnapshotPath(workspace, sessionId), { force: true });

    const secondEngine = new ProjectionEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });
    const rebuilt = secondEngine.refreshIfNeeded({ sessionId });

    expect(rebuilt).toBeDefined();
    expect(rebuilt?.content).toContain("Rebuild working snapshot from persisted units");
    expect(existsSync(workingSnapshotPath(workspace, sessionId))).toBe(true);
  });

  test("rebuilds workflow projection units from tape and preserves workflow state markers", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-projection-engine-workflow-"));
    const engine = new ProjectionEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2_000,
    });

    const sessionId = "projection-engine-workflow";
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-workflow-design",
        sessionId,
        type: "skill_completed",
        timestamp: 100,
        payload: {
          skillName: "design",
          outputKeys: [
            "design_spec",
            "execution_plan",
            "execution_mode_hint",
            "risk_register",
            "implementation_targets",
          ],
          outputs: {
            design_spec: "Lock the workflow artifact contract.",
            execution_plan: [
              {
                step: "Derive posture",
                intent: "Project canonical workflow state from durable events.",
                owner: "runtime.workflow",
                exit_criteria: "Workflow posture is derived without hidden control flow.",
                verification_intent:
                  "Unit coverage proves posture derivation remains advisory-only.",
              },
              {
                step: "Expose advisory context",
                intent: "Publish the workflow state through working projection surfaces.",
                owner: "runtime.context",
                exit_criteria: "Working projection contains stable workflow artifact statements.",
                verification_intent:
                  "Projection rebuild tests preserve workflow artifact statements after replay.",
              },
            ],
            execution_mode_hint: "coordinated_rollout",
            risk_register: [
              {
                risk: "Workflow projection could drift into hidden choreography.",
                category: "public_api",
                severity: "high",
                mitigation: "Keep workflow status advisory-only and inspectable.",
                required_evidence: ["workflow_projection_tests"],
                owner_lane: "review-boundaries",
              },
            ],
            implementation_targets: [
              {
                target: "packages/brewva-runtime/src/workflow/derivation.ts",
                kind: "module",
                owner_boundary: "runtime.workflow",
                reason: "Workflow artifact derivation is implemented here.",
              },
            ],
          },
        },
      },
      {
        id: "evt-workflow-write",
        sessionId,
        type: "verification_write_marked",
        timestamp: 110,
        payload: {
          toolName: "edit",
        },
      },
      {
        id: "evt-workflow-review",
        sessionId,
        type: "skill_completed",
        timestamp: 120,
        payload: {
          skillName: "review",
          outputKeys: ["review_report", "review_findings", "merge_decision"],
          outputs: {
            review_report: "Workflow chain is ready.",
            review_findings: [],
            merge_decision: "ready",
          },
        },
      },
    ];

    const rebuilt = engine.rebuildSessionFromTape({
      sessionId,
      events,
      mode: "always",
    });

    expect(rebuilt.reason).toBe("replayed");
    expect(rebuilt.replayedEvents).toBe(3);

    const snapshot = engine.getWorkingProjection(sessionId);
    expect(snapshot).toBeDefined();
    expect(snapshot?.content).toContain("[WorkingProjection]");
    expect(snapshot?.content).toContain(
      "workflow.design: state=ready; freshness=stale; Lock the workflow artifact contract.",
    );
    expect(snapshot?.content).toContain(
      "workflow.execution_plan: state=ready; freshness=stale; Execution plan with 2 step(s): Derive posture, Expose advisory context.",
    );
    expect(snapshot?.content).toContain(
      "workflow.implementation: state=ready; freshness=fresh; Workspace mutation observed via edit; downstream review and verification may need refresh.",
    );
    expect(snapshot?.content).toContain(
      "workflow.review: state=ready; freshness=fresh; decision=ready; Workflow chain is ready.",
    );
  });
});
