import { claimRuntimeSurface, type ClaimSurfaceDependencies } from "../domain/claim/api.js";
import { contextRuntimeSurface, type ContextSurfaceDependencies } from "../domain/context/api.js";
import {
  conventionsRuntimeSurface,
  type ConventionsSurfaceDependencies,
} from "../domain/conventions/api.js";
import { costRuntimeSurface, type CostSurfaceDependencies } from "../domain/cost/api.js";
import { eventsRuntimeSurface, type EventsSurfaceDependencies } from "../domain/events/api.js";
import { ledgerRuntimeSurface, type LedgerSurfaceDependencies } from "../domain/ledger/api.js";
import {
  lifecycleRuntimeSurface,
  type LifecycleSurfaceDependencies,
} from "../domain/lifecycle/api.js";
import {
  proposalsRuntimeSurface,
  type ProposalsSurfaceDependencies,
} from "../domain/proposals/api.js";
import {
  reasoningRuntimeSurface,
  type ReasoningSurfaceDependencies,
} from "../domain/reasoning/api.js";
import {
  recoveryRuntimeSurface,
  type RecoverySurfaceDependencies,
} from "../domain/recovery/api.js";
import {
  scheduleRuntimeSurface,
  type ScheduleSurfaceDependencies,
} from "../domain/schedule/api.js";
import {
  sessionRuntimeSurface,
  sessionWireRuntimeSurface,
  type SessionSurfaceDependencies,
  type SessionWireSurfaceDependencies,
} from "../domain/sessions/api.js";
import { skillsRuntimeSurface, type SkillsSurfaceDependencies } from "../domain/skills/api.js";
import { tapeRuntimeSurface, type TapeSurfaceDependencies } from "../domain/tape/api.js";
import { taskRuntimeSurface, type TaskSurfaceDependencies } from "../domain/task/api.js";
import { toolsRuntimeSurface, type ToolsSurfaceDependencies } from "../domain/tools/api.js";
import {
  verificationRuntimeSurface,
  type VerificationSurfaceDependencies,
} from "../domain/verification/api.js";
import {
  workbenchRuntimeSurface,
  type WorkbenchSurfaceDependencies,
} from "../domain/workbench/api.js";
import {
  bindSurfaceContribution,
  type BoundSurfaceContribution,
  type SurfaceContribution,
} from "./surface-descriptor.js";

export interface RuntimeSurfaceDependencies
  extends
    ContextSurfaceDependencies,
    ConventionsSurfaceDependencies,
    CostSurfaceDependencies,
    EventsSurfaceDependencies,
    LedgerSurfaceDependencies,
    LifecycleSurfaceDependencies,
    ProposalsSurfaceDependencies,
    ReasoningSurfaceDependencies,
    RecoverySurfaceDependencies,
    ScheduleSurfaceDependencies,
    SessionSurfaceDependencies,
    SessionWireSurfaceDependencies,
    SkillsSurfaceDependencies,
    TapeSurfaceDependencies,
    TaskSurfaceDependencies,
    ToolsSurfaceDependencies,
    ClaimSurfaceDependencies,
    VerificationSurfaceDependencies,
    WorkbenchSurfaceDependencies {}

const runtimeSurfaceModules = [
  skillsRuntimeSurface,
  proposalsRuntimeSurface,
  conventionsRuntimeSurface,
  reasoningRuntimeSurface,
  workbenchRuntimeSurface,
  contextRuntimeSurface,
  toolsRuntimeSurface,
  taskRuntimeSurface,
  claimRuntimeSurface,
  ledgerRuntimeSurface,
  scheduleRuntimeSurface,
  recoveryRuntimeSurface,
  lifecycleRuntimeSurface,
  eventsRuntimeSurface,
  tapeRuntimeSurface,
  verificationRuntimeSurface,
  costRuntimeSurface,
  sessionRuntimeSurface,
  sessionWireRuntimeSurface,
] as const;

type RuntimeSurfaceModuleUnion = (typeof runtimeSurfaceModules)[number];

