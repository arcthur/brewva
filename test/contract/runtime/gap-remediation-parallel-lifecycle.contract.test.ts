import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { requireNonEmptyString } from "../../helpers/assertions.js";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("gap-remediation-contract");
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});

function createCleanRuntime(cwd = workspace): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd,
    config: createRuntimeConfig(),
  });
}

describe("Gap remediation: parallel result lifecycle", () => {
  test("detects patch conflicts and supports merged patchset", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "parallel-1";

    runtime.maintain.session.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "a" }],
      },
    });
    runtime.maintain.session.recordWorkerResult(sessionId, {
      workerId: "w2",
      status: "ok",
      summary: "worker-2",
      patches: {
        id: "ps-2",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "b" }],
      },
    });

    const listedBeforeMerge = runtime.inspect.session.listWorkerResults(sessionId);
    expect(listedBeforeMerge.map((result) => result.workerId)).toEqual(["w1", "w2"]);

    const conflictReport = runtime.inspect.session.mergeWorkerResults(sessionId);
    expect(conflictReport.status).toBe("conflicts");
    expect(conflictReport.conflicts.length).toBe(1);

    runtime.maintain.session.clearWorkerResults(sessionId);
    expect(runtime.inspect.session.listWorkerResults(sessionId)).toHaveLength(0);
    runtime.maintain.session.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "a" }],
      },
    });
    runtime.maintain.session.recordWorkerResult(sessionId, {
      workerId: "w2",
      status: "ok",
      summary: "worker-2",
      patches: {
        id: "ps-2",
        createdAt: Date.now(),
        changes: [{ path: "src/b.ts", action: "modify", diffText: "b" }],
      },
    });

    const listedAfterReset = runtime.inspect.session.listWorkerResults(sessionId);
    expect(listedAfterReset.map((result) => result.workerId)).toEqual(["w1", "w2"]);

    const mergedReport = runtime.inspect.session.mergeWorkerResults(sessionId);
    expect(mergedReport.status).toBe("merged");
    expect(mergedReport.mergedPatchSet?.changes.length).toBe(2);
  });

  test("applies a clean merged worker patchset through the public session API", async () => {
    const applyWorkspace = createWorkspace("parallel-apply");
    writeConfig(applyWorkspace, createConfig({}));
    mkdirSync(join(applyWorkspace, "src"), { recursive: true });

    const beforeText = "export const value = 'before';\n";
    const afterText = "export const value = 'after';\n";
    const filePath = join(applyWorkspace, "src/value.ts");
    writeFileSync(filePath, beforeText, "utf8");

    const artifactDir = join(
      applyWorkspace,
      ".orchestrator",
      "subagent-patch-artifacts",
      "ps-apply",
    );
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "value.ts");
    writeFileSync(artifactPath, afterText, "utf8");

    const runtime = new BrewvaRuntime({
      cwd: applyWorkspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    const sessionId = "parallel-apply-1";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    runtime.maintain.session.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-apply",
        createdAt: Date.now(),
        changes: [
          {
            path: "src/value.ts",
            action: "modify",
            beforeHash: sha256(beforeText),
            afterHash: sha256(afterText),
            artifactRef: ".orchestrator/subagent-patch-artifacts/ps-apply/value.ts",
          },
        ],
      },
    });

    const report = runtime.authority.session.applyMergedWorkerResults(sessionId, {
      toolName: "worker_results_apply",
      toolCallId: "tc-worker-apply-1",
    });

    expect(report.status).toBe("applied");
    if (report.status !== "applied") {
      throw new Error("expected applied worker report");
    }
    requireNonEmptyString(report.appliedPatchSetId, "missing applied patch set id");
    expect(report.appliedPaths).toEqual(["src/value.ts"]);
    expect(readFileSync(filePath, "utf8")).toBe(afterText);
    expect(runtime.inspect.session.listWorkerResults(sessionId)).toHaveLength(0);

    const appliedEvents = runtime.inspect.events.query(sessionId, {
      type: "worker_results_applied",
      last: 1,
    });
    expect(appliedEvents).toHaveLength(1);
    expect(appliedEvents[0]?.payload?.workerId).toBe("w1");
    expect(appliedEvents[0]?.payload?.workerIds).toEqual(["w1"]);

    const rollback = runtime.authority.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(beforeText);
  });

  test("keeps worker results intact when merged patch application cannot resolve artifacts", async () => {
    const missingArtifactWorkspace = createWorkspace("parallel-apply-missing-artifact");
    writeConfig(missingArtifactWorkspace, createConfig({}));
    mkdirSync(join(missingArtifactWorkspace, "src"), { recursive: true });

    const beforeText = "export const value = 1;\n";
    const filePath = join(missingArtifactWorkspace, "src/value.ts");
    writeFileSync(filePath, beforeText, "utf8");

    const runtime = new BrewvaRuntime({
      cwd: missingArtifactWorkspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    const sessionId = "parallel-apply-missing-artifact-1";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    runtime.maintain.session.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-missing",
        createdAt: Date.now(),
        changes: [
          {
            path: "src/value.ts",
            action: "modify",
            beforeHash: sha256(beforeText),
            afterHash: sha256("export const value = 2;\n"),
            artifactRef: ".orchestrator/subagent-patch-artifacts/ps-missing/value.ts",
          },
        ],
      },
    });

    const report = runtime.authority.session.applyMergedWorkerResults(sessionId, {
      toolName: "worker_results_apply",
      toolCallId: "tc-worker-apply-missing",
    });

    expect(report.status).toBe("apply_failed");
    if (report.status !== "apply_failed") {
      throw new Error("expected apply_failed worker report");
    }
    expect(report.reason).toBe("missing_artifact");
    expect(readFileSync(filePath, "utf8")).toBe(beforeText);
    expect(runtime.inspect.session.listWorkerResults(sessionId)).toHaveLength(1);

    const failedEvents = runtime.inspect.events.query(sessionId, {
      type: "worker_results_apply_failed",
      last: 1,
    });
    expect(failedEvents).toHaveLength(1);
  });

  test("rehydrates delegated patch worker results from durable patch manifests after restart", async () => {
    const rehydrateWorkspace = createWorkspace("parallel-rehydrate-delegation");
    writeConfig(rehydrateWorkspace, createConfig({}));
    mkdirSync(join(rehydrateWorkspace, "src"), { recursive: true });

    const beforeText = "export const value = 'before';\n";
    const afterText = "export const value = 'after';\n";
    const sessionId = "parallel-rehydrate-delegation-1";
    const filePath = join(rehydrateWorkspace, "src", "value.ts");
    writeFileSync(filePath, beforeText, "utf8");

    const patchSetId = "patch_rehydrate";
    const artifactDir = join(
      rehydrateWorkspace,
      ".orchestrator",
      "subagent-patch-artifacts",
      patchSetId,
    );
    mkdirSync(artifactDir, { recursive: true });
    const patchFileRef = `.orchestrator/subagent-patch-artifacts/${patchSetId}/value.ts`;
    writeFileSync(join(artifactDir, "value.ts"), afterText, "utf8");
    const patchManifestRef = `.orchestrator/subagent-patch-artifacts/${patchSetId}/patchset.json`;
    writeFileSync(
      join(artifactDir, "patchset.json"),
      JSON.stringify(
        {
          id: patchSetId,
          createdAt: Date.now(),
          summary: "Detached subagent patch result",
          changes: [
            {
              path: "src/value.ts",
              action: "modify",
              beforeHash: sha256(beforeText),
              afterHash: sha256(afterText),
              artifactRef: patchFileRef,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const writer = new BrewvaRuntime({
      cwd: rehydrateWorkspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    recordRuntimeEvent(writer, {
      sessionId,
      type: "subagent_completed",
      payload: {
        runId: "delegated-patch-1",
        delegate: "patch-worker",
        kind: "patch",
        status: "completed",
        summary: "Detached patch worker finished.",
        artifactRefs: [
          {
            kind: "patch_manifest",
            path: patchManifestRef,
          },
          {
            kind: "patch_file",
            path: patchFileRef,
          },
        ],
      },
    });

    const restarted = new BrewvaRuntime({
      cwd: rehydrateWorkspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    restarted.maintain.context.onTurnStart(sessionId, 1);

    const workerResults = restarted.inspect.session.listWorkerResults(sessionId);
    expect(workerResults).toHaveLength(1);
    expect(workerResults[0]).toMatchObject({
      workerId: "delegated-patch-1",
      status: "ok",
    });

    const report = restarted.authority.session.applyMergedWorkerResults(sessionId, {
      toolName: "worker_results_apply",
      toolCallId: "tc-worker-apply-rehydrated",
    });

    expect(report.status).toBe("applied");
    expect(readFileSync(filePath, "utf8")).toBe(afterText);
  });
});
