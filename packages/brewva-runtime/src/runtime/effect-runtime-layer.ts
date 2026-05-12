import {
  BrewvaContext,
  BrewvaEffect,
  BrewvaLayer,
  BrewvaRuntimeScope,
  observabilityLayer,
} from "@brewva/brewva-effect";
import { createBrewvaRuntimeSpine, type BrewvaRuntimeSpine } from "@brewva/brewva-effect/runtime";
import type { BrewvaConfig } from "../config/types.js";
import type { DeepReadonly } from "../core/index.js";
import { registerRuntimeCoreDependencies } from "./core-registrar.js";
import { registerRuntimeKernelContext } from "./kernel-registrar.js";
import type { RuntimeComposition, RuntimeCompositionInput } from "./runtime-composition.js";
import type {
  RuntimeCoreDependencies,
  RuntimeLazyServiceFactories,
  RuntimeServiceDependencies,
} from "./runtime-composition.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";
import {
  registerRuntimeLazyServiceFactories,
  registerRuntimeServiceDependencies,
} from "./services-registrar.js";

export interface RuntimeIdentityShape {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly agentId: string;
}

export interface RuntimeConfigShape {
  readonly config: DeepReadonly<BrewvaConfig>;
}

export interface RuntimeBuildConfigShape {
  readonly mutableConfig: BrewvaConfig;
  readonly readonlyConfig: DeepReadonly<BrewvaConfig>;
}

export type RuntimeSecurityConfigShape = DeepReadonly<BrewvaConfig["security"]>;
export type RuntimeInfrastructureConfigShape = DeepReadonly<BrewvaConfig["infrastructure"]>;
export type RuntimeScheduleConfigShape = DeepReadonly<BrewvaConfig["schedule"]>;

export type RuntimeCompositionHooksShape = Omit<
  RuntimeCompositionInput,
  "cwd" | "workspaceRoot" | "agentId" | "config"
>;

export interface RuntimeEffectLayerInput {
  readonly identity: RuntimeIdentityShape;
  readonly config: RuntimeBuildConfigShape;
  readonly hooks: RuntimeCompositionHooksShape;
}

interface RuntimeEffectServiceValues extends RuntimeComposition {
  readonly identity: RuntimeIdentityShape;
  readonly config: RuntimeConfigShape;
}

export class RuntimeIdentityService extends BrewvaContext.Service<
  RuntimeIdentityService,
  RuntimeIdentityShape
>()("@brewva/RuntimeIdentity") {}

export class RuntimeConfigService extends BrewvaContext.Service<
  RuntimeConfigService,
  RuntimeConfigShape
>()("@brewva/RuntimeConfig") {}

export class RuntimeBuildConfigService extends BrewvaContext.Service<
  RuntimeBuildConfigService,
  RuntimeBuildConfigShape
>()("@brewva/RuntimeBuildConfig") {}

export class RuntimeCompositionHooksService extends BrewvaContext.Service<
  RuntimeCompositionHooksService,
  RuntimeCompositionHooksShape
>()("@brewva/RuntimeCompositionHooks") {}

export class RuntimeSecurityConfigService extends BrewvaContext.Service<
  RuntimeSecurityConfigService,
  RuntimeSecurityConfigShape
>()("@brewva/RuntimeSecurityConfig") {}

export class RuntimeInfrastructureConfigService extends BrewvaContext.Service<
  RuntimeInfrastructureConfigService,
  RuntimeInfrastructureConfigShape
>()("@brewva/RuntimeInfrastructureConfig") {}

export class RuntimeScheduleConfigService extends BrewvaContext.Service<
  RuntimeScheduleConfigService,
  RuntimeScheduleConfigShape
>()("@brewva/RuntimeScheduleConfig") {}

export class RuntimeCoreDependenciesService extends BrewvaContext.Service<
  RuntimeCoreDependenciesService,
  RuntimeCoreDependencies
>()("@brewva/RuntimeCoreDependencies") {}

export class RuntimeKernelService extends BrewvaContext.Service<
  RuntimeKernelService,
  RuntimeKernelContext
>()("@brewva/RuntimeKernel") {}

export class RuntimeServiceDependenciesService extends BrewvaContext.Service<
  RuntimeServiceDependenciesService,
  RuntimeServiceDependencies
>()("@brewva/RuntimeServiceDependencies") {}

export class RuntimeLazyServiceFactoriesService extends BrewvaContext.Service<
  RuntimeLazyServiceFactoriesService,
  RuntimeLazyServiceFactories
