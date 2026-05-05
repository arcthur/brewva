import type { BoxPlane } from "@brewva/brewva-box";
import type {
  BrewvaToolRuntimeExtensions as RuntimeToolRuntimeExtensions,
  BrewvaToolRuntimeExtensionMethods,
  BrewvaToolRuntimePort as RuntimeToolRuntimePort,
  DelegationConsultKind as RuntimeDelegationConsultKind,
  DesignExecutionStep as RuntimeDesignExecutionStep,
  DesignImplementationTarget as RuntimeDesignImplementationTarget,
  DesignRiskItem as RuntimeDesignRiskItem,
  DelegationRunQuery,
  DelegationRunRecord,
  ManagedToolMode,
  PatchSet,
  QaCheck as RuntimeQaCheck,
  QaSubagentOutcomeData as RuntimeQaSubagentOutcomeData,
  ReviewLaneName as RuntimeReviewLaneName,
  SkillOutputValidationResult,
  ToolActionClass,
  ToolExecutionBoundary,
} from "@brewva/brewva-runtime";
import type { BrewvaQuestionPrompt } from "@brewva/brewva-substrate/host-api";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type {
  ToolDescriptor as CanonicalToolDescriptor,
  ToolExecutionTraitResolverInput as CanonicalToolExecutionTraitResolverInput,
  ToolExecutionTraits as CanonicalToolExecutionTraits,
} from "@brewva/brewva-tool-protocol";
import type { TSchema } from "@sinclair/typebox";
import type { BrewvaSemanticReranker } from "./semantic-reranker.js";

export type BrewvaToolSurface = "base" | "skill" | "control_plane" | "operator";

export type BrewvaToolInterruptBehavior = "cancel" | "block" | "allow_completion";

export type BrewvaToolRequiredCapability =
  | "authority.events.recordGuardResult"
  | "authority.events.recordMetricObservation"
  | "authority.tape.recordTapeHandoff"
  | "authority.reasoning.recordCheckpoint"
  | "authority.reasoning.revert"
  | "authority.schedule.cancelIntent"
  | "authority.schedule.createIntent"
  | "authority.schedule.updateIntent"
  | "authority.session.applyMergedWorkerResults"
  | "authority.session.recordRewindCheckpoint"
  | "authority.session.redo"
  | "authority.session.rewind"
  | "authority.skills.activate"
  | "authority.skills.complete"
  | "authority.skills.recordCompletionFailure"
  | "authority.task.addItem"
  | "authority.task.recordAcceptance"
  | "authority.task.recordBlocker"
  | "authority.task.resolveBlocker"
  | "authority.task.setSpec"
  | "authority.task.updateItem"
  | "authority.tools.acquireParallelSlotAsync"
  | "authority.tools.requestResourceLease"
  | "authority.tools.cancelResourceLease"
  | "authority.tools.releaseParallelSlot"
  | "authority.tools.rollbackLastPatchSet"
  | "authority.verification.verify"
  | "inspect.context.getCompactionInstructions"
  | "inspect.context.getPressureStatus"
  | "inspect.context.getUsageRatio"
  | "inspect.context.getPromptStability"
  | "inspect.context.getTransientReduction"
  | "inspect.context.getUsage"
  | "inspect.cost.getSummary"
  | "inspect.events.getLogPath"
  | "inspect.tape.getTapeStatus"
  | "inspect.events.list"
  | "inspect.events.listSessionIds"
  | "inspect.events.listGuardResults"
  | "inspect.events.listMetricObservations"
  | "inspect.events.query"
  | "inspect.events.queryStructured"
  | "inspect.tape.searchTape"
  | "inspect.events.subscribe"
  | "inspect.ledger.query"
  | "inspect.reasoning.getActiveState"
  | "inspect.schedule.getProjectionSnapshot"
  | "inspect.schedule.listIntents"
  | "inspect.session.getOpenToolCalls"
  | "inspect.session.getRewindState"
  | "inspect.session.getUncleanShutdownDiagnostic"
  | "inspect.session.listRewindTargets"
  | "inspect.session.listWorkerResults"
  | "inspect.session.mergeWorkerResults"
  | "inspect.skills.getActive"
  | "inspect.skills.getActiveState"
  | "inspect.skills.getConsumedOutputs"
  | "inspect.skills.getLatestFailure"
  | "inspect.skills.getLoadReport"
  | "inspect.skills.getReadiness"
  | "inspect.skills.list"
  | "inspect.skills.validateOutputs"
  | "inspect.task.getState"
  | "inspect.task.getTargetDescriptor"
  | "inspect.tools.explainAccess"
  | "inspect.tools.listResourceLeases"
  | "extensions.tools.recordEvent"
  | "extensions.tools.onClearState"
  | "extensions.tools.appendGuardedSupplementalBlocks"
  | "extensions.tools.resolveCredentialBindings";

