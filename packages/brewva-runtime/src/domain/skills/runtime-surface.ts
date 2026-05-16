import type { SkillRegistry } from "./registry.js";
import type { SkillRefreshInput, SkillRefreshResult } from "./types.js";

export interface SkillsSurfaceDependencies {
  skillRegistry: SkillRegistry;
  refreshSkillsState(input?: SkillRefreshInput): SkillRefreshResult;
}

export function createSkillsSurfaceMethods(deps: SkillsSurfaceDependencies) {
  return {
    inspect: {
      catalog: {
        getLoadReport: () => deps.skillRegistry.getLoadReport(),
        list: () => deps.skillRegistry.list(),
        get: (name: string) => deps.skillRegistry.get(name),
        listProducers: () => deps.skillRegistry.listProducers(),
        getProducer: (name: string) => deps.skillRegistry.getProducer(name),
      },
    },
    operator: {
      catalog: {
        refresh: (input?: SkillRefreshInput) => deps.refreshSkillsState(input),
      },
    },
  };
}

export type RuntimeSkillsSurfaceMethods = ReturnType<typeof createSkillsSurfaceMethods>;

export function createSkillsInspectSurface(deps: SkillsSurfaceDependencies) {
  return createSkillsSurfaceMethods(deps).inspect;
}

export function createSkillsOperatorSurface(deps: SkillsSurfaceDependencies) {
  return createSkillsSurfaceMethods(deps).operator;
}