>()("@brewva/RuntimeLazyServiceFactories") {}

export type RuntimeEffectServices =
  | BrewvaRuntimeScope
  | RuntimeIdentityService
  | RuntimeConfigService
  | RuntimeBuildConfigService
  | RuntimeCompositionHooksService
  | RuntimeSecurityConfigService
  | RuntimeInfrastructureConfigService
  | RuntimeScheduleConfigService
  | RuntimeCoreDependenciesService
  | RuntimeKernelService
  | RuntimeServiceDependenciesService
  | RuntimeLazyServiceFactoriesService;

export type RuntimeEffectSpine = BrewvaRuntimeSpine<RuntimeEffectServices>;

export function createRuntimeEffectLayerInput(
  input: RuntimeCompositionInput,
): RuntimeEffectLayerInput {
  return {
    identity: {
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      agentId: input.agentId,
    },
    config: {
      mutableConfig: input.config,
      readonlyConfig: input.config as DeepReadonly<BrewvaConfig>,
    },
    hooks: {
      governancePort: input.governancePort,
      sessionState: input.sessionState,
      resolveToolAuthority: input.resolveToolAuthority,
      getCurrentTurn: input.getCurrentTurn,
      getTaskState: input.getTaskState,
      getClaimState: input.getClaimState,
      recordEvent: input.recordEvent,
      sanitizeInput: input.sanitizeInput,
      getLatestVerificationOutcome: input.getLatestVerificationOutcome,
      isContextBudgetEnabled: input.isContextBudgetEnabled,
      resolveCheckpointCostSummary: input.resolveCheckpointCostSummary,
      resolveCheckpointCostSkillLastTurnByName: input.resolveCheckpointCostSkillLastTurnByName,
      evaluateCompletion: input.evaluateCompletion,
      getSessionLifecycleSnapshot: input.getSessionLifecycleSnapshot,
    },
  };
}

function createRuntimeBaseLayer(
  input: RuntimeEffectLayerInput,
): BrewvaLayer.Layer<
  | BrewvaRuntimeScope
  | RuntimeIdentityService
  | RuntimeBuildConfigService
  | RuntimeConfigService
  | RuntimeCompositionHooksService
  | RuntimeSecurityConfigService
  | RuntimeInfrastructureConfigService
  | RuntimeScheduleConfigService
> {
  const readonlyConfig = RuntimeConfigService.of({ config: input.config.readonlyConfig });
  return BrewvaLayer.mergeAll(
    BrewvaRuntimeScope.layer({
      runtimeId: `${input.identity.agentId}@${input.identity.workspaceRoot}`,
      agentId: input.identity.agentId,
      workspaceRoot: input.identity.workspaceRoot,
    }),
    BrewvaLayer.succeed(RuntimeIdentityService, RuntimeIdentityService.of(input.identity)),
    BrewvaLayer.succeed(RuntimeBuildConfigService, RuntimeBuildConfigService.of(input.config)),
    BrewvaLayer.succeed(RuntimeConfigService, readonlyConfig),
    BrewvaLayer.succeed(
      RuntimeCompositionHooksService,
      RuntimeCompositionHooksService.of(input.hooks),
    ),
    BrewvaLayer.succeed(
      RuntimeSecurityConfigService,
      RuntimeSecurityConfigService.of(input.config.readonlyConfig.security),
    ),
    BrewvaLayer.succeed(
      RuntimeInfrastructureConfigService,
      RuntimeInfrastructureConfigService.of(input.config.readonlyConfig.infrastructure),
    ),
    BrewvaLayer.succeed(
      RuntimeScheduleConfigService,
      RuntimeScheduleConfigService.of(input.config.readonlyConfig.schedule),
    ),
  );
}

function createRuntimeCoreDependenciesLayer(
  baseLayer: BrewvaLayer.Layer<
    RuntimeIdentityService | RuntimeBuildConfigService | RuntimeCompositionHooksService
  >,
): BrewvaLayer.Layer<RuntimeCoreDependenciesService> {
  return BrewvaLayer.effect(
    RuntimeCoreDependenciesService,
    BrewvaEffect.gen(function* () {
      const identity = yield* RuntimeIdentityService;
      const config = yield* RuntimeBuildConfigService;
      const hooks = yield* RuntimeCompositionHooksService;
      return RuntimeCoreDependenciesService.of(
        registerRuntimeCoreDependencies({
          cwd: identity.cwd,
          workspaceRoot: identity.workspaceRoot,
          config: config.mutableConfig,
          recordEvent: hooks.recordEvent,
          getCurrentTurn: (sessionId) => hooks.getCurrentTurn(sessionId),
        }),
      );
    }),
  ).pipe(BrewvaLayer.provide(baseLayer));
}

