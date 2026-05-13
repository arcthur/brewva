import type { BrewvaConfig } from "../config/types.js";
import type { VerificationLevel } from "../core/shared.js";
import type { VerificationOutcomeSnapshot } from "../domain/context/api.js";
import type { SessionCostSummary } from "../domain/cost/api.js";
import type { GovernancePort } from "../domain/governance/api.js";
import type { ResolvedToolAuthority } from "../domain/governance/api.js";
import type { SessionLifecycleSnapshot } from "../domain/sessions/api.js";
import type { VerificationReport } from "../domain/verification/api.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";
import type { RuntimeCoreDependencies } from "./wiring.js";
import type { RuntimeLazyServiceFactories, RuntimeServiceDependencies } from "./wiring.js";

export type { RuntimeCoreDependencies } from "./wiring.js";
export type { RuntimeLazyServiceFactories, RuntimeServiceDependencies } from "./wiring.js";

export interface RuntimeCompositionInput {
  cwd: string;
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  governancePort?: GovernancePort;
  sessionState: RuntimeKernelContext["sessionState"];
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  getCurrentTurn: (sessionId: string) => number;
  getTaskState: (sessionId: string) => ReturnType<RuntimeKernelContext["getTaskState"]>;
  getClaimState: (sessionId: string) => ReturnType<RuntimeKernelContext["getClaimState"]>;
  recordEvent: RuntimeKernelContext["recordEvent"];
  sanitizeInput: RuntimeKernelContext["sanitizeInput"];
  getLatestVerificationOutcome: (sessionId: string) => VerificationOutcomeSnapshot | undefined;
  isContextBudgetEnabled: () => boolean;
  resolveCheckpointCostSummary: (sessionId: string) => SessionCostSummary;
  resolveCheckpointCostSkillLastTurnByName: (sessionId: string) => Record<string, number>;
  evaluateCompletion: (sessionId: string, level?: VerificationLevel) => VerificationReport;
  getSessionLifecycleSnapshot: (sessionId: string) => SessionLifecycleSnapshot;
}

export interface RuntimeComposition {
  coreDependencies: RuntimeCoreDependencies;
  kernel: RuntimeKernelContext;
  serviceDependencies: RuntimeServiceDependencies;
  lazyServiceFactories: RuntimeLazyServiceFactories;
}
