import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { SkillRegistry } from "./registry.js";
import type {
  SkillDocument,
  SkillRefreshInput,
  SkillRefreshResult,
  SkillRegistryLoadReport,
} from "./types.js";

export interface SkillsSurfaceDependencies {
  skillRegistry: SkillRegistry;
  refreshSkillsState(input?: SkillRefreshInput): SkillRefreshResult;
}

export interface RuntimeSkillsSurfaceMethods {
  refresh(input?: SkillRefreshInput): SkillRefreshResult;
  getLoadReport(): SkillRegistryLoadReport;
  list(): SkillDocument[];
  get(name: string): SkillDocument | undefined;
}

export const skillsSurfaceContribution = {
  inspect: ["getLoadReport", "list", "get"],
  maintain: ["refresh"],
} as const satisfies SurfaceContribution<RuntimeSkillsSurfaceMethods>;

export function createSkillsSurfaceMethods(
  deps: SkillsSurfaceDependencies,
): RuntimeSkillsSurfaceMethods {
  return {
    refresh: (input?: SkillRefreshInput) => deps.refreshSkillsState(input),
    getLoadReport: () => deps.skillRegistry.getLoadReport(),
    list: () => deps.skillRegistry.list(),
    get: (name: string) => deps.skillRegistry.get(name),
  };
}

export const skillsRuntimeSurface = defineRuntimeSurfaceModule({
  name: "skills",
  createMethods: createSkillsSurfaceMethods,
  contribution: skillsSurfaceContribution,
});
