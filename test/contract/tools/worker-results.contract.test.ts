import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createWorkerResultsApplyTool, createWorkerResultsMergeTool } from "@brewva/brewva-tools";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("worker-results-contract");
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

describe("worker results tools contract", () => {
  test("worker_results_merge reports conflicts without clearing worker state", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "worker-results-merge-conflict";

    runtime.session.recordWorkerResult(sessionId, {
      workerId: "worker-a",
      status: "ok",
      summary: "first patch",
      patches: {
        id: "ps-a",
        createdAt: Date.now(),
        changes: [{ path: "src/conflict.ts", action: "modify", diffText: "a" }],
      },
    });
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "worker-b",
      status: "ok",
      summary: "second patch",
      patches: {
        id: "ps-b",
        createdAt: Date.now(),
        changes: [{ path: "src/conflict.ts", action: "modify", diffText: "b" }],
      },
    });

    const tool = createWorkerResultsMergeTool({ runtime });
    const result = await tool.execute(
      "tc-worker-results-merge",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result)).toContain("Merge status: conflicts");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
    expect(runtime.session.listWorkerResults(sessionId)).toHaveLength(2);
  });

  test("worker_results_apply adopts a clean merged patch set into the parent workspace", async () => {
    const applyWorkspace = mkdtempSync(join(tmpdir(), "brewva-worker-results-apply-"));
    mkdirSync(join(applyWorkspace, "src"), { recursive: true });

    const beforeText = "export const workerValue = 'before';\n";
    const afterText = "export const workerValue = 'after';\n";
    const filePath = join(applyWorkspace, "src", "worker-value.ts");
    const artifactDir = join(
      applyWorkspace,
      ".orchestrator",
      "subagent-patch-artifacts",
      "worker-ps",
    );
    const artifactPath = join(artifactDir, "worker-value.ts");
    writeFileSync(filePath, beforeText, "utf8");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactPath, afterText, "utf8");

    const runtime = new BrewvaRuntime({ cwd: applyWorkspace });
    const sessionId = "worker-results-apply";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "worker-a",
      status: "ok",
      summary: "clean patch",
      patches: {
        id: "worker-ps",
        createdAt: Date.now(),
        changes: [
          {
            path: "src/worker-value.ts",
            action: "modify",
            beforeHash: sha256(beforeText),
            afterHash: sha256(afterText),
            artifactRef: ".orchestrator/subagent-patch-artifacts/worker-ps/worker-value.ts",
          },
        ],
      },
    });

    const tool = createWorkerResultsApplyTool({ runtime });
    const result = await tool.execute(
      "tc-worker-results-apply",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result)).toContain("# Worker Results Applied");
    expect((result.details as { status?: string } | undefined)?.status).toBe("applied");
    expect(
      (
        (result.details as { patchSet?: { id?: string } } | undefined)?.patchSet?.id ?? ""
      ).startsWith("merged_"),
    ).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(afterText);
    expect(runtime.session.listWorkerResults(sessionId)).toHaveLength(0);

    const rollback = runtime.tools.rollbackLastPatchSet(sessionId);
    expect(rollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(beforeText);
  });
});