function createRuntimeKernelLayer(
  dependenciesLayer: BrewvaLayer.Layer<
    | RuntimeIdentityService
    | RuntimeBuildConfigService
    | RuntimeCompositionHooksService
    | RuntimeCoreDependenciesService
  >,
): BrewvaLayer.Layer<RuntimeKernelService> {
  return BrewvaLayer.effect(
    RuntimeKernelService,
    BrewvaEffect.gen(function* () {
      const identity = yield* RuntimeIdentityService;
      const config = yield* RuntimeBuildConfigService;
      const hooks = yield* RuntimeCompositionHooksService;
      const coreDependencies = yield* RuntimeCoreDependenciesService;
      return RuntimeKernelService.of(
        registerRuntimeKernelContext({
          cwd: identity.cwd,
          workspaceRoot: identity.workspaceRoot,
          agentId: identity.agentId,
          config: config.mutableConfig,
          governancePort: hooks.governancePort,
          coreDependencies,
          sessionState: hooks.sessionState,
          getCurrentTurn: (sessionId) => hooks.getCurrentTurn(sessionId),
          getTaskState: (sessionId) => hooks.getTaskState(sessionId),
          getClaimState: (sessionId) => hooks.getClaimState(sessionId),
          recordEvent: hooks.recordEvent,
          sanitizeInput: hooks.sanitizeInput,
          getLatestVerificationOutcome: (sessionId) =>
            hooks.getLatestVerificationOutcome(sessionId),
          isContextBudgetEnabled: () => hooks.isContextBudgetEnabled(),
        }),
      );
    }),
  ).pipe(BrewvaLayer.provide(dependenciesLayer));
}

function createRuntimeServiceDependenciesLayer(
  dependenciesLayer: BrewvaLayer.Layer<
    | RuntimeIdentityService
    | RuntimeBuildConfigService
    | RuntimeCompositionHooksService
    | RuntimeCoreDependenciesService
    | RuntimeKernelService
  >,
): BrewvaLayer.Layer<RuntimeServiceDependenciesService> {
  return BrewvaLayer.effect(
    RuntimeServiceDependenciesService,
    BrewvaEffect.gen(function* () {
      const identity = yield* RuntimeIdentityService;
      const config = yield* RuntimeBuildConfigService;
      const hooks = yield* RuntimeCompositionHooksService;
      const kernel = yield* RuntimeKernelService;
      const coreDependencies = yield* RuntimeCoreDependenciesService;
      return RuntimeServiceDependenciesService.of(
        registerRuntimeServiceDependencies({
          cwd: identity.cwd,
          workspaceRoot: identity.workspaceRoot,
          agentId: identity.agentId,
          config: config.mutableConfig,
          governancePort: hooks.governancePort,
          kernel,
          coreDependencies,
          sessionState: hooks.sessionState,
          resolveToolAuthority: hooks.resolveToolAuthority,
          resolveCheckpointCostSummary: (sessionId) =>
            hooks.resolveCheckpointCostSummary(sessionId),
          resolveCheckpointCostSkillLastTurnByName: (sessionId) =>
            hooks.resolveCheckpointCostSkillLastTurnByName(sessionId),
          evaluateCompletion: (sessionId, level) => hooks.evaluateCompletion(sessionId, level),
        }),
      );
    }),
  ).pipe(BrewvaLayer.provide(dependenciesLayer));
}