export interface BrewvaToolExecutionTraits extends CanonicalToolExecutionTraits {
  concurrencySafe: boolean;
  interruptBehavior: BrewvaToolInterruptBehavior;
  streamingEligible: boolean;
  contextModifying: boolean;
}

export interface BrewvaToolExecutionTraitResolverInput extends Omit<
  CanonicalToolExecutionTraitResolverInput,
  "cwd"
> {
  toolName: string;
  args: unknown;
  cwd?: string | null;
}

export type BrewvaToolExecutionTraitsResolver = (
  input: BrewvaToolExecutionTraitResolverInput,
) => BrewvaToolExecutionTraits | Partial<BrewvaToolExecutionTraits> | undefined;

export type BrewvaToolExecutionTraitsDefinition =
  | BrewvaToolExecutionTraits
  | BrewvaToolExecutionTraitsResolver;

export type BrewvaToolDescriptor<TParameters extends TSchema = TSchema> = Omit<
  CanonicalToolDescriptor<TParameters>,
  "surface" | "actionClass" | "executionTraits" | "requiredCapabilities"
> & {
  surface?: BrewvaToolSurface;
  actionClass?: ToolActionClass;
  executionTraits?: BrewvaToolExecutionTraits;
  requiredCapabilities?: readonly BrewvaToolRequiredCapability[];
};

export interface BrewvaToolMetadata {
  surface: BrewvaToolSurface;
  actionClass: ToolActionClass;
  executionTraits?: BrewvaToolExecutionTraitsDefinition;
  requiredCapabilities?: readonly BrewvaToolRequiredCapability[];
}

export type BrewvaToolRuntimeToolsExtension = Partial<Readonly<BrewvaToolRuntimeExtensionMethods>>;

export interface BrewvaToolRuntimeExtensions {
  readonly tools?: BrewvaToolRuntimeToolsExtension | RuntimeToolRuntimeExtensions["tools"];
}

export interface BrewvaToolMetadataCarrier {
  name: string;
  parameters?: TSchema;
  brewva?: BrewvaToolMetadata;
  brewvaExecutionTraits?: BrewvaToolExecutionTraitsDefinition;
  brewvaAgentParameters?: TSchema;
  brewvaDescriptor?: BrewvaToolDescriptor;
}

export type BrewvaManagedToolDefinition = ToolDefinition & {
  brewva?: BrewvaToolMetadata;
  brewvaExecutionTraits?: BrewvaToolExecutionTraitsDefinition;
  brewvaAgentParameters?: TSchema;
  brewvaDescriptor?: BrewvaToolDescriptor;
};

export type AdvisorConsultKind = RuntimeDelegationConsultKind;
export type SubagentResultMode = "consult" | "qa" | "patch";
export type SubagentDelegationMode = "single" | "parallel";
export type SubagentReturnMode = "text_only" | "supplemental";
export type DelegationRefKind =
  | "event"
  | "ledger"
  | "artifact"
  | "projection"
  | "workspace_span"
  | "task"
  | "truth"
  | "tool_result";
export type SubagentContextRefKind = Exclude<DelegationRefKind, "tool_result"> | "tool_result";
export type SubagentExecutionBoundary = ToolExecutionBoundary;
export type SubagentForkContextPolicy = "lineage_only" | "working_snapshot";

export interface SubagentContextBudget {
  maxInjectionTokens?: number;
  maxTurnTokens?: number;
}

export interface DelegationRef {
  kind: DelegationRefKind;
  locator: string;
  summary?: string;
  sourceSessionId?: string;
  hash?: string;
}

export type SubagentContextRef = DelegationRef;

export interface SubagentExecutionHints {
  preferredTools?: string[];
  fallbackTools?: string[];
  preferredSkills?: string[];
}

export interface AdvisorConsultBrief {
  decision: string;
  successCriteria: string;
  currentBestGuess?: string;
  assumptions?: string[];
  rejectedPaths?: string[];
  focusAreas?: string[];
}

export interface SubagentExecutionShape {
  resultMode?: SubagentResultMode;
  boundary?: SubagentExecutionBoundary;
  model?: string;
  managedToolMode?: ManagedToolMode;
}

export type DelegationCompletionPredicate =
  | {
      source: "events";
      type: string;
      match?: Record<string, string | number | boolean | null>;
      policy: "cancel_when_true";
    }
  | {
      source: "worker_results";
      workerId?: string;
      status?: "ok" | "error" | "skipped";
      policy: "cancel_when_true";
    };

