import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DelegationRunRecord } from "@brewva/brewva-vocabulary/delegation";
import { createDetachedSubagentBackgroundController } from "../../../packages/brewva-gateway/src/delegation/background/controller.js";
import type { DetachedRunAdapter } from "../../../packages/brewva-gateway/src/delegation/background/detached-run-adapter.js";
import { resolveDetachedSubagentSpecPath } from "../../../packages/brewva-gateway/src/delegation/background/protocol.js";
import type { HostedDelegationStore } from "../../../packages/brewva-gateway/src/delegation/delegation-store.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

// Regression for the up6 `background_registry_missing`: an in-process consult
// (orchestrator dispatchSubagent) shares the delegation store but is tracked in
// memory and never writes a detached spec/live.json. `inspectLiveRuns` reconciles
// EVERY stored record, so before the fix it read the consult's missing live.json
// and force-failed a still-running consult. The spec.json is the authoritative
// "this run is detached" mark; only a detached run may be terminalized here.

const PARENT = "parent-session";

function stubAdapter(): DetachedRunAdapter {
  // No live.json for any run — mirrors both an in-process consult (never writes
  // one) and a crashed detached child (left none behind).
  return {
    writeSpec: () => ({ specPath: "" }),
    start: () => {
      throw new Error("start is unused in the reconcile path");
    },
    requestCancel: () => {},
    readLiveState: () => [],
    readOutcome: () => undefined,
    cleanup: () => {},
  } as unknown as DetachedRunAdapter;
}

function runningRecord(runId: string): DelegationRunRecord {
  return {
    runId,
    parentSessionId: PARENT,
    status: "running",
    executionPrimitive: "named",
    isolationStrategy: "shared",
    visibility: "public",
    forkTurns: "none",
    createdAt: 1,
    updatedAt: 1,
  } as unknown as DelegationRunRecord;
}

function stubStore(record: DelegationRunRecord): HostedDelegationStore {
  return {
    listRuns: () => [record],
    getRun: () => record,
  } as unknown as HostedDelegationStore;
}

describe("reconcileLiveState separates in-process consult from detached run", () => {
  test("an in-process consult (no spec.json) stays live — never force-failed", async () => {
    const workspace = createTestWorkspace("reconcile-in-process");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const controller = createDetachedSubagentBackgroundController({
      runtime,
      delegationStore: stubStore(runningRecord("run-in-process")),
      detachedAdapter: stubAdapter(),
    });

    const map = await controller.inspectLiveRuns({ parentSessionId: PARENT });

    // Before the fix this was terminalized as `background_registry_missing`.
    expect(map.get("run-in-process")).toEqual({ live: true, cancelable: false });
  });

  test("a detached run (spec.json present, no live.json) is still terminalized as a crash", async () => {
    const workspace = createTestWorkspace("reconcile-detached");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    // A detached run owns a spec.json the lifecycle never deletes; write it so the
    // reconcile treats a missing live.json as a genuine crash.
    const specPath = resolveDetachedSubagentSpecPath(
      runtime.identity.workspaceRoot,
      "run-detached",
    );
    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, "{}");

    const controller = createDetachedSubagentBackgroundController({
      runtime,
      delegationStore: stubStore(runningRecord("run-detached")),
      detachedAdapter: stubAdapter(),
    });

    const map = await controller.inspectLiveRuns({ parentSessionId: PARENT });

    // A detached run with no live-state genuinely crashed — it must still fail.
    expect(map.get("run-detached")).toEqual({ live: false, cancelable: false });
  });
});
