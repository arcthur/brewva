import {
  loadBrewvaConfigResolution,
  normalizeExplicitBrewvaConfigResolution,
  type BrewvaConfigMetadata,
} from "../config/loader.js";
import type { BrewvaConfig } from "../config/types.js";
import { deepFreezeValue } from "../core/freeze.js";
import type { DeepReadonly } from "../core/index.js";
import type { BrewvaRuntimeOptions } from "./runtime-api.js";

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

  if (input.options.routingScopes && input.options.routingScopes.length > 0) {
    config.skills.routing.enabled = true;
    config.skills.routing.scopes = [...new Set(input.options.routingScopes)];
  } else if (
    input.options.routingDefaultScopes &&
    input.options.routingDefaultScopes.length > 0 &&
    !resolution.metadata.skills.routing.enabledExplicit
  ) {
    config.skills.routing.enabled = true;
    if (!resolution.metadata.skills.routing.scopesExplicit) {
      config.skills.routing.scopes = [...new Set(input.options.routingDefaultScopes)];
    }
  }

  return {
    config,
    readonlyConfig: deepFreezeValue(config),
    metadata: deepFreezeValue(resolution.metadata),
  };
}
