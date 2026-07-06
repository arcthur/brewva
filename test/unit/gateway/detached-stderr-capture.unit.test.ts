import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDetachedRunAdapter } from "../../../packages/brewva-gateway/src/delegation/background/detached-run-adapter.js";
import {
  readDetachedSubagentStderrTail,
  resolveDetachedSubagentRunDir,
  resolveDetachedSubagentSpecPath,
  type DetachedSubagentLiveState,
} from "../../../packages/brewva-gateway/src/delegation/background/protocol.js";

// Root-cause fix for the up5 `background_registry_missing`: a detached subagent
// child that crashes (early throw or its `main().catch`) console.error's the real
// reason, but the old `stdio: "ignore"` discarded it — so the parent could only
// ever report the generic marker. The child's stderr is now captured to a per-run
// `stderr.log` the parent can read.
describe("detached subagent stderr capture (background_registry_missing fix)", () => {
  test("a crashing child's stderr lands in the run's stderr.log, readable by the parent", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-detached-stderr-"));
    const runId = "run-crash-1";
    mkdirSync(resolveDetachedSubagentRunDir(workspaceRoot, runId), { recursive: true });

    // A child that mimics runner-main's `main().catch`: print the real reason, exit 1.
    const modulePath = join(workspaceRoot, "crashing-child.mjs");
    writeFileSync(
      modulePath,
      `console.error("resolve_execution_plan_failed: model_route_x"); process.exit(1);\n`,
    );
    const specPath = resolveDetachedSubagentSpecPath(workspaceRoot, runId);
    writeFileSync(specPath, "{}");

    const adapter = createDetachedRunAdapter();
    const child = adapter.start({
      modulePath,
      specPath,
      workspaceRoot,
      buildLiveState: (started): DetachedSubagentLiveState => ({
        schema: "brewva.subagent-run-live.v1",
        runId,
        parentSessionId: "parent-1",
        delegate: "explorer",
        pid: started.pid ?? 0,
        createdAt: 1,
        updatedAt: 1,
        status: "pending",
      }),
    });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const tail = readDetachedSubagentStderrTail(workspaceRoot, runId);
    expect(tail).toContain("resolve_execution_plan_failed: model_route_x");
  });

  test("no stderr → tail is null (parent falls back to the generic marker)", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-detached-stderr-"));
    expect(readDetachedSubagentStderrTail(workspaceRoot, "absent-run")).toBeNull();
  });
});
