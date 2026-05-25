import {
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
  const config = resolution.config;

  return {
    config,
    readonlyConfig: deepFreezeValue(config),
    metadata: deepFreezeValue(resolution.metadata),
  };
}
