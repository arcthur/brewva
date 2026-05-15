import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import {
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import {
  deriveWorkflowArtifacts,
  deriveWorkflowStatus,
  resolveWorkspaceRevision,
} from "@brewva/brewva-runtime/projection";

function event(input: {
  id: string;
  type: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: "workflow-determinism",
    type: input.type,
    timestamp: input.timestamp,
    payload: input.payload,
  } as BrewvaEventRecord;
}

function createGitWorkspace(revision: string): string {
  const workspace = mkdtempSync(join(tmpdir(), "brewva-workflow-revision-"));
  const gitDir = join(workspace, ".git");
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  writeFileSync(join(gitDir, "refs", "heads", "main"), `${revision}\n`, "utf8");
  return workspace;
}

describe("workflow projection determinism", () => {
  test("derives artifacts deterministically from the same unordered event input", () => {
    const events = [
      event({
        id: "event-b",
        type: WORKER_RESULTS_APPLIED_EVENT_TYPE,
        timestamp: 2_000,
        payload: {
          workerIds: ["worker-1"],
          appliedPaths: ["src/runtime.ts"],
        },
      }),
      event({
        id: "event-a",
        type: VERIFICATION_WRITE_MARKED_EVENT_TYPE,
        timestamp: 1_000,
        payload: {
          toolName: "edit",
        },
      }),
    ];

    const first = deriveWorkflowArtifacts(events);
    const second = deriveWorkflowArtifacts(structuredClone(events));

    expect(second).toEqual(first);
    expect(first.map((artifact) => artifact.artifactId)).toEqual([
      "wfart:worker_patch:event-b",
      "wfart:implementation:event-a",
    ]);
    expect(first.map((artifact) => artifact.producedAt)).toEqual([2_000, 1_000]);
  });

  test("derives status and workspace revision deterministically from the same inputs", () => {
    const revision = "0123456789abcdef0123456789abcdef01234567";
    const workspace = createGitWorkspace(revision);
    const events = [
      event({
        id: "event-a",
        type: VERIFICATION_WRITE_MARKED_EVENT_TYPE,
        timestamp: 1_000,
        payload: { toolName: "edit" },
      }),
      event({
        id: "event-b",
        type: WORKER_RESULTS_APPLIED_EVENT_TYPE,
        timestamp: 2_000,
        payload: { workerIds: ["worker-1"], appliedPaths: ["src/runtime.ts"] },
      }),
    ];

    expect(resolveWorkspaceRevision(workspace)).toBe(revision);
    expect(resolveWorkspaceRevision(workspace)).toBe(revision);

    const first = deriveWorkflowStatus({
      sessionId: "workflow-determinism",
      events,
      workspaceRoot: workspace,
    });
    const second = deriveWorkflowStatus({
      sessionId: "workflow-determinism",
      events: structuredClone(events),
      workspaceRoot: workspace,
    });

    expect(second).toEqual(first);
    expect(first.currentWorkspaceRevision).toBe(revision);
    expect(first.updatedAt).toBe(2_000);
  });

  test("derives verifier artifacts from verifier-prefixed and legacy qa subagent outputs", () => {
    const artifacts = deriveWorkflowArtifacts([
      event({
        id: "event-verifier",
        type: "subagent_completed",
        timestamp: 1_000,
        payload: {
          runId: "run-legacy-qa",
          delegate: "qa",
          skillName: "qa",
          kind: "qa",
          resultData: {
            qa_verdict: "fail",
            qa_report: "Legacy QA found a reproducible failure.",
            qa_findings: ["The browser flow still fails."],
            qa_checks: [
              {
                name: "browser flow",
                status: "fail",
                summary: "The login redirect stayed broken.",
                observed_output: "redirect loop",
              },
            ],
            qa_missing_evidence: ["mobile browser"],
          },
        },
      }),
      event({
        id: "event-verifier-current",
        type: "subagent_completed",
        timestamp: 2_000,
        payload: {
          runId: "run-verifier",
          delegate: "verifier",
          skillName: "verifier",
          kind: "verifier",
          resultData: {
            verifier_verdict: "pass",
            verifier_report: "Current verifier evidence passed.",
            verifier_checks: [
              {
                name: "unit gate",
                status: "pass",
                summary: "The focused test passed.",
                observed_output: "pass",
              },
            ],
          },
        },
      }),
    ]);

    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["verifier", "verifier"]);
    const legacyArtifact = artifacts.find(
      (artifact) => artifact.metadata?.runId === "run-legacy-qa",
    );
    const currentArtifact = artifacts.find(
      (artifact) => artifact.metadata?.runId === "run-verifier",
    );
    expect(legacyArtifact).toMatchObject({
      state: "blocked",
      metadata: {
        verifierVerdict: "fail",
        missingEvidence: ["mobile browser"],
      },
    });
    expect(currentArtifact).toMatchObject({
      state: "ready",
      metadata: {
        verifierVerdict: "pass",
      },
    });
    expect(legacyArtifact?.metadata?.coverageTexts).toContain(
      "legacy qa found a reproducible failure",
    );
    expect(currentArtifact?.metadata?.coverageTexts).toContain("current verifier evidence passed");
  });
});
