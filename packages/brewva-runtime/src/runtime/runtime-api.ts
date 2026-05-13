import type { BrewvaConfig } from "../config/types.js";
import type { DeepReadonly } from "../core/deep-readonly.js";
import type { GovernancePort } from "../domain/governance/api.js";
import type { SkillRoutingScope } from "../domain/skills/api.js";
import type { BrewvaRuntimeExtensions, BrewvaToolRuntimeExtensions } from "./runtime-extensions.js";
import type { RuntimeSemanticSurfaces } from "./runtime-surfaces.js";

export interface BrewvaRuntimeOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  governancePort?: GovernancePort;
  agentId?: string;
  routingScopes?: SkillRoutingScope[];
  routingDefaultScopes?: SkillRoutingScope[];
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

export interface BrewvaRuntimeIdentity {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly agentId: string;
}

export type BrewvaAuthorityPort = RuntimeSemanticSurfaces["authority"];
export type BrewvaInspectionPort = RuntimeSemanticSurfaces["inspect"];
export type RuntimeOperatorPort = RuntimeSemanticSurfaces["operator"];

export interface BrewvaRuntimeRoot {
  readonly identity: BrewvaRuntimeIdentity;
  readonly config: DeepReadonly<BrewvaConfig>;
  readonly authority: BrewvaAuthorityPort;
  readonly inspect: BrewvaInspectionPort;
}

export interface BrewvaRuntimeInstance {
  readonly root: BrewvaRuntimeRoot;
  readonly hosted: BrewvaHostedRuntimePort;
  readonly tool: BrewvaToolRuntimePort;
  readonly operator: BrewvaOperatorRuntimePort;
}

export interface BrewvaHostedRuntimePort extends BrewvaRuntimeRoot {
  readonly operator: RuntimeOperatorPort;
  readonly extensions: BrewvaRuntimeExtensions;
}

export interface BrewvaToolRuntimePort extends BrewvaRuntimeRoot {
  readonly extensions: BrewvaToolRuntimeExtensions;
}

export interface BrewvaOperatorRuntimePort extends Pick<
  BrewvaRuntimeRoot,
  "identity" | "config" | "inspect"
> {
  readonly operator: RuntimeOperatorPort;
}