export interface DelegationPacket {
  objective: string;
  deliverable?: string;
  consultBrief?: AdvisorConsultBrief;
  constraints?: string[];
  sharedNotes?: string[];
  activeSkillName?: string;
  executionHints?: SubagentExecutionHints;
  contextRefs?: SubagentContextRef[];
  contextBudget?: SubagentContextBudget;
  completionPredicate?: DelegationCompletionPredicate;
  effectCeiling?: {
    boundary?: SubagentExecutionBoundary;
  };
}

export interface DelegationTaskPacket extends DelegationPacket {
  label?: string;
}

export interface SubagentRunRequest {
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  consultKind?: AdvisorConsultKind;
  fallbackResultMode?: SubagentResultMode;
  executionShape?: SubagentExecutionShape;
  mode: SubagentDelegationMode;
  packet?: DelegationPacket;
  tasks?: DelegationTaskPacket[];
  timeoutMs?: number;
  delivery?: {
    returnMode: SubagentReturnMode;
    returnLabel?: string;
    returnScopeId?: string;
  };
}

export interface SubagentForkRequest {
  objective: string;
  deliverable?: string;
  contextPolicy?: SubagentForkContextPolicy;
  timeoutMs?: number;
  delivery?: {
    returnMode: SubagentReturnMode;
    returnLabel?: string;
    returnScopeId?: string;
  };
}

export interface SubagentOutcomeMetricSummary {
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export type SubagentOutcomeEvidenceRef = DelegationRef;

export interface SubagentOutcomeArtifactRef {
  kind: string;
  path: string;
  summary?: string;
}

export interface DelegationOutcomeFinding {
  summary: string;
  severity?: "critical" | "high" | "medium" | "low";
  evidenceRefs?: string[];
}

export interface DelegationOutcomeCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  summary?: string;
  evidenceRefs?: string[];
}

export interface DelegationOutcomeChange {
  path: string;
  action?: "add" | "modify" | "delete";
  summary?: string;
  evidenceRefs?: string[];
}

export type AdvisorConsultConfidence = "low" | "medium" | "high";

export interface DelegatedQuestionRequest {
  title?: string;
  questions: BrewvaQuestionPrompt[];
}

export interface AdvisorConsultOutcomeBase {
  kind: "consult";
  consultKind: AdvisorConsultKind;
  conclusion: string;
  confidence?: AdvisorConsultConfidence;
  evidence?: string[];
  counterevidence?: string[];
  risks?: string[];
  followUpQuestions?: string[];
  questionRequests?: DelegatedQuestionRequest[];
  recommendedNextSteps?: string[];
}

export interface AdvisorInvestigateSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "investigate";
  findings?: DelegationOutcomeFinding[];
  ownershipHints?: string[];
  recommendedReads?: string[];
}

export type PlanExecutionStep = RuntimeDesignExecutionStep;

export type PlanImplementationTarget = RuntimeDesignImplementationTarget;

export type PlanRiskItem = RuntimeDesignRiskItem;

export interface AdvisorDiagnoseHypothesis {
  hypothesis: string;
  likelihood?: AdvisorConsultConfidence;
  evidence?: string[];
  gaps?: string[];
}

export interface AdvisorDiagnoseSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "diagnose";
  hypotheses: AdvisorDiagnoseHypothesis[];
  likelyRootCause: string;
  nextProbe: string;
}

export interface AdvisorDesignOption {
  option: string;
  summary: string;
  tradeoffs?: string[];
}

export interface AdvisorDesignSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "design";
  options: AdvisorDesignOption[];
  recommendedOption: string;
  boundaryImplications: string[];
  verificationPlan: string[];
}

export type ReviewLaneName = RuntimeReviewLaneName;

export type ReviewLaneDisposition = "clear" | "concern" | "blocked" | "inconclusive";

export type ReviewLaneConfidence = "low" | "medium" | "high";

export interface AdvisorReviewSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "review";
  lane?: ReviewLaneName;
  disposition?: ReviewLaneDisposition;
  mergePosture?: "ready" | "needs_changes" | "blocked" | "inconclusive";
  primaryClaim?: string;
  findings?: DelegationOutcomeFinding[];
  strongestCounterpoint?: string;
  missingEvidence?: string[];
  confidence?: ReviewLaneConfidence;
}

export type QaCheck = RuntimeQaCheck;
export type QaSubagentOutcomeData = RuntimeQaSubagentOutcomeData;

export interface PatchSubagentOutcomeData {
  kind: "patch";
  changes?: DelegationOutcomeChange[];
  patchSummary?: string;
}

