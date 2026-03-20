import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("Gap remediation: parallel result lifecycle", () => {
  test("detects patch conflicts and supports merged patchset", async () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "parallel-1";

    runtime.session.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "a" }],
      },
    });
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "w2",
      status: "ok",
      summary: "worker-2",
      patches: {
        id: "ps-2",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "b" }],
      },
    });

    const listedBeforeMerge = runtime.session.listWorkerResults(sessionId);
    expect(listedBeforeMerge.map((result) => result.workerId)).toEqual(["w1", "w2"]);

    const conflictReport = runtime.session.mergeWorkerResults(sessionId);
    expect(conflictReport.status).toBe("conflicts");
    expect(conflictReport.conflicts.length).toBe(1);

    runtime.session.clearWorkerResults(sessionId);
    expect(runtime.session.listWorkerResults(sessionId)).toHaveLength(0);
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "a" }],
      },
    });
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "w2",
      status: "ok",
      summary: "worker-2",
      patches: {
        id: "ps-2",
        createdAt: Date.now(),
        changes: [{ path: "src/b.ts", action: "modify", diffText: "b" }],
      },
    });

    const listedAfterReset = runtime.session.listWorkerResults(sessionId);
    expect(listedAfterReset.map((result) => result.workerId)).toEqual(["w1", "w2"]);

    const mergedReport = runtime.session.mergeWorkerResults(sessionId);
    expect(mergedReport.status).toBe("merged");
    expect(mergedReport.mergedPatchSet?.changes.length).toBe(2);
  });

  test("applies a clean merged worker patchset through the public session API", async () => {
    const workspace = createWorkspace("parallel-apply");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const beforeText = "export const value = 'before';\n";
    const afterText = "export const value = 'after';\n";
    const filePath = join(workspace, "src/value.ts");
    writeFileSync(filePath, beforeText, "utf8");

    const artifactDir = join(workspace, ".orchestrator", "subagent-patch-artifacts", "ps-apply");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "value.ts");
    writeFileSync(artifactPath, afterText, "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "parallel-apply-1";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.session.recordWorkerResult(sessionId, {
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

    const report = runtime.session.applyMergedWorkerResults(sessionId, {
      toolName: "worker_results_apply",
      toolCallId: "tc-worker-apply-1",
    });

    expect(report.status).toBe("applied");
    expect(report.appliedPatchSetId).toBeDefined();
    expect(report.appliedPaths).toEqual(["src/value.ts"]);
    expect(readFileSync(filePath, "utf8")).toBe(afterText);
    expect(runtime.session.listWorkerResults(sessionId)).toHaveLength(0);

    const appliedEvents = runtime.events.query(sessionId, {
      type: "worker_results_applied",
      last: 1,
    });
    expect(appliedEvents).toHaveLength(1);

    const rollback = runtime.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(beforeText);
  });

  test("keeps worker results intact when merged patch application cannot resolve artifacts", async () => {
    const workspace = createWorkspace("parallel-apply-missing-artifact");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const beforeText = "export const value = 1;\n";
    const filePath = join(workspace, "src/value.ts");
    writeFileSync(filePath, beforeText, "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "parallel-apply-missing-artifact-1";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.session.recordWorkerResult(sessionId, {
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

    const report = runtime.session.applyMergedWorkerResults(sessionId, {
      toolName: "worker_results_apply",
      toolCallId: "tc-worker-apply-missing",
    });

    expect(report.status).toBe("apply_failed");
    expect(report.reason).toBe("missing_artifact");
    expect(readFileSync(filePath, "utf8")).toBe(beforeText);
    expect(runtime.session.listWorkerResults(sessionId)).toHaveLength(1);

    const failedEvents = runtime.events.query(sessionId, {
      type: "worker_results_apply_failed",
      last: 1,
    });
    expect(failedEvents).toHaveLength(1);
  });

  test("rehydrates delegated patch worker results from durable patch manifests after restart", async () => {
    const workspace = createWorkspace("parallel-rehydrate-delegation");
    writeConfig(workspace, createConfig({}));
    mkdirSync(join(workspace, "src"), { recursive: true });

    const beforeText = "export const value = 'before';\n";
    const afterText = "export const value = 'after';\n";
    const sessionId = "parallel-rehydrate-delegation-1";
    const filePath = join(workspace, "src", "value.ts");
    writeFileSync(filePath, beforeText, "utf8");

    const patchSetId = "patch_rehydrate";
    const artifactDir = join(workspace, ".orchestrator", "subagent-patch-artifacts", patchSetId);
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

    const writer = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    writer.events.record({
      sessionId,
      type: "subagent_completed",
      payload: {
        runId: "delegated-patch-1",
        profile: "patch-worker",
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
      cwd: workspace,
      configPath: GAP_REMEDIATION_CONFIG_PATH,
    });
    restarted.context.onTurnStart(sessionId, 1);

    const workerResults = restarted.session.listWorkerResults(sessionId);
    expect(workerResults).toHaveLength(1);
    expect(workerResults[0]).toMatchObject({
      workerId: "delegated-patch-1",
      status: "ok",
    });

    const report = restarted.session.applyMergedWorkerResults(sessionId, {
      toolName: "worker_results_apply",
      toolCallId: "tc-worker-apply-rehydrated",
    });

    expect(report.status).toBe("applied");
    expect(readFileSync(filePath, "utf8")).toBe(afterText);
  });
});