function createRuntimeLazyServiceFactoriesLayer(
  dependenciesLayer: BrewvaLayer.Layer<
    | RuntimeIdentityService
    | RuntimeBuildConfigService
    | RuntimeCompositionHooksService
    | RuntimeCoreDependenciesService
    | RuntimeKernelService
    | RuntimeServiceDependenciesService
  >,
): BrewvaLayer.Layer<RuntimeLazyServiceFactoriesService> {
  return BrewvaLayer.effect(
    RuntimeLazyServiceFactoriesService,
    BrewvaEffect.gen(function* () {
      const identity = yield* RuntimeIdentityService;
      const config = yield* RuntimeBuildConfigService;
      const hooks = yield* RuntimeCompositionHooksService;
      const kernel = yield* RuntimeKernelService;
      const coreDependencies = yield* RuntimeCoreDependenciesService;
      const serviceDependencies = yield* RuntimeServiceDependenciesService;
      return RuntimeLazyServiceFactoriesService.of(
        registerRuntimeLazyServiceFactories({
          cwd: identity.cwd,
          workspaceRoot: identity.workspaceRoot,
          config: config.mutableConfig,
          governancePort: hooks.governancePort,
          kernel,
          coreDependencies,
          sessionState: hooks.sessionState,
          eventPipeline: serviceDependencies.eventPipeline,
          contextService: serviceDependencies.contextService,
          getProposalAdmissionService: () => serviceDependencies.getProposalAdmissionService(),
          getEffectCommitmentDeskService: () =>
            serviceDependencies.getEffectCommitmentDeskService(),
          getConventionAdmissionService: () => serviceDependencies.getConventionAdmissionService(),
          ledgerService: serviceDependencies.ledgerService,
          reversibleMutationService: serviceDependencies.reversibleMutationService,
          resolveToolAuthority: hooks.resolveToolAuthority,
          getSessionLifecycleSnapshot: (sessionId) => hooks.getSessionLifecycleSnapshot(sessionId),
        }),
      );
    }),
  ).pipe(BrewvaLayer.provide(dependenciesLayer));
}

export function createRuntimeEffectLayer(
  input: RuntimeEffectLayerInput,
): BrewvaLayer.Layer<RuntimeEffectServices> {
  const baseLayer = createRuntimeBaseLayer(input);
  const coreLayer = createRuntimeCoreDependenciesLayer(baseLayer);
  const coreDependenciesLayer = BrewvaLayer.mergeAll(baseLayer, coreLayer);
  const kernelLayer = createRuntimeKernelLayer(coreDependenciesLayer);
  const kernelDependenciesLayer = BrewvaLayer.mergeAll(coreDependenciesLayer, kernelLayer);
  const serviceDependenciesLayer = createRuntimeServiceDependenciesLayer(kernelDependenciesLayer);
  const serviceDependencies = BrewvaLayer.mergeAll(
    kernelDependenciesLayer,
    serviceDependenciesLayer,
  );
  const lazyFactoriesLayer = createRuntimeLazyServiceFactoriesLayer(serviceDependencies);
  return BrewvaLayer.mergeAll(serviceDependencies, lazyFactoriesLayer);
}

export function buildRuntimeEffectServices(
  input: RuntimeEffectLayerInput,
): BrewvaEffect.Effect<RuntimeEffectServiceValues> {
  return BrewvaEffect.gen(function* () {
    const identity = yield* RuntimeIdentityService;
    const config = yield* RuntimeConfigService;
    const coreDependencies = yield* RuntimeCoreDependenciesService;
    const kernel = yield* RuntimeKernelService;
    const serviceDependencies = yield* RuntimeServiceDependenciesService;
    const lazyServiceFactories = yield* RuntimeLazyServiceFactoriesService;
    return {
      identity,
      config,
      coreDependencies,
      kernel,
      serviceDependencies,
      lazyServiceFactories,
    };
  }).pipe(BrewvaEffect.provide(createRuntimeEffectLayer(input)));
}

export function createRuntimeEffectSpine(input: RuntimeEffectLayerInput): RuntimeEffectSpine {
  const layer = createRuntimeEffectLayer(input);
  return createBrewvaRuntimeSpine(layer, {
    name: `brewva-runtime:${input.identity.agentId}`,
    observabilityLayer: observabilityLayer(() => ({
      serviceName: "brewva-runtime",
      attributes: {
        agentId: input.identity.agentId,
        workspaceRoot: input.identity.workspaceRoot,
      },
    })),
  });
}

export function collectRuntimeComposition(): BrewvaEffect.Effect<
  RuntimeComposition,
  never,
  | RuntimeCoreDependenciesService
  | RuntimeKernelService
  | RuntimeServiceDependenciesService
  | RuntimeLazyServiceFactoriesService
> {
  return BrewvaEffect.gen(function* () {
    const coreDependencies = yield* RuntimeCoreDependenciesService;
    const kernel = yield* RuntimeKernelService;
    const serviceDependencies = yield* RuntimeServiceDependenciesService;
    const lazyServiceFactories = yield* RuntimeLazyServiceFactoriesService;
    return {
      coreDependencies,
      kernel,
      serviceDependencies,
      lazyServiceFactories,
    };
  });
}
