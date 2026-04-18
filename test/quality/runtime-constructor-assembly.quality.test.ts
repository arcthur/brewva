import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../helpers/workspace.js";

type RuntimeLazyFactories = {
  createCredentialVaultService: () => unknown;
  createFileChangeService: () => unknown;
  createMutationRollbackService: () => unknown;
  createParallelService: () => unknown;
  createReasoningService: () => unknown;
  createResourceLeaseService: () => unknown;
  createScheduleIntentService: () => unknown;
  createSessionWireService: () => unknown;
  createToolGateService: () => unknown;
  createToolInvocationSpine: () => unknown;
  createVerificationService: () => unknown;
};

type RuntimeInternals = {
  lazyServiceFactories: RuntimeLazyFactories;
  verificationService?: unknown;
  fileChangeService?: unknown;
  mutationRollbackService?: unknown;
  parallelService?: unknown;
  resourceLeaseService?: unknown;
  toolGateService?: unknown;
  toolInvocationSpine?: unknown;
  credentialVaultService?: unknown;
  scheduleIntentService?: unknown;
  sessionWireService?: unknown;
  reasoningService?: unknown;
};

function trackLazyFactoryCalls(
  internals: RuntimeInternals,
): Map<keyof RuntimeLazyFactories, number> {
  const counts = new Map<keyof RuntimeLazyFactories, number>();
  for (const key of Object.keys(internals.lazyServiceFactories) as Array<
    keyof RuntimeLazyFactories
  >) {
    const original = internals.lazyServiceFactories[key];
    counts.set(key, 0);
    internals.lazyServiceFactories[key] = (() => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return original();
    }) as RuntimeLazyFactories[typeof key];
  }
  return counts;
}

describe("runtime constructor assembly guard", () => {
  test("does not instantiate cold-path services during construction or hot-path inspection", () => {
    const runtime = new BrewvaRuntime({ cwd: createTestWorkspace("runtime-assembly-hot-path") });
    const internals = runtime as unknown as RuntimeInternals;
    const counts = trackLazyFactoryCalls(internals);

    expect(internals.verificationService).toBeUndefined();
    expect(internals.fileChangeService).toBeUndefined();
    expect(internals.mutationRollbackService).toBeUndefined();
    expect(internals.parallelService).toBeUndefined();
    expect(internals.resourceLeaseService).toBeUndefined();
    expect(internals.toolGateService).toBeUndefined();
    expect(internals.toolInvocationSpine).toBeUndefined();
    expect(internals.credentialVaultService).toBeUndefined();
    expect(internals.scheduleIntentService).toBeUndefined();
    expect(internals.sessionWireService).toBeUndefined();
    expect(internals.reasoningService).toBeUndefined();

    void runtime.inspect.cost.getSummary("assembly-s1");
    void runtime.inspect.lifecycle.getSnapshot("assembly-s1");

    expect(counts.get("createSessionWireService")).toBe(1);

    for (const key of counts.keys()) {
      if (key === "createSessionWireService") {
        continue;
      }
      expect(counts.get(key)).toBe(0);
    }
  });

  test("instantiates cold-path services lazily when their surfaces are first used", async () => {
    const runtime = new BrewvaRuntime({ cwd: createTestWorkspace("runtime-assembly-cold-path") });
    const internals = runtime as unknown as RuntimeInternals;
    const counts = trackLazyFactoryCalls(internals);

    runtime.inspect.tools.checkAccess("assembly-s2", "grep");
    expect(counts.get("createToolGateService")).toBe(1);
    expect(internals.toolGateService).toBeDefined();

    runtime.authority.tools.requestResourceLease("assembly-s2", {
      reason: "verify lazy resource-lease construction",
    });
    expect(counts.get("createResourceLeaseService")).toBe(1);
    expect(internals.resourceLeaseService).toBeDefined();

    runtime.authority.tools.recordResult({
      sessionId: "assembly-s2",
      toolName: "grep",
      args: {},
      outputText: "ok",
      channelSuccess: true,
    });
    expect(counts.get("createToolInvocationSpine")).toBe(1);
    expect(internals.toolInvocationSpine).toBeDefined();

    await runtime.authority.verification.verify("assembly-s2");
    expect(counts.get("createVerificationService")).toBe(1);
    expect(internals.verificationService).toBeDefined();

    runtime.maintain.session.resolveCredentialBindings("assembly-s2", "exec");
    expect(counts.get("createCredentialVaultService")).toBe(1);
    expect(internals.credentialVaultService).toBeDefined();

    void runtime.inspect.sessionWire.query("assembly-s2");
    expect(counts.get("createSessionWireService")).toBe(1);
    expect(internals.sessionWireService).toBeDefined();
  });
});
