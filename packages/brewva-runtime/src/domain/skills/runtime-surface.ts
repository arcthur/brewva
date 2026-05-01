import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { ContextBudgetUsage } from "../context/api.js";
import type { SkillConsumedOutputsView, SkillNormalizedOutputsView } from "./normalization.js";
import type { SkillRoutingCatalogEntry } from "./profiles.js";
import type { SkillReadinessEntry, SkillReadinessQuery } from "./readiness.js";
import type { SkillRegistry } from "./registry.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";
import type {
  ActiveSkillRuntimeState,
  SkillActivationResult,
  SkillCompletionFailureRecord,
  SkillDocument,
  SkillOutputValidationResult,
  SkillRefreshInput,
  SkillRefreshResult,
  SkillRegistryLoadReport,
} from "./types.js";

export interface SkillsSurfaceDependencies {
  skillRegistry: SkillRegistry;
  getSkillLifecycleService(): SkillLifecycleService;
  refreshSkillsState(input?: SkillRefreshInput): SkillRefreshResult;
}

export interface RuntimeSkillsSurfaceMethods {
  refresh(input?: SkillRefreshInput): SkillRefreshResult;
  getLoadReport(): SkillRegistryLoadReport;
  list(): SkillDocument[];
  listForRouting(): SkillRoutingCatalogEntry[];
  get(name: string): SkillDocument | undefined;
  activate(sessionId: string, name: string): SkillActivationResult;
  getActive(sessionId: string): SkillDocument | undefined;
  getActiveState(sessionId: string): ActiveSkillRuntimeState | undefined;
  getLatestFailure(sessionId: string): SkillCompletionFailureRecord | undefined;
  validateOutputs(sessionId: string, outputs: Record<string, unknown>): SkillOutputValidationResult;
  recordCompletionFailure(
    sessionId: string,
    outputs: Record<string, unknown>,
    validation: SkillOutputValidationResult & { ok: false },
    usage?: ContextBudgetUsage,
  ): SkillCompletionFailureRecord | undefined;
  complete(sessionId: string, output: Record<string, unknown>): SkillOutputValidationResult;
  getRawOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined;
  getNormalizedOutputs(
    sessionId: string,
    skillName: string,
  ): SkillNormalizedOutputsView | undefined;
  getConsumedOutputs(sessionId: string, targetSkillName: string): SkillConsumedOutputsView;
  getReadiness(sessionId: string, query?: SkillReadinessQuery): SkillReadinessEntry[];
}

export const skillsSurfaceContribution = {
  authority: ["activate", "recordCompletionFailure", "complete"],
  inspect: [
    "getLoadReport",
    "list",
    "listForRouting",
    "get",
    "getActive",
    "getActiveState",
    "getLatestFailure",
    "validateOutputs",
    "getRawOutputs",
    "getNormalizedOutputs",
    "getConsumedOutputs",
    "getReadiness",
  ],
  maintain: ["refresh"],
} as const satisfies SurfaceContribution<RuntimeSkillsSurfaceMethods>;

export function createSkillsSurfaceMethods(
  deps: SkillsSurfaceDependencies,
): RuntimeSkillsSurfaceMethods {
  return {
    refresh: (input?: SkillRefreshInput) => deps.refreshSkillsState(input),
    getLoadReport: () => deps.skillRegistry.getLoadReport(),
    list: () => deps.skillRegistry.list(),
    listForRouting: () => deps.skillRegistry.listForRouting(),
    get: (name: string) => deps.skillRegistry.get(name),
    activate: (sessionId: string, name: string) =>
      deps.getSkillLifecycleService().activateSkill(sessionId, name),
    getActive: (sessionId: string) => deps.getSkillLifecycleService().getActiveSkill(sessionId),
    getActiveState: (sessionId: string) =>
      deps.getSkillLifecycleService().getActiveSkillState(sessionId),
    getLatestFailure: (sessionId: string) =>
      deps.getSkillLifecycleService().getLatestSkillFailure(sessionId),
    validateOutputs: (sessionId: string, outputs: Record<string, unknown>) =>
      deps.getSkillLifecycleService().validateSkillOutputs(sessionId, outputs),
    recordCompletionFailure: (
      sessionId: string,
      outputs: Record<string, unknown>,
      validation: SkillOutputValidationResult & { ok: false },
      usage?: ContextBudgetUsage,
    ) =>
      deps
        .getSkillLifecycleService()
        .recordCompletionFailure(sessionId, outputs, validation, usage),
    complete: (sessionId: string, output: Record<string, unknown>) =>
      deps.getSkillLifecycleService().completeSkill(sessionId, output),
    getRawOutputs: (sessionId: string, skillName: string) =>
      deps.getSkillLifecycleService().getRawSkillOutputs(sessionId, skillName),
    getNormalizedOutputs: (sessionId: string, skillName: string) =>
      deps.getSkillLifecycleService().getNormalizedSkillOutputs(sessionId, skillName),
    getConsumedOutputs: (sessionId: string, targetSkillName: string) =>
      deps.getSkillLifecycleService().getAvailableConsumedOutputs(sessionId, targetSkillName),
    getReadiness: (sessionId: string, query?: SkillReadinessQuery) =>
      deps.getSkillLifecycleService().getSkillReadiness(sessionId, query),
  };
}

export const skillsRuntimeSurface = defineRuntimeSurfaceModule({
  name: "skills",
  createMethods: createSkillsSurfaceMethods,
  contribution: skillsSurfaceContribution,
});
