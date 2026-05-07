import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const runtimeSrcRoot = resolve(repoRoot, "packages/brewva-runtime/src");
const runtimeDomainRoot = resolve(runtimeSrcRoot, "domain");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

function collectSourceFiles(relativePath: string): string[] {
  const out: string[] = [];
  const walk = (absolutePath: string): void => {
    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
      const entryPath = resolve(absolutePath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/u.test(entry.name)) {
        out.push(entryPath);
      }
    }
  };
  walk(resolve(repoRoot, relativePath));
  return out;
}

function resolveDomainTarget(sourceFile: string, specifier: string): string | undefined {
  const candidate = resolve(sourceFile, "..", specifier.replace(/\.js$/u, ".ts"));
  return candidate.startsWith(`${runtimeDomainRoot}/`) ? candidate : undefined;
}

function collectCrossDomainSpecifierOffenders(
  sourceFiles: readonly string[],
  allowedTargetBaseNames: readonly string[],
): string[] {
  const allowed = new Set(allowedTargetBaseNames);
  const offenders = new Set<string>();
  const pattern = /(?:import|export)(?:\s+type)?[\s\S]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']/gu;

  for (const sourceFile of sourceFiles) {
    const relativeSource = sourceFile.replace(`${runtimeSrcRoot}/`, "");
    const sourceMatch = relativeSource.match(/^domain\/([^/]+)\//u);
    const sourceDomain = sourceMatch?.[1] ?? null;
    const source = readFileSync(sourceFile, "utf-8");

    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      const target = resolveDomainTarget(sourceFile, specifier);
      if (!target) {
        continue;
      }
      const relativeTarget = target.replace(`${runtimeDomainRoot}/`, "");
      const targetParts = relativeTarget.split("/");
      const targetDomain = targetParts[0] ?? null;
      const targetBaseName = targetParts.at(-1);
      if (!targetDomain || !targetBaseName || targetDomain === sourceDomain) {
        continue;
      }
      if (!allowed.has(targetBaseName)) {
        offenders.add(sourceFile);
      }
    }
  }

  return [...offenders].toSorted();
}

