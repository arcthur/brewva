import type { BrewvaToolRuntime } from "../contracts/index.js";

export function listRuntimeSkills(
  runtime: BrewvaToolRuntime,
): ReturnType<BrewvaToolRuntime["capabilities"]["skills"]["catalog"]["list"]> {
  return runtime.capabilities.skills.catalog.list();
}
