import type { DelegationPacket, SubagentRunRequest } from "@brewva/brewva-tools/contracts";
import type { DelegationModelRouteRecord } from "@brewva/brewva-vocabulary/delegation";
import type { ContextBundle } from "../context/api.js";
import type { DelegationTaskIdentity } from "./delegation-records.js";
import type { ResolvedDelegationExecutionPlan } from "./execution-plan.js";
import type { HostedDelegationTarget } from "./targets.js";

export interface DelegationRunPlan {
  readonly runId: string;
  readonly parentSessionId: string;
  readonly delegate: string;
  readonly packet: DelegationPacket;
  readonly target: HostedDelegationTarget;
  readonly executionPlan: ResolvedDelegationExecutionPlan;
  readonly taskIdentity: DelegationTaskIdentity;
  readonly modelRoute?: DelegationModelRouteRecord;
  readonly contextBundle: ContextBundle;
  readonly delivery: SubagentRunRequest["delivery"];
  readonly createdAt: number;
}

export function buildDelegationRunPlan(input: DelegationRunPlan): DelegationRunPlan {
  return Object.freeze({ ...input });
}
