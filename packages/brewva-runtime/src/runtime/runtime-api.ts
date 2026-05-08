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
  readonly config: DeepReadonly<BrewvaConfig>;
}

export type BrewvaAuthorityPort = RuntimeSemanticSurfaces["authority"];
export type BrewvaInspectionPort = RuntimeSemanticSurfaces["inspect"];
export type BrewvaMaintenancePort = RuntimeSemanticSurfaces["maintain"];

export interface BrewvaHostedRuntimePort extends BrewvaRuntimeIdentity {
  readonly authority: BrewvaAuthorityPort;
  readonly inspect: BrewvaInspectionPort;
  readonly maintain: BrewvaMaintenancePort;
  readonly extensions: BrewvaRuntimeExtensions;
}

export interface BrewvaToolRuntimePort extends BrewvaRuntimeIdentity {
  readonly authority: BrewvaAuthorityPort;
  readonly inspect: BrewvaInspectionPort;
  readonly maintain: Pick<BrewvaMaintenancePort, "workbench">;
  readonly extensions: BrewvaToolRuntimeExtensions;
}

export interface BrewvaOperatorRuntimePort extends BrewvaRuntimeIdentity {
  readonly inspect: BrewvaInspectionPort;
  readonly maintain: Pick<BrewvaMaintenancePort, "session" | "recovery">;
}
