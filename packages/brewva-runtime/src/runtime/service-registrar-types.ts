import type { BrewvaConfig } from "../config/types.js";
import type { VerificationLevel } from "../core/shared.js";
import type { ContextService } from "../domain/context/api.js";
import type { CostService } from "../domain/cost/api.js";
import type { SessionCostSummary } from "../domain/cost/api.js";
import type { CredentialVaultService } from "../domain/credentials/api.js";
import type { MutationRollbackService } from "../domain/governance/api.js";
import type { ReversibleMutationService } from "../domain/governance/api.js";
import type { GovernancePort } from "../domain/governance/api.js";
import type { ResolvedToolAuthority } from "../domain/governance/api.js";
import type { LedgerService } from "../domain/ledger/api.js";
import type { ParallelService } from "../domain/parallel/api.js";
import type { ResourceLeaseService } from "../domain/parallel/api.js";
import type { FileChangeService } from "../domain/patching/api.js";
import type { EffectCommitmentDeskService } from "../domain/proposals/api.js";
import type { ProposalAdmissionService } from "../domain/proposals/api.js";
import type { ReasoningService } from "../domain/reasoning/api.js";
import type { ToolLifecycleRecoveryWalService } from "../domain/recovery/api.js";
import type { ScheduleIntentService } from "../domain/schedule/api.js";
import type { EventPipelineService } from "../domain/sessions/api.js";
import type { SessionLifecycleSnapshot } from "../domain/sessions/api.js";
import type { SessionLifecycleService } from "../domain/sessions/api.js";
import type { SessionLineageService } from "../domain/sessions/api.js";
import type { SessionRewindService } from "../domain/sessions/api.js";
import type { RuntimeSessionStateStore } from "../domain/sessions/api.js";
import type { SessionWireService } from "../domain/sessions/api.js";
import type { SkillLifecycleService } from "../domain/skills/api.js";
import type { TapeService } from "../domain/tape/api.js";
import type { TaskWatchdogService } from "../domain/task/api.js";
import type { TaskService } from "../domain/task/api.js";
import type { ToolGateService } from "../domain/tools/api.js";
import type { ToolInvocationSpine } from "../domain/tools/api.js";
import type { TruthService } from "../domain/truth/api.js";
import type { VerificationReport } from "../domain/verification/api.js";
import type { VerificationService } from "../domain/verification/api.js";
import type { RuntimeCoreDependencies } from "./core-registrar.js";
import type { RuntimeKernelContext } from "./runtime-kernel.js";

/*
 * composition root
 *   -> group registrar (governance / work / context / session / lazy)
 *     -> domain registrar (domain/<name>/registrar.ts)
 *       -> domain-owned services, surface contributions, and event ownership
 */
export interface RuntimeServiceDependencies {
  skillLifecycleService: SkillLifecycleService;
  taskService: TaskService;
  truthService: TruthService;
  ledgerService: LedgerService;
  costService: CostService;
  contextService: ContextService;
  taskWatchdogService: TaskWatchdogService;
  eventPipeline: EventPipelineService;
  toolLifecycleRecoveryWalService: ToolLifecycleRecoveryWalService;
  sessionLifecycleService: SessionLifecycleService;
  sessionLineageService: SessionLineageService;
  reversibleMutationService: ReversibleMutationService;
  getTapeService(): TapeService;
  getEffectCommitmentDeskService(): EffectCommitmentDeskService;
  getProposalAdmissionService(): ProposalAdmissionService;
  clearEffectCommitmentDeskState(sessionId: string): void;
}

export interface RuntimeLazyServiceFactories {
  createCredentialVaultService(): CredentialVaultService;
  createSessionRewindService(): SessionRewindService;
  createFileChangeService(): FileChangeService;
  createMutationRollbackService(): MutationRollbackService;
  createParallelService(): ParallelService;
  createReasoningService(): ReasoningService;
  createResourceLeaseService(): ResourceLeaseService;
  createScheduleIntentService(): ScheduleIntentService;
  createSessionWireService(): SessionWireService;
  createToolGateService(): ToolGateService;
  createToolInvocationSpine(): ToolInvocationSpine;
  createVerificationService(): VerificationService;
}

export interface RuntimeServiceRegistrarOptions {
  cwd: string;
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  governancePort?: GovernancePort;
  kernel: RuntimeKernelContext;
  coreDependencies: RuntimeCoreDependencies;
  sessionState: RuntimeSessionStateStore;
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  resolveCheckpointCostSummary(sessionId: string): SessionCostSummary;
  resolveCheckpointCostSkillLastTurnByName(sessionId: string): Record<string, number>;
  evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport;
}

export interface RuntimeLazyServiceRegistrarOptions {
  cwd: string;
  workspaceRoot: string;
  config: BrewvaConfig;
  governancePort?: GovernancePort;
  kernel: RuntimeKernelContext;
  coreDependencies: RuntimeCoreDependencies;
  sessionState: RuntimeSessionStateStore;
  eventPipeline: EventPipelineService;
  contextService: ContextService;
  getProposalAdmissionService(): ProposalAdmissionService;
  getEffectCommitmentDeskService(): EffectCommitmentDeskService;
  skillLifecycleService: SkillLifecycleService;
  ledgerService: LedgerService;
  reversibleMutationService: ReversibleMutationService;
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  getSessionLifecycleSnapshot(sessionId: string): SessionLifecycleSnapshot;
}

export interface RuntimeGovernanceServices {
  reversibleMutationService: ReversibleMutationService;
  getEffectCommitmentDeskService(): EffectCommitmentDeskService;
  getProposalAdmissionService(): ProposalAdmissionService;
  clearEffectCommitmentDeskState(sessionId: string): void;
}

export interface RuntimeWorkServices {
  taskService: TaskService;
  taskWatchdogService: TaskWatchdogService;
  skillLifecycleService: SkillLifecycleService;
  truthService: TruthService;
  ledgerService: LedgerService;
  costService: CostService;
}

export interface RuntimeContextServices {
  contextService: ContextService;
}

export interface RuntimeSessionServices {
  eventPipeline: EventPipelineService;
  toolLifecycleRecoveryWalService: ToolLifecycleRecoveryWalService;
  sessionLifecycleService: SessionLifecycleService;
  sessionLineageService: SessionLineageService;
  getTapeService(): TapeService;
}
