import { describe, expect, test } from "bun:test";
import { createRuntimeWithInternals } from "../helpers/runtime-internals.js";
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

const coldServiceKeys = [
  "verificationService",
  "fileChangeService",
  "mutationRollbackService",
  "parallelService",
  "resourceLeaseService",
  "toolGateService",
  "toolInvocationSpine",
  "credentialVaultService",
  "scheduleIntentService",
  "sessionWireService",
  "reasoningService",
] as const satisfies ReadonlyArray<keyof RuntimeInternals>;

function materializedColdServices(internals: RuntimeInternals): string[] {
  return coldServiceKeys.filter((key) => internals[key] !== undefined).toSorted();
}

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
    const { runtimeInstance, internals } = createRuntimeWithInternals({
      cwd: createTestWorkspace("runtime-assembly-hot-path"),
    });
    const runtime = runtimeInstance.hosted;
    const runtimeInternals = internals as RuntimeInternals;
    const counts = trackLazyFactoryCalls(runtimeInternals);

    expect(materializedColdServices(runtimeInternals)).toEqual([]);

    void runtime.inspect.cost.summary.get("assembly-s1");
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
    const { runtimeInstance, internals } = createRuntimeWithInternals({
      cwd: createTestWorkspace("runtime-assembly-cold-path"),
    });
    const runtime = runtimeInstance.hosted;
    const runtimeInternals = internals as RuntimeInternals;
    const counts = trackLazyFactoryCalls(runtimeInternals);

    runtime.inspect.tools.access.check("assembly-s2", "grep");
    expect(counts.get("createToolGateService")).toBe(1);
    expect(materializedColdServices(runtimeInternals)).toContain("toolGateService");

    runtime.authority.tools.resourceLeases.request("assembly-s2", {
      reason: "verify lazy resource-lease construction",
    });
    expect(counts.get("createResourceLeaseService")).toBe(1);
    expect(materializedColdServices(runtimeInternals)).toContain("resourceLeaseService");

    runtime.authority.tools.invocation.recordResult({
      sessionId: "assembly-s2",
      toolName: "grep",
      args: {},
      outputText: "ok",
      channelSuccess: true,
    });
    expect(counts.get("createToolInvocationSpine")).toBe(1);
    expect(materializedColdServices(runtimeInternals)).toContain("toolInvocationSpine");

    await runtime.authority.verification.checks.verify("assembly-s2");
    expect(counts.get("createVerificationService")).toBe(1);
    expect(materializedColdServices(runtimeInternals)).toContain("verificationService");

    runtime.operator.session.credentials.resolveBindings("assembly-s2", "exec");
    expect(counts.get("createCredentialVaultService")).toBe(1);
    expect(materializedColdServices(runtimeInternals)).toContain("credentialVaultService");

    void runtime.inspect.sessionWire.query("assembly-s2");
    expect(counts.get("createSessionWireService")).toBe(1);
    expect(materializedColdServices(runtimeInternals)).toContain("sessionWireService");
  });
});
