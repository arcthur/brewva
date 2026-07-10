import {
  formatBrewvaConfigWarning,
  loadBrewvaConfigResolution,
  normalizeExplicitBrewvaConfigResolution,
  type BrewvaConfigMetadata,
} from "../../config/loader.js";
import type { BrewvaConfig } from "../../config/types.js";
import { deepFreezeValue } from "../../core/freeze.js";
import type { DeepReadonly } from "../../core/index.js";
import type { BrewvaRuntimeOptions } from "../runtime-api.js";

export interface RuntimeConfigState {
  config: BrewvaConfig;
  readonlyConfig: DeepReadonly<BrewvaConfig>;
  metadata: DeepReadonly<BrewvaConfigMetadata>;
}

export function resolveRuntimeConfigState(input: {
  cwd: string;
  options: BrewvaRuntimeOptions;
}): RuntimeConfigState {
  const resolution = input.options.config
    ? normalizeExplicitBrewvaConfigResolution(input.options.config)
    : loadBrewvaConfigResolution({
        cwd: input.cwd,
        configPath: input.options.configPath,
      });
  // Every runtime creation funnels through here, so this is the single
  // visibility point for load advisories. Default to stderr (the CLI's
  // `[config:*]` convention): a stripped removed field the user cannot see is
  // a silent behavior change. Hosts pass onConfigWarning to capture instead.
  for (const warning of resolution.warnings) {
    if (input.options.onConfigWarning) {
      input.options.onConfigWarning(warning);
    } else {
      console.error(formatBrewvaConfigWarning(warning));
    }
  }
  const config = resolution.config;

  return {
    config,
    readonlyConfig: deepFreezeValue(config),
    metadata: deepFreezeValue(resolution.metadata),
  };
}