type RuntimeSurfaceNameOf<TModule extends RuntimeSurfaceModuleUnion> = TModule["name"];

type RuntimeSurfaceMethodsOf<TModule extends RuntimeSurfaceModuleUnion> = ReturnType<
  TModule["createMethods"]
>;

type RuntimeSurfaceMethodMap = {
  readonly [TModule in RuntimeSurfaceModuleUnion as RuntimeSurfaceNameOf<TModule>]: RuntimeSurfaceMethodsOf<TModule>;
};

type RuntimeBoundSurfaceMap = {
  readonly [TModule in RuntimeSurfaceModuleUnion as RuntimeSurfaceNameOf<TModule>]: TModule extends {
    contribution: infer TContribution extends SurfaceContribution<RuntimeSurfaceMethodsOf<TModule>>;
  }
    ? BoundSurfaceContribution<RuntimeSurfaceMethodsOf<TModule>, TContribution>
    : never;
};

function createRuntimeSurfaceMethods(deps: RuntimeSurfaceDependencies): RuntimeSurfaceMethodMap {
  const entries = runtimeSurfaceModules.map((module) => [
    module.name,
    module.createMethods(deps),
  ]) as Array<readonly [RuntimeSurfaceModuleUnion["name"], object]>;
  return Object.fromEntries(entries) as RuntimeSurfaceMethodMap;
}

function bindRuntimeSurface<TModule extends RuntimeSurfaceModuleUnion>(
  module: TModule,
  surfaceMethods: RuntimeSurfaceMethodMap,
): readonly [RuntimeSurfaceNameOf<TModule>, RuntimeBoundSurfaceMap[RuntimeSurfaceNameOf<TModule>]] {
  const methods = surfaceMethods[module.name] as RuntimeSurfaceMethodsOf<TModule>;
  return [
    module.name,
    bindSurfaceContribution(
      methods,
      module.contribution as unknown as SurfaceContribution<RuntimeSurfaceMethodsOf<TModule>>,
    ) as unknown as RuntimeBoundSurfaceMap[RuntimeSurfaceNameOf<TModule>],
  ] as const;
}

type RuntimeCollectedBoundSurfaceMap = Record<
  string,
  Partial<Record<"authority" | "inspect" | "maintain", object>>
>;

type CollectedSurfaceBindings<
  TBindings extends RuntimeCollectedBoundSurfaceMap,
  TSurface extends "authority" | "inspect" | "maintain",
> = {
  readonly [TDomain in keyof TBindings as TBindings[TDomain][TSurface] extends object
    ? TDomain
    : never]: NonNullable<TBindings[TDomain][TSurface]>;
};

function collectSurfaceBindings<
  const TBindings extends RuntimeCollectedBoundSurfaceMap,
  TSurface extends "authority" | "inspect" | "maintain",
>(bindings: TBindings, surfaceName: TSurface): CollectedSurfaceBindings<TBindings, TSurface> {
  const result: Record<string, unknown> = {};
  for (const [domainName, surfaces] of Object.entries(bindings)) {
    const binding = surfaces[surfaceName];
    if (binding !== undefined) {
      result[domainName] = binding;
    }
  }
  return result as CollectedSurfaceBindings<TBindings, TSurface>;
}

export function createRuntimeSemanticSurfaces(deps: RuntimeSurfaceDependencies) {
  const surfaceMethods = createRuntimeSurfaceMethods(deps);
  const boundSurfaces = Object.fromEntries(
    runtimeSurfaceModules.map((module) => bindRuntimeSurface(module, surfaceMethods)),
  ) as unknown as RuntimeBoundSurfaceMap;

  return {
    authority: collectSurfaceBindings(boundSurfaces, "authority"),
    inspect: collectSurfaceBindings(boundSurfaces, "inspect"),
    maintain: collectSurfaceBindings(boundSurfaces, "maintain"),
  };
}

export type RuntimeSemanticSurfaces = ReturnType<typeof createRuntimeSemanticSurfaces>;
