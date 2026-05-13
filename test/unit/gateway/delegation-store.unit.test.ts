import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort, BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-runtime/delegation";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createBrewvaRuntime(options).hosted;
}

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("delegation-store");
});

afterEach(() => {
  if (workspace) {
    cleanupWorkspace(workspace);
  }
});

function recordCompletedRun(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  runId: string;
  updatedAt: number;
  handoffState: "pending_parent_turn" | "surfaced";
  kind?: "consult";
  consultKind?: "review" | "design";
  delegate?: string;
}): void {
  input.runtime.extensions.hosted.events.record({
    sessionId: input.sessionId,
    type: "subagent_completed",
    timestamp: input.updatedAt,
    payload: {
      ...delegationLifecycleFields(),
      runId: input.runId,
      delegate: input.delegate ?? "advisor",
      status: "completed",
      kind: input.kind ?? "consult",
      consultKind: input.consultKind ?? "review",
      summary: `run:${input.runId}`,
      deliveryMode: "text_only",
      deliveryHandoffState: input.handoffState,
      deliveryUpdatedAt: input.updatedAt,
      deliveryReadyAt: input.updatedAt,
      deliverySurfacedAt: input.handoffState === "surfaced" ? input.updatedAt : null,
    },
  });
}

function delegationLifecycleFields() {
  return {
    contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
    executionPrimitive: "named" as const,
    visibility: "public" as const,
    isolationStrategy: "shared" as const,
    adoption: {
      contractId: "delegation-store-test",
      decision: "require_human" as const,
      reason: "Fixture record has not reached parent adoption.",
    },
  };
}

describe("HostedDelegationStore", () => {
  test("listPendingOutcomes applies limit after filtering pending handoffs", () => {
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-limit";

    for (let index = 0; index < 6; index += 1) {
      recordCompletedRun({
        runtime,
        sessionId,
        runId: `surfaced-${index}`,
        updatedAt: 100 + index,
        handoffState: "surfaced",
      });
    }

    recordCompletedRun({
      runtime,
      sessionId,
      runId: "pending-older",
      updatedAt: 50,
      handoffState: "pending_parent_turn",
    });

    const pending = store.listPendingOutcomes(sessionId, { limit: 1 });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.runId).toBe("pending-older");
    expect(pending[0]?.delivery?.handoffState).toBe("pending_parent_turn");
  });

  test("replays subagent_running as the live lifecycle transition", () => {
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-running";

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "subagent_spawned",
      timestamp: 100,
      payload: {
        ...delegationLifecycleFields(),
        runId: "run-1",
        delegate: "review",
        status: "pending",
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "subagent_running",
      timestamp: 110,
      payload: {
        ...delegationLifecycleFields(),
        runId: "run-1",
        delegate: "review",
        status: "running",
        childSessionId: "child-1",
      },
    });

    expect(store.getRun(sessionId, "run-1")).toMatchObject({
      runId: "run-1",
      status: "running",
      workerSessionId: "child-1",
    });
  });

  test("does not preserve removed delegated verification kinds in read models", () => {
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-no-legacy-verification";

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "subagent_completed",
      timestamp: 100,
      payload: {
        ...delegationLifecycleFields(),
        runId: "run-legacy-kind",
        delegate: "qa",
        status: "completed",
        kind: "verification",
        summary: "legacy verification run",
      },
    });

    expect(store.getRun(sessionId, "run-legacy-kind")).toMatchObject({
      runId: "run-legacy-kind",
      status: "completed",
      kind: undefined,
    });
  });

  test("rejects missing delegation contract versions", () => {
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-missing-contract-version";

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "subagent_spawned",
      timestamp: 100,
      payload: {
        runId: "run-missing-version",
        delegate: "advisor",
        status: "pending",
      },
    });

    expect(() => store.getRun(sessionId, "run-missing-version")).toThrow(
      "unsupported_delegation_contract_version:missing",
    );
  });

  test("rejects current-version records without adoption payloads", () => {
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-missing-adoption";

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "subagent_spawned",
      timestamp: 100,
      payload: {
        contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
        executionPrimitive: "named",
        visibility: "public",
        isolationStrategy: "shared",
        runId: "run-missing-adoption",
        delegate: "advisor",
        status: "pending",
      },
    });

    expect(() => store.getRun(sessionId, "run-missing-adoption")).toThrow(
      "invalid_delegation_contract:run-missing-adoption:missing_adoption",
    );
  });

  test("rejects current-version records with malformed adoption payloads", () => {
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-malformed-adoption";

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "subagent_spawned",
      timestamp: 100,
      payload: {
        contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
        executionPrimitive: "named",
        visibility: "public",
        isolationStrategy: "shared",
        adoption: {
          contractId: "delegation.test",
          decision: "allow",
        },
        runId: "run-malformed-adoption",
        delegate: "advisor",
        status: "pending",
      },
    });

    expect(() => store.getRun(sessionId, "run-malformed-adoption")).toThrow(
      "invalid_delegation_contract:run-malformed-adoption:missing_adoption",
    );
  });

  test("preserves canonical design consult kinds in read models", () => {
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const store = new HostedDelegationStore(runtime);
    const sessionId = "delegation-store-design-consult";

    recordCompletedRun({
      runtime,
      sessionId,
      runId: "run-design-consult",
      updatedAt: 100,
      handoffState: "surfaced",
      kind: "consult",
      consultKind: "design",
      delegate: "advisor",
    });

    expect(store.getRun(sessionId, "run-design-consult")).toMatchObject({
      runId: "run-design-consult",
      status: "completed",
      kind: "consult",
      consultKind: "design",
    });
  });
});