describe("runtime promoted architecture guard", () => {
  test("runtime public entry stays explicit while the root index stays a thin stub", () => {
    const indexSource = readRepoFile("packages/brewva-runtime/src/index.ts");
    const coreSource = readRepoFile("packages/brewva-runtime/src/core.ts");
    const publicIndexSource = readRepoFile("packages/brewva-runtime/src/public/index.ts");
    const channelsSource = readRepoFile("packages/brewva-runtime/src/channels.ts");
    const markdownSource = readRepoFile("packages/brewva-runtime/src/markdown.ts");
    const eventsSource = readRepoFile("packages/brewva-runtime/src/events.ts");

    expect(indexSource.trim()).toBe('export * from "./public/index.js";');
    expect(coreSource).not.toMatch(/export \* from /u);
    expect(publicIndexSource).not.toContain("../contracts/index.js");
    expect(publicIndexSource).not.toContain("../contracts/shared.js");
    expect(publicIndexSource).not.toContain("../contracts/identifiers.js");
    expect(publicIndexSource).not.toMatch(/export \* from "\.\.\/contracts\//);
    expect(publicIndexSource).not.toMatch(/export \* from /u);
    expect(publicIndexSource).toContain("../core/index.js");
    expect(publicIndexSource).not.toContain("getSemanticArtifactOutputContract");
    expect(publicIndexSource).not.toContain("renderSemanticArtifactExample");
    expect(publicIndexSource).not.toContain("../events/registry.js");
    expect(publicIndexSource).not.toContain("../events/descriptors.js");
    expect(publicIndexSource).not.toContain("../contracts/events.js");
    expect(publicIndexSource).not.toContain("../evidence/tsc.js");
    expect(publicIndexSource).toContain("../domain/delegation/adoption.js");
    expect(publicIndexSource).toContain("../domain/reasoning/revert-summary.js");
    expect(publicIndexSource).toContain("../domain/skills/semantic-artifacts.js");
    expect(publicIndexSource).toContain("../domain/skills/repair-policy.js");
    expect(channelsSource).not.toMatch(/export \* from /u);
    expect(markdownSource).not.toMatch(/export \* from /u);
    expect(eventsSource).not.toMatch(/export \* from /u);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/index.ts"))).toBe(
      false,
    );
  });

  test("runtime facade no longer imports legacy assembler or method-group layers", () => {
    const runtimeSource = readRepoFile("packages/brewva-runtime/src/runtime/runtime.ts");
    const runtimeCompositionSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/runtime-composition.ts",
    );
    const runtimeEffectLayerSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/effect-runtime-layer.ts",
    );
    const servicesRegistrarSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/services-registrar.ts",
    );
    const governanceRegistrarSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/governance-service-registrar.ts",
    );
    const workRegistrarSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/work-service-registrar.ts",
    );
    const contextRegistrarSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/context-service-registrar.ts",
    );
    const sessionRegistrarSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/session-service-registrar.ts",
    );
    const surfacesSource = readRepoFile("packages/brewva-runtime/src/runtime/runtime-surfaces.ts");
    const runtimeFacadeStateSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/runtime-facade-state.ts",
    );
    const eventsSurfaceSource = readRepoFile(
      "packages/brewva-runtime/src/domain/events/runtime-surface.ts",
    );
    const tapeSurfaceSource = readRepoFile(
      "packages/brewva-runtime/src/domain/tape/runtime-surface.ts",
    );
    const runtimeHelpersSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/runtime-helpers.ts",
    );
    const eventDescriptorsSource = readRepoFile(
      "packages/brewva-runtime/src/events/descriptors.ts",
    );
    const sessionEventDescriptorsSource = readRepoFile(
      "packages/brewva-runtime/src/domain/sessions/event-descriptors.ts",
    );
    const toolsEventDescriptorsSource = readRepoFile(
      "packages/brewva-runtime/src/domain/tools/event-descriptors.ts",
    );
    const lazyRegistrarSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/lazy-service-registrar.ts",
    );
    const registrarTypesSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/service-registrar-types.ts",
    );

    expect(runtimeSource).not.toContain("./runtime-assembler.js");
    expect(runtimeSource).not.toContain("./runtime-method-groups.js");
    expect(runtimeSource).not.toContain("bindMethods(");
    expect(runtimeSource).not.toMatch(/from "\.\.\/services\/(?!event-pipeline|session-state)/u);
    expect(runtimeSource.split("\n").length).toBeLessThan(120);
    expect(runtimeFacadeStateSource).toContain("./runtime-composition.js");
    expect(runtimeFacadeStateSource).toContain("./effect-runtime-layer.js");
    expect(runtimeFacadeStateSource).toContain("./runtime-surfaces.js");
    expect(runtimeFacadeStateSource).toContain("./runtime-config-state.js");
    expect(runtimeFacadeStateSource).not.toContain("../config/loader.js");
    expect(runtimeFacadeStateSource).not.toContain("../core/freeze.js");
    expect(runtimeFacadeStateSource).not.toContain("../channels/recovery-wal-recovery.js");
    expect(runtimeCompositionSource).not.toContain("./effect-runtime-layer.js");
    expect(runtimeCompositionSource).not.toContain("registerRuntimeCoreDependencies(");
    expect(runtimeCompositionSource).not.toContain("registerRuntimeKernelContext(");
    expect(runtimeCompositionSource).not.toContain("registerRuntimeServiceDependencies(");
    expect(runtimeCompositionSource).not.toContain("registerRuntimeLazyServiceFactories(");
    expect(runtimeCompositionSource).not.toMatch(/from "\.\.\/services\//u);
    expect(runtimeCompositionSource.split("\n").length).toBeLessThan(150);
    expect(runtimeEffectLayerSource).toContain("./core-registrar.js");
    expect(runtimeEffectLayerSource).toContain("./kernel-registrar.js");
    expect(runtimeEffectLayerSource).toContain("./services-registrar.js");
    expect(runtimeEffectLayerSource).toContain("registerRuntimeCoreDependencies(");
    expect(runtimeEffectLayerSource).toContain("registerRuntimeKernelContext(");
    expect(runtimeEffectLayerSource).toContain("registerRuntimeServiceDependencies(");
    expect(runtimeEffectLayerSource).toContain("registerRuntimeLazyServiceFactories(");
    expect(runtimeEffectLayerSource).not.toMatch(/from "\.\.\/services\//u);
    expect(servicesRegistrarSource).toContain("./governance-service-registrar.js");
    expect(servicesRegistrarSource).toContain("./work-service-registrar.js");
    expect(servicesRegistrarSource).toContain("./context-service-registrar.js");
    expect(servicesRegistrarSource).toContain("./session-service-registrar.js");
    expect(servicesRegistrarSource).toContain("./lazy-service-registrar.js");
    expect(servicesRegistrarSource).not.toMatch(/from "\.\.\/services\//u);
    expect(servicesRegistrarSource.split("\n").length).toBeLessThan(90);
    expect(governanceRegistrarSource).toContain("../domain/proposals/api.js");
    expect(governanceRegistrarSource).not.toContain("../services/effect-commitment-desk.js");
    expect(governanceRegistrarSource).not.toContain("../services/proposal-admission.js");
    expect(workRegistrarSource).toContain("../domain/task/api.js");
    expect(workRegistrarSource).toContain("../domain/skills/api.js");
    expect(workRegistrarSource).toContain("../domain/truth/api.js");
    expect(workRegistrarSource).toContain("../domain/ledger/api.js");
    expect(workRegistrarSource).toContain("../domain/cost/api.js");
    expect(workRegistrarSource).not.toContain("../domain/task/task.js");
    expect(workRegistrarSource).not.toContain("../domain/skills/skill-lifecycle.js");
    expect(workRegistrarSource).not.toContain("../domain/truth/truth.js");
    expect(workRegistrarSource).not.toContain("../domain/ledger/ledger.js");
    expect(workRegistrarSource).not.toContain("../domain/cost/cost.js");
    expect(contextRegistrarSource).toContain("../domain/context/api.js");
    expect(contextRegistrarSource).not.toContain("../domain/context/context.js");
    expect(contextRegistrarSource).not.toContain("../domain/task/task-watchdog.js");
    expect(sessionRegistrarSource).toContain("../domain/sessions/api.js");
    expect(sessionRegistrarSource).not.toContain("../services/event-pipeline.js");
    expect(sessionRegistrarSource).not.toContain("../services/session-lifecycle.js");
    expect(sessionRegistrarSource).not.toContain("../services/tape.js");
    expect(sessionRegistrarSource).not.toContain("../services/tool-lifecycle-recovery-wal.js");
    expect(surfacesSource).toContain("../domain/context/api.js");
    expect(surfacesSource).toContain("../domain/tools/api.js");
    expect(surfacesSource).not.toContain("../tools/runtime-surface.js");
    expect(surfacesSource).toContain("../domain/skills/api.js");
    expect(surfacesSource).toContain("../domain/proposals/api.js");
    expect(surfacesSource).toContain("../domain/reasoning/api.js");
    expect(surfacesSource).toContain("../domain/tape/api.js");
    expect(surfacesSource).toContain("../domain/task/api.js");
    expect(surfacesSource).toContain("../domain/truth/api.js");
    expect(surfacesSource).toContain("../domain/events/api.js");
    expect(surfacesSource).toContain("../domain/ledger/api.js");
    expect(surfacesSource).toContain("../domain/schedule/api.js");
    expect(surfacesSource).toContain("../domain/recovery/api.js");
    expect(surfacesSource).toContain("../domain/lifecycle/api.js");
    expect(surfacesSource).toContain("../domain/verification/api.js");
    expect(surfacesSource).toContain("../domain/cost/api.js");
    expect(surfacesSource).toContain("../domain/sessions/api.js");
    expect(surfacesSource).not.toContain("../session/runtime-surface.js");
    expect(surfacesSource).toContain("bindSurfaceContribution(");
    expect(surfacesSource).not.toMatch(/from "\.\.\/services\//u);
    expect(surfacesSource).toContain("const runtimeSurfaceModules = [");
    expect(surfacesSource).toContain("bindRuntimeSurface(");
    expect(surfacesSource).toContain('collectSurfaceBindings(boundSurfaces, "authority")');
    expect(surfacesSource).toContain('collectSurfaceBindings(boundSurfaces, "inspect")');
    expect(surfacesSource).toContain('collectSurfaceBindings(boundSurfaces, "maintain")');
    expect(surfacesSource.split("\n").length).toBeLessThan(220);
    expect(surfacesSource).not.toContain("bindMethods(");
    expect(surfacesSource).not.toContain("bindMethods(methodGroups.skills, [");
    expect(surfacesSource).not.toContain("bindMethods(methodGroups.proposals, [");
    expect(surfacesSource).not.toContain("bindMethods(methodGroups.reasoning, [");
    expect(surfacesSource).not.toContain("bindMethods(methodGroups.task, [");
    expect(surfacesSource).not.toContain("bindMethods(methodGroups.truth, [");
    expect(surfacesSource).not.toContain("bindMethods(methodGroups.events, [");
    expect(eventsSurfaceSource).not.toContain("getTapeService()");
    expect(eventsSurfaceSource).not.toContain("recordTapeHandoff");
    expect(eventsSurfaceSource).not.toContain("getTapeStatus");
    expect(eventsSurfaceSource).not.toContain("searchTape");
    expect(tapeSurfaceSource).toContain("recordTapeHandoff");
    expect(tapeSurfaceSource).toContain("getTapeStatus");
    expect(tapeSurfaceSource).toContain("searchTape");
    expect(runtimeHelpersSource).toContain('getBrewvaEventCategory(type) ?? "other"');
    expect(runtimeHelpersSource).not.toContain('startsWith("session_")');
    expect(eventDescriptorsSource).toContain("../domain/proposals/event-descriptors.js");
    expect(eventDescriptorsSource).toContain("../domain/skills/event-descriptors.js");
    expect(eventDescriptorsSource).toContain("../domain/verification/event-descriptors.js");
    expect(eventDescriptorsSource).toContain("../domain/task/event-descriptors.js");
    expect(eventDescriptorsSource).toContain("../domain/reasoning/event-descriptors.js");
    expect(eventDescriptorsSource).toContain("../domain/delegation/event-descriptors.js");
    expect(eventDescriptorsSource).toContain("../domain/sessions/event-descriptors.js");
    expect(eventDescriptorsSource).toContain("../domain/tools/event-descriptors.js");
    expect(eventDescriptorsSource).not.toContain("../contracts/proposal.js");
    expect(eventDescriptorsSource).not.toContain("defineBrewvaEventDescriptor(");
    expect(eventDescriptorsSource).not.toContain("readPayload: readToolLifecycleEventPayloadValue");
    expect(eventDescriptorsSource).not.toContain(
      "readPayload: readToolResultRecordedEventPayloadValue",
    );
    expect(eventDescriptorsSource).not.toContain(
      "readPayload: readToolOutputDistilledEventPayloadValue",
    );
    expect(eventDescriptorsSource).not.toContain(
      "readPayload: readToolCallBlockedEventPayloadValue",
    );
    expect(sessionEventDescriptorsSource).toContain("defineBrewvaEventDescriptor(");
    expect(sessionEventDescriptorsSource).not.toContain("../../events/descriptors.js");
    expect(toolsEventDescriptorsSource).toContain("defineBrewvaEventDescriptor(");
    expect(toolsEventDescriptorsSource).toContain("TOOLS_EVENT_DESCRIPTORS");
    expect(toolsEventDescriptorsSource).not.toContain("../../events/descriptors.js");
    expect(lazyRegistrarSource).toContain("../domain/credentials/api.js");
    expect(lazyRegistrarSource).toContain("../domain/patching/api.js");
    expect(lazyRegistrarSource).toContain("../domain/parallel/api.js");
    expect(lazyRegistrarSource).toContain("../domain/reasoning/api.js");
    expect(lazyRegistrarSource).toContain("../domain/schedule/api.js");
    expect(lazyRegistrarSource).toContain("../domain/sessions/api.js");
    expect(lazyRegistrarSource).toContain("../domain/tools/api.js");
    expect(lazyRegistrarSource).toContain("../domain/verification/api.js");
    expect(lazyRegistrarSource).not.toContain("../domain/parallel/parallel.js");
    expect(lazyRegistrarSource).not.toContain("../domain/parallel/resource-lease.js");
    expect(lazyRegistrarSource).not.toContain("../domain/patching/file-change.js");
    expect(lazyRegistrarSource).not.toContain("../domain/reasoning/reasoning.js");
    expect(lazyRegistrarSource).not.toContain("../domain/schedule/schedule-intent.js");
    expect(lazyRegistrarSource).not.toContain("../domain/schedule/service.js");
    expect(lazyRegistrarSource).not.toContain("../domain/sessions/session-rewind.js");
    expect(lazyRegistrarSource).not.toContain("../domain/sessions/session-wire.js");
    expect(lazyRegistrarSource).not.toContain("../services/tool-access-policy.js");
    expect(lazyRegistrarSource).not.toContain("../services/tool-gate.js");
    expect(lazyRegistrarSource).not.toContain("../services/tool-invocation-spine.js");
    expect(lazyRegistrarSource).not.toContain("../services/tool-start-readiness.js");
    expect(registrarTypesSource).toContain("../domain/tools/api.js");
    expect(registrarTypesSource).not.toContain("../services/tool-gate.js");
    expect(registrarTypesSource).not.toContain("../services/tool-invocation-spine.js");
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/tools"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/sessions"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/session"))).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/task/registrar.ts")),
    ).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/skills/registrar.ts")),
    ).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/context/registrar.ts")),
    ).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/truth/registrar.ts")),
    ).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/ledger/registrar.ts")),
    ).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/cost/registrar.ts")),
    ).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/reasoning/registrar.ts")),
    ).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/verification/registrar.ts")),
    ).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/domain/tools/runtime-surface.ts")),
    ).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/services/tool-access-policy.ts")),
    ).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/services/tool-gate.ts"))).toBe(
      false,
    );
    expect(
      existsSync(
        resolve(repoRoot, "packages/brewva-runtime/src/services/tool-invocation-spine.ts"),
      ),
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/services/tool-start-readiness.ts")),
    ).toBe(false);
  });

  test("runtime surface dependencies hide service lifetime behind getters", () => {
    const surfaceFiles = [
      "packages/brewva-runtime/src/domain/context/runtime-surface.ts",
      "packages/brewva-runtime/src/domain/cost/runtime-surface.ts",
      "packages/brewva-runtime/src/domain/ledger/runtime-surface.ts",
      "packages/brewva-runtime/src/domain/sessions/runtime-surface.ts",
      "packages/brewva-runtime/src/domain/tools/runtime-surface.ts",
      "packages/brewva-runtime/src/domain/skills/runtime-surface.ts",
      "packages/brewva-runtime/src/domain/task/runtime-surface.ts",
      "packages/brewva-runtime/src/domain/truth/runtime-surface.ts",
      "packages/brewva-runtime/src/domain/verification/runtime-surface.ts",
    ];

    for (const file of surfaceFiles) {
      const source = readRepoFile(file);
      expect(source).not.toMatch(/^\s+\w+Service:\s+\w+Service;/mu);
      expect(source).toMatch(/get[A-Z]\w*Service\(\):\s+[A-Z]\w*Service;/u);
    }
  });

  test("runtime infrastructure subpaths stay explicit instead of wildcard re-exporting", () => {
    const credentialsSource = readRepoFile("packages/brewva-runtime/src/credentials.ts");
    const contextSource = readRepoFile("packages/brewva-runtime/src/context.ts");
    const eventLogSource = readRepoFile("packages/brewva-runtime/src/event-log.ts");
    const parallelSource = readRepoFile("packages/brewva-runtime/src/parallel.ts");
    const recoverySource = readRepoFile("packages/brewva-runtime/src/recovery.ts");
    const replaySource = readRepoFile("packages/brewva-runtime/src/replay.ts");
    const patchHistorySource = readRepoFile("packages/brewva-runtime/src/patch-history.ts");

    expect(credentialsSource).not.toMatch(/export \* from /u);
    expect(contextSource).not.toMatch(/export \* from /u);
    expect(eventLogSource).not.toMatch(/export \* from /u);
    expect(parallelSource).not.toMatch(/export \* from /u);
    expect(recoverySource).not.toMatch(/export \* from /u);
    expect(replaySource).not.toMatch(/export \* from /u);
    expect(patchHistorySource).not.toMatch(/export \* from /u);
    expect(credentialsSource).toContain("createBoundExtensionPort(");
    expect(contextSource).toContain("createBoundExtensionPort(");
    expect(eventLogSource).toContain("createBoundExtensionPort(");
    expect(parallelSource).toContain("createBoundExtensionPort(");
    expect(recoverySource).toContain("createBoundExtensionPort(");
    expect(replaySource).toContain("createBoundExtensionPort(");
    expect(credentialsSource).toContain("./domain/credentials/api.js");
    expect(contextSource).toContain("./domain/context/api.js");
    expect(eventLogSource).toContain("./domain/sessions/api.js");
    expect(parallelSource).toContain("./domain/parallel/api.js");
    expect(recoverySource).toContain("./domain/schedule/api.js");
    expect(replaySource).toContain("./domain/tape/api.js");
    expect(credentialsSource).toContain("createCredentialVaultService");
    expect(credentialsSource).not.toMatch(/export\s+\{\s*CredentialVaultService\b/u);
    expect(contextSource).toContain("createContextArena");
    expect(contextSource).toContain("createContextBudgetManager");
    expect(contextSource).toContain("createContextInjectionCollector");
    expect(eventLogSource).toContain("createBrewvaEventStore");
    expect(eventLogSource).not.toMatch(/export\s+\{\s*BrewvaEventStore\b/u);
    expect(parallelSource).toContain("createParallelBudgetManager");
    expect(parallelSource).toContain("createParallelResultStore");
    expect(recoverySource).toContain("createRecoveryWalStore");
    expect(recoverySource).toContain("createRecoveryWalRecovery");
    expect(recoverySource).toContain("createSchedulerService");
    expect(recoverySource).not.toMatch(/export\s+\{\s*RecoveryWalStore\b/u);
    expect(replaySource).toContain("createTurnReplayEngine");
    expect(replaySource).toContain("createReasoningReplayEngine");
    expect(patchHistorySource).toContain("PATCH_HISTORY_FILE");
  });

  test("runtime lookup map stays aligned with sliced domain ownership", () => {
    const sourceMap = readRepoFile("skills/project/shared/source-map.md");

    expect(sourceMap).toContain("`packages/brewva-runtime/src/domain/sessions/event-pipeline.ts`");
    expect(sourceMap).toContain("`packages/brewva-runtime/src/domain/tools/tool-gate.ts`");
    expect(sourceMap).toContain(
      "`packages/brewva-runtime/src/domain/proposals/effect-commitment-desk.ts`",
    );
    expect(sourceMap).not.toContain("`packages/brewva-runtime/src/services/event-pipeline.ts`");
    expect(sourceMap).not.toContain("`packages/brewva-runtime/src/services/tool-gate.ts`");
    expect(sourceMap).not.toContain(
      "`packages/brewva-runtime/src/services/effect-commitment-desk.ts`",
    );
  });

  test("runtime event registry stays aggregate-only and does not redefine event constants", () => {
    const registrySource = readRepoFile("packages/brewva-runtime/src/events/registry.ts");
    const eventsEntrySource = readRepoFile("packages/brewva-runtime/src/events.ts");
    const descriptorsSource = readRepoFile("packages/brewva-runtime/src/events/descriptors.ts");
    const descriptorCoreSource = readRepoFile(
      "packages/brewva-runtime/src/events/descriptor-core.ts",
    );

    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/events/event-types.ts"))).toBe(
      false,
    );
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/events/catalog.ts"))).toBe(
      false,
    );
    expect(eventsEntrySource).toContain("./events/registry.js");
    expect(eventsEntrySource).not.toContain("./events/event-types.js");
    expect(readRepoFile("packages/brewva-runtime/src/events/types.ts")).toContain("./registry.js");
    expect(descriptorsSource).toContain("./descriptor-core.js");
    expect(registrySource).toContain("BREWVA_REGISTERED_EVENT_TYPES");
    expect(registrySource).toContain("BREWVA_EVENT_DURABILITY_BY_TYPE");
    expect(registrySource).toContain("BREWVA_EVENT_CATEGORY_BY_TYPE");
    expect(registrySource).toContain("BREWVA_UNTYPED_EVENT_DEFINITIONS");
    expect(registrySource).toContain("duplicate_registered_event_type");
    expect(registrySource).not.toContain("BREWVA_UNTYPED_EVENT_CATEGORY_BY_TYPE");
    expect(registrySource).not.toMatch(/export const [A-Z0-9_]+_EVENT_TYPE\s*=/u);
    expect(registrySource).toContain("getBrewvaEventCategory");
    expect(descriptorCoreSource).toContain("defineBrewvaEventDescriptor");
  });

  test(
    "repo no longer references removed event catalog or removed events surface paths",
    () => {
      const staleReferences = [
        "packages/brewva-runtime/src/events/catalog.ts",
        "packages/brewva-runtime/src/events/runtime-surface.ts",
      ];
      const files = [
        ...collectSourceFiles("docs"),
        ...collectSourceFiles("skills"),
        ...collectSourceFiles("test"),
        ...collectSourceFiles("packages"),
      ];
      const offenders: string[] = [];

      for (const file of files) {
        if (file.endsWith("/test/quality/runtime-promoted-architecture.quality.test.ts")) {
          continue;
        }
        const source = readFileSync(file, "utf-8");
        if (staleReferences.some((reference) => source.includes(reference))) {
          offenders.push(file);
        }
      }

      expect(offenders).toEqual([]);
    },
    { timeout: 20_000 },
  );

  test("runtime result contract stays reason-based instead of drifting to error", () => {
    const runtimeResultSource = readRepoFile("packages/brewva-runtime/src/core/runtime-result.ts");
    const configLoaderSource = readRepoFile("packages/brewva-runtime/src/config/loader.ts");
    const configSchemaSource = readRepoFile("packages/brewva-runtime/src/config/schema.ts");
    const configValidationSource = readRepoFile("packages/brewva-runtime/src/config/validate.ts");

    expect(runtimeResultSource).toContain("reason: TReason;");
    expect(runtimeResultSource).not.toContain("error: TReason;");
    expect(configLoaderSource).not.toMatch(/export \* from /u);
    expect(configSchemaSource).toContain("| { ok: false; cause: Error }");
    expect(configValidationSource).toContain("| { ok: false; cause: Error }");
    expect(configValidationSource).toContain("reason: string;");
    expect(configValidationSource).not.toContain("error: string;");
  });

  test("legacy runtime assembler and method-group files are gone", () => {
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime-assembler.ts"))).toBe(
      false,
    );
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime-method-groups.ts")),
    ).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime.ts"))).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime-kernel.ts"))).toBe(
      false,
    );
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime-composition.ts")),
    ).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime-surfaces.ts"))).toBe(
      false,
    );
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime-extensions.ts"))).toBe(
      false,
    );
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime-helpers.ts"))).toBe(
      false,
    );
  });

  test("contracts stay type-oriented and do not own runtime decision helpers", () => {
    const skillContracts = readRepoFile("packages/brewva-runtime/src/domain/skills/types.ts");
    const reasoningContracts = readRepoFile(
      "packages/brewva-runtime/src/domain/reasoning/types.ts",
    );
    const delegationContracts = readRepoFile(
      "packages/brewva-runtime/src/domain/delegation/types.ts",
    );

    expect(skillContracts).not.toContain("SKILL_REPAIR_ALLOWED_TOOL_NAMES");
    expect(skillContracts).not.toContain("isSemanticArtifactSchemaId");
    expect(reasoningContracts).not.toContain("buildReasoningRevertSummaryDetails");
    expect(delegationContracts).not.toContain("evaluateDelegationAdoption");
  });

  test("production code no longer depends on the removed domain barrel", () => {
    const offenderFiles: string[] = [];
    for (const sourceFile of collectSourceFiles("packages/brewva-runtime/src")) {
      const source = readFileSync(sourceFile, "utf-8");
      if (source.includes("domain/index.js")) {
        offenderFiles.push(sourceFile);
      }
    }

    expect(offenderFiles).toEqual([]);
  });

  test("domain sources do not depend on removed internal index barrels and self-register runtime surfaces", () => {
    const domainFiles = collectSourceFiles("packages/brewva-runtime/src/domain");
    const barrelOffenders: string[] = [];
    for (const sourceFile of domainFiles) {
      const source = readFileSync(sourceFile, "utf-8");
      if (source.includes("../index.js") || source.includes("../../index.js")) {
        barrelOffenders.push(sourceFile);
      }
    }

    expect(barrelOffenders).toEqual([]);

    const runtimeSurfaceFiles = domainFiles.filter((file) => file.endsWith("/runtime-surface.ts"));
    for (const file of runtimeSurfaceFiles) {
      const source = readFileSync(file, "utf-8");
      expect(source).toContain("defineRuntimeSurfaceModule(");
    }

    const domainDirs = readdirSync(resolve(repoRoot, "packages/brewva-runtime/src/domain"), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    for (const entry of domainDirs) {
      const domainRoot = resolve(repoRoot, "packages/brewva-runtime/src/domain", entry.name);
      const apiPath = resolve(domainRoot, "api.ts");
      const registrarPath = resolve(domainRoot, "registrar.ts");
      const runtimeSurfacePath = resolve(domainRoot, "runtime-surface.ts");
      const typesPath = resolve(domainRoot, "types.ts");
      expect(existsSync(apiPath)).toBe(true);
      expect(existsSync(registrarPath)).toBe(true);
      expect(existsSync(runtimeSurfacePath)).toBe(true);
      expect(existsSync(typesPath)).toBe(true);
      expect(readFileSync(apiPath, "utf-8")).not.toMatch(/export \* from /u);
    }

    const runtimeSurfacesSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/runtime-surfaces.ts",
    );
    expect(runtimeSurfacesSource).toContain("const runtimeSurfaceModules = [");
    expect(runtimeSurfacesSource).not.toContain("const boundSurfaces = {");
  });

  test("domain and runtime layers only cross domain boundaries through stable api/type seams", () => {
    const domainOffenders = collectCrossDomainSpecifierOffenders(
      collectSourceFiles("packages/brewva-runtime/src/domain"),
      ["api.ts", "types.ts"],
    );
    const runtimeOffenders = collectCrossDomainSpecifierOffenders(
      collectSourceFiles("packages/brewva-runtime/src/runtime"),
      ["api.ts", "types.ts"],
    );
    const rootOffenders = collectCrossDomainSpecifierOffenders(
      collectSourceFiles("packages/brewva-runtime/src").filter((file) => {
        const relative = file.replace(`${runtimeSrcRoot}/`, "");
        return !relative.includes("/") && relative !== "index.ts";
      }),
      ["api.ts", "types.ts"],
    );

    expect(domainOffenders).toEqual([]);
    expect(runtimeOffenders).toEqual([]);
    expect(rootOffenders).toEqual([]);
  });

  test(
    "repo consumers do not import event-plane contracts from the runtime root",
    () => {
      const rootEventSymbols = new Set([
        "asBrewvaEventType",
        "BREWVA_REGISTERED_EVENT_TYPES",
        "BREWVA_REGISTERED_EVENT_TYPE_SET",
        "BREWVA_EVENT_DURABILITY_BY_TYPE",
        "getBrewvaEventDurabilityClass",
        "isBrewvaRegisteredEventType",
        "BrewvaEventQuery",
        "BrewvaEventRecord",
        "BrewvaEventType",
        "BrewvaRegisteredEventType",
        "BrewvaReplaySession",
        "BrewvaStructuredEvent",
      ]);
      const importPattern =
        /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+"@brewva\/brewva-runtime"/gu;

      const offenderFiles: string[] = [];
      for (const sourceFile of [
        ...collectSourceFiles("packages"),
        ...collectSourceFiles("test"),
        ...collectSourceFiles("script"),
      ]) {
        const source = readFileSync(sourceFile, "utf-8");
        const matches = source.matchAll(importPattern);
        for (const match of matches) {
          const importClause = match[1] ?? "";
          const importedNames = importClause
            .split(",")
            .map((entry) => entry.replace(/^type\s+/u, "").trim())
            .map((entry) => entry.split(/\s+as\s+/u)[0]?.trim() ?? "")
            .filter(Boolean);
          if (importedNames.some((entry) => rootEventSymbols.has(entry))) {
            offenderFiles.push(sourceFile);
            break;
          }
        }
      }

      expect(offenderFiles).toEqual([]);
    },
    { timeout: 15_000 },
  );
});
