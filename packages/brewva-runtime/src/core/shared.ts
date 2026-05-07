import type {
  RuntimeFailure as BrewvaRuntimeFailure,
  RuntimeSuccess as BrewvaRuntimeSuccess,
} from "./runtime-result.js";

export type VerificationLevel = "quick" | "standard" | "strict";

export type { JsonValue } from "@brewva/brewva-std/json";
export type { DeepReadonly } from "./deep-readonly.js";
export type { RuntimeFailure, RuntimeResult, RuntimeSuccess } from "./runtime-result.js";

type RollbackPathSet = {
  restoredPaths: string[];
  failedPaths: string[];
};

export type RollbackOutcome<Reason extends string> =
  | BrewvaRuntimeSuccess<RollbackPathSet>
  | (BrewvaRuntimeFailure<Reason> & RollbackPathSet);

export type SecurityEnforcementMode = "off" | "warn" | "enforce";

export type SecurityEnforcementPreference = SecurityEnforcementMode | "inherit";