export type AdvisorSubagentOutcomeData =
  | AdvisorInvestigateSubagentOutcomeData
  | AdvisorDiagnoseSubagentOutcomeData
  | AdvisorDesignSubagentOutcomeData
  | AdvisorReviewSubagentOutcomeData;

export type SubagentOutcomeData =
  | AdvisorSubagentOutcomeData
  | QaSubagentOutcomeData
  | PatchSubagentOutcomeData;

export interface SubagentOutcomeBase {
  runId: string;
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  label?: string;
  kind: SubagentResultMode;
  consultKind?: AdvisorConsultKind;
  status: "ok" | "error" | "cancelled" | "timeout";
  workerSessionId?: string;
  summary: string;
  assistantText?: string;
  data?: SubagentOutcomeData;
  skillOutputs?: Record<string, unknown>;
  skillValidation?: SkillOutputValidationResult;
  metrics: SubagentOutcomeMetricSummary;
  evidenceRefs: SubagentOutcomeEvidenceRef[];
  patches?: PatchSet;
  artifactRefs?: SubagentOutcomeArtifactRef[];
}

export interface SubagentOutcomeSuccess extends SubagentOutcomeBase {
  ok: true;
  status: "ok";
}

export interface SubagentOutcomeFailure {
  ok: false;
  runId: string;
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  label?: string;
  consultKind?: AdvisorConsultKind;
  status: "error" | "cancelled" | "timeout";
  workerSessionId?: string;
  error: string;
  metrics: SubagentOutcomeMetricSummary;
  artifactRefs?: SubagentOutcomeArtifactRef[];
}

export type SubagentOutcome = SubagentOutcomeSuccess | SubagentOutcomeFailure;

export type SubagentRunSuccessResult = {
  ok: true;
  mode: SubagentDelegationMode;
  delegate: string;
  outcomes: SubagentOutcomeSuccess[];
};

export type SubagentRunFailureResult = {
  ok: false;
  mode: SubagentDelegationMode;
  delegate: string;
  outcomes: SubagentOutcome[];
  error: string;
};

export type SubagentRunResult = SubagentRunSuccessResult | SubagentRunFailureResult;

export type SubagentStartSuccessResult = {
  ok: true;
  mode: SubagentDelegationMode;
  delegate: string;
  runs: DelegationRunRecord[];
};

export type SubagentStartFailureResult = {
  ok: false;
  mode: SubagentDelegationMode;
  delegate: string;
  runs: DelegationRunRecord[];
  error: string;
};

export type SubagentStartResult = SubagentStartSuccessResult | SubagentStartFailureResult;

export type SubagentStatusRunView = DelegationRunRecord & {
  live?: boolean;
  cancelable?: boolean;
};

export type SubagentStatusSuccessResult = {
  ok: true;
  runs: SubagentStatusRunView[];
};

export type SubagentStatusFailureResult = {
  ok: false;
  runs: SubagentStatusRunView[];
  error: string;
};

export type SubagentStatusResult = SubagentStatusSuccessResult | SubagentStatusFailureResult;

export type SubagentCancelSuccessResult = {
  ok: true;
  run: SubagentStatusRunView;
};

export type SubagentCancelFailureResult = {
  ok: false;
  error: string;
  run?: SubagentStatusRunView;
};

export type SubagentCancelResult = SubagentCancelSuccessResult | SubagentCancelFailureResult;

export type SubagentForkSuccessResult = {
  ok: true;
  run: DelegationRunRecord;
};

export type SubagentForkFailureResult = {
  ok: false;
  error: string;
  run?: DelegationRunRecord;
};

export type SubagentForkResult = SubagentForkSuccessResult | SubagentForkFailureResult;

export type A2ASendSuccessResult = {
  ok: true;
  toAgentId: string;
  responseText: string;
  depth?: number;
  hops?: number;
};

export type A2ASendFailureResult = {
  ok: false;
  toAgentId: string;
  error: string;
  depth?: number;
  hops?: number;
};

export type A2ASendResult = A2ASendSuccessResult | A2ASendFailureResult;

export type A2ABroadcastResult =
  | {
      ok: true;
      results: A2ASendSuccessResult[];
    }
  | {
      ok: false;
      error: string;
      results: A2ASendResult[];
    };

