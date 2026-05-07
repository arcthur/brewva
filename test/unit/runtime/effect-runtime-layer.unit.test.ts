import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaEffect, BrewvaRuntimeScope, runSyncAtBoundary } from "@brewva/brewva-effect";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  RuntimeConfigService,
  RuntimeCoreDependenciesService,
  RuntimeIdentityService,
  RuntimeInfrastructureConfigService,
  RuntimeKernelService,
  RuntimeLazyServiceFactoriesService,
  RuntimeScheduleConfigService,
  RuntimeSecurityConfigService,
  RuntimeServiceDependenciesService,
  getRuntimeEffectSpine,
  getRuntimeEffectLayer,
  runRuntimeEffectSync,
} from "@brewva/brewva-runtime/runtime-effect";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";

describe("runtime Effect layer", () => {
  test("provides identity, typed config services, and registrar-built runtime services", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-runtime-effect-layer-"));
    const config = createOpsRuntimeConfig((draft) => {
      draft.schedule.enabled = true;
      draft.schedule.minIntervalMs = 1_234;
      draft.security.mode = "strict";
      draft.infrastructure.events.level = "debug";
    });
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      agentId: "Runtime Layer Agent",
      config,
    });

    const snapshot = runSyncAtBoundary(
      BrewvaEffect.gen(function* () {
        const identity = yield* RuntimeIdentityService;
        const runtimeScope = yield* BrewvaRuntimeScope;
        const runtimeConfig = yield* RuntimeConfigService;
        const securityConfig = yield* RuntimeSecurityConfigService;
        const infrastructureConfig = yield* RuntimeInfrastructureConfigService;
        const scheduleConfig = yield* RuntimeScheduleConfigService;
        const core = yield* RuntimeCoreDependenciesService;
        const kernel = yield* RuntimeKernelService;
        const services = yield* RuntimeServiceDependenciesService;
        const factories = yield* RuntimeLazyServiceFactoriesService;

        return {
          identity,
          runtimeScope,
          runtimeConfig,
          securityConfig,
          infrastructureConfig,
          scheduleConfig,
          hasEventStore: typeof core.eventStore.list === "function",
          kernelAgentId: kernel.agentId,
          serviceKeys: Object.keys(services).toSorted(),
          hasCredentialFactory: typeof factories.createCredentialVaultService === "function",
        };
      }).pipe(BrewvaEffect.provide(getRuntimeEffectLayer(runtime))),
    );

    expect(snapshot.identity.cwd).toBe(workspace);
    expect(snapshot.identity.workspaceRoot).toBe(workspace);
    expect(snapshot.identity.agentId).toBe("runtime-layer-agent");
    expect(snapshot.runtimeScope.runtimeId).toBe(`runtime-layer-agent@${workspace}`);
    expect(snapshot.runtimeScope.agentId).toBe("runtime-layer-agent");
    expect(snapshot.runtimeScope.workspaceRoot).toBe(workspace);
    expect(snapshot.runtimeConfig.config).toBe(runtime.config);
    expect(snapshot.runtimeConfig.config.schedule.minIntervalMs).toBe(1_234);
    expect(snapshot.securityConfig.mode).toBe("strict");
    expect(snapshot.infrastructureConfig.events.level).toBe("debug");
    expect(snapshot.scheduleConfig.enabled).toBe(true);
    expect(snapshot.hasEventStore).toBe(true);
    expect(snapshot.kernelAgentId).toBe("runtime-layer-agent");
    expect(snapshot.hasCredentialFactory).toBe(true);
    expect(snapshot.serviceKeys).toContain("eventPipeline");
    expect(snapshot.serviceKeys).not.toContain("authority");
    expect(snapshot.serviceKeys).not.toContain("inspect");
    expect(snapshot.serviceKeys).not.toContain("maintain");
  });

  test("exposes a memoized runtime spine for internal Effect programs", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-runtime-effect-spine-"));
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      agentId: "Runtime Spine Agent",
      config: createOpsRuntimeConfig(),
    });

    const spine = getRuntimeEffectSpine(runtime);
    expect(getRuntimeEffectSpine(runtime)).toBe(spine);
    expect(spine.layer).toBe(getRuntimeEffectLayer(runtime));

    const first = spine.runSync(
      BrewvaEffect.gen(function* () {
        const core = yield* RuntimeCoreDependenciesService;
        const services = yield* RuntimeServiceDependenciesService;
        return { core, services };
      }),
    );
    const second = runRuntimeEffectSync(
      runtime,
      BrewvaEffect.gen(function* () {
        const core = yield* RuntimeCoreDependenciesService;
        const services = yield* RuntimeServiceDependenciesService;
        return { core, services };
      }),
    );

    expect(second.core).toBe(first.core);
    expect(second.services).toBe(first.services);
    expect(Object.keys(second.services)).not.toContain("authority");
    expect(Object.keys(second.services)).not.toContain("inspect");
    expect(Object.keys(second.services)).not.toContain("maintain");
  });
});