export interface BrewvaToolOrchestration {
  a2a?: {
    send(input: {
      fromSessionId: string;
      fromAgentId?: string;
      toAgentId: string;
      message: string;
      correlationId?: string;
      depth?: number;
      hops?: number;
    }): Promise<A2ASendResult>;
    broadcast(input: {
      fromSessionId: string;
      fromAgentId?: string;
      toAgentIds: string[];
      message: string;
      correlationId?: string;
      depth?: number;
      hops?: number;
    }): Promise<A2ABroadcastResult>;
    listAgents(input?: { includeDeleted?: boolean }): Promise<
      Array<{
        agentId: string;
        status: "active" | "deleted";
      }>
    >;
  };
  subagents?: {
    run(input: { fromSessionId: string; request: SubagentRunRequest }): Promise<SubagentRunResult>;
    start?(input: {
      fromSessionId: string;
      request: SubagentRunRequest;
    }): Promise<SubagentStartResult>;
    status?(input: {
      fromSessionId: string;
      query?: DelegationRunQuery;
    }): Promise<SubagentStatusResult>;
    cancel?(input: {
      fromSessionId: string;
      runId: string;
      reason?: string;
    }): Promise<SubagentCancelResult>;
    fork?(input: {
      fromSessionId: string;
      request: SubagentForkRequest;
    }): Promise<SubagentForkResult>;
  };
}

export interface BrewvaToolDelegationQuery {
  listRuns?(
    sessionId: string,
    query?: Pick<DelegationRunQuery, "runIds" | "statuses" | "includeTerminal" | "limit">,
  ): DelegationRunRecord[];
  listPendingOutcomes?(sessionId: string, query?: { limit?: number }): DelegationRunRecord[];
}

type BrewvaToolRuntimeBase = Pick<
  RuntimeToolRuntimePort,
  "cwd" | "workspaceRoot" | "agentId" | "config" | "authority" | "inspect"
>;

export type BrewvaToolRuntime = BrewvaToolRuntimeBase & {
  extensions?: BrewvaToolRuntimeExtensions;
  orchestration?: BrewvaToolOrchestration;
  delegation?: BrewvaToolDelegationQuery;
  semanticReranker?: BrewvaSemanticReranker;
};

type CapabilityScopedMethod<
  TMethod,
  TCapability extends string,
  TCapabilities extends string,
> = TMethod extends (...args: infer TArgs) => infer TResult
  ? TCapability extends TCapabilities
    ? (...args: TArgs) => TResult
    : never
  : TMethod;

type CapabilityScopedRuntimePort<
  TPort extends object,
  TPrefix extends "authority" | "inspect",
  TGroupName extends string,
  TCapabilities extends string,
> = {
  [TMethodName in keyof TPort]: CapabilityScopedMethod<
    TPort[TMethodName],
    `${TPrefix}.${TGroupName}.${Extract<TMethodName, string>}`,
    TCapabilities
  >;
};

type CapabilityScopedRuntimeGroup<
  TGroupMap extends object,
  TPrefix extends "authority" | "inspect",
  TCapabilities extends string,
> = {
  [TGroupName in keyof TGroupMap]: TGroupMap[TGroupName] extends object
    ? CapabilityScopedRuntimePort<
        TGroupMap[TGroupName],
        TPrefix,
        Extract<TGroupName, string>,
        TCapabilities
      >
    : TGroupMap[TGroupName];
};

type CapabilityScopedToolRuntimeExtensions<TCapabilities extends string> = {
  [TMethodName in keyof BrewvaToolRuntimeToolsExtension]: CapabilityScopedMethod<
    BrewvaToolRuntimeToolsExtension[TMethodName],
    `extensions.tools.${Extract<TMethodName, string>}`,
    TCapabilities
  >;
};

export type CapabilityScopedBrewvaToolRuntime<
  TRuntime extends BrewvaToolRuntime | undefined,
  TCapabilities extends string,
> = TRuntime extends undefined
  ? undefined
  : Omit<TRuntime, "authority" | "inspect" | "extensions"> & {
      authority: CapabilityScopedRuntimeGroup<
        RuntimeToolRuntimePort["authority"],
        "authority",
        TCapabilities
      >;
      inspect: CapabilityScopedRuntimeGroup<
        RuntimeToolRuntimePort["inspect"],
        "inspect",
        TCapabilities
      >;
      extensions?: {
        tools?: CapabilityScopedToolRuntimeExtensions<TCapabilities>;
      };
    };

export type BrewvaBundledToolRuntime = BrewvaToolRuntime & {
  orchestration?: BrewvaToolOrchestration;
  delegation?: BrewvaToolDelegationQuery;
  semanticReranker?: BrewvaSemanticReranker;
  boxPlane?: BoxPlane;
};

export interface BrewvaBundledToolOptions {
  runtime: BrewvaBundledToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}

export interface BrewvaToolOptions {
  runtime: BrewvaToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}
