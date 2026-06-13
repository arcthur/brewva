import { resolve } from "node:path";
import { isRecord } from "@brewva/brewva-std/unknown";
import { resolveWorkspaceRootDir } from "../config/paths.js";
import { resolveRuntimeConfigState } from "./config/state.js";
import { createKernelPort } from "./kernel/impl.js";
import { createModelPort } from "./model/impl.js";
import type {
  BrewvaRuntime,
  BrewvaRuntimeOptions,
  RuntimeStartReceipt,
  SessionId,
  TapeCommitPort,
  RuntimeToolAuthorityResolver,
} from "./runtime-api.js";
import { CANONICAL_EVENT_TYPES, RUNTIME_RECOVERY_CAUSES } from "./runtime-api.js";
import { createRuntimeTape } from "./tape/impl.js";
import {
  createRuntimePhysicsCommitPort,
  createRuntimePhysicsTurnRunner,
  normalizeRuntimePhysics,
  recoveredSessionsForRuntimePhysics,
  replayEventsForRuntimePhysics,
  runtimePhysicsUsesDurableTape,
} from "./turn/physics.js";

export { CANONICAL_EVENT_TYPES, RUNTIME_RECOVERY_CAUSES };

export type {
  AbortToolCallInput,
  AdvisoryEventInput,
  AdvisoryEventReceipt,
  AnchorCommittedPayload,
  ApprovalDecidedPayload,
  ApprovalRequest,
  ApprovalRequestedPayload,
  Baseline,
  BaselineView,
  BrewvaRuntime,
  BrewvaRuntimeIdentity,
  BrewvaRuntimeOptions,
  CanonicalEvent,
  CanonicalEventBase,
  CanonicalEventCommitInput,
  CanonicalEventFor,
  CanonicalEventType,
  CheckpointCandidate,
  CheckpointCommittedPayload,
  CheckpointProposalInput,
  CommitToolResultInput,
  CostSummaryView,
  CostObservedPayload,
  CustomEventPayload,
  EventId,
  KernelPort,
  KernelInterceptPort,
  KernelInterceptorRegistration,
  KernelShadowEvidenceEntry,
  KernelShadowEvidenceQuery,
  KernelShadowToolAuthorityInput,
  KernelShadowToolAuthorityPhysics,
  KernelToolAuthorityDecisionEvidence,
  KernelVerificationGatePolicyInput,
  KernelVerificationGatePosture,
  KernelVerificationGateStatus,
  MaterializationInput,
  ModelMaterializationObservation,
  ModelMaterializationObservationQuery,
  ModelObservePort,
  ModelPort,
  PromptBlock,
  PromptContent,
  PromptContentPart,
  PromptFileContentPart,
  PromptImageContentPart,
  PromptMessage,
  PromptPlan,
  PromptToolCall,
  PromptTextContentPart,
  RecoveryHistoryView,
  RuntimeBudget,
  RuntimeProviderFrame,
  RuntimeProviderInput,
  RuntimeProviderPort,
  RuntimeProviderToolCall,
  RuntimeRecoveryCause,
  RuntimePhysicsDeclaration,
  RuntimeReplaySource,
  RuntimeReplayTarget,
  RuntimeStartReceipt,
  RuntimeSuspendedPayload,
  RuntimeToolAuthorityResolver,
  RuntimeToolExecutorInput,
  RuntimeToolExecutorPort,
  ResolveApprovalDecisionInput,
  SessionId,
  StepProjectionAuthority,
  StepProjectionRecord,
  StepProjectionStatus,
  StepProjectionView,
  TapePort,
  TapeQuery,
  TapeView,
  TapeViewName,
  TextCommittedPayload,
  ToolAbortReceipt,
  ToolAbortedPayload,
  ToolAuthorityDecisionPayload,
  ToolCallProposal,
  ToolCommitment,
  ToolCommitmentDecision,
  ToolCommitReceipt,
  ToolCommitmentsView,
  ToolCommittedPayload,
  ToolExecutionOutcome,
  ToolExecutionResult,
  ToolExecutionResultContent,
  ToolProposedPayload,
  TurnFrame,
  TurnInput,
  TurnStartedPayload,
  TurnEndedPayload,
  TurnStateView,
} from "./runtime-api.js";

function freezePort<TPort extends object>(port: TPort): Readonly<TPort> {
  return Object.freeze(port);
}

function normalizeRuntimeAgentId(raw: string | undefined): string {
  if (typeof raw !== "string") {
    return "default";
  }
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "default";
}

function resolveRuntimeIdentity(options: BrewvaRuntimeOptions): BrewvaRuntime["identity"] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRootDir(cwd);
  const agentId = normalizeRuntimeAgentId(options.agentId ?? process.env["BREWVA_AGENT_ID"]);
  return { cwd, workspaceRoot, agentId };
}

function createFourPortRuntimeAssembly(input: {
  readonly identity: BrewvaRuntime["identity"];
  readonly config: BrewvaRuntime["config"];
  readonly runtimeTape: ReturnType<typeof createRuntimeTape>;
  readonly commit: TapeCommitPort;
  readonly resolveToolAuthority?: RuntimeToolAuthorityResolver;
  readonly recoveredSessions?: readonly SessionId[];
  readonly createTurn: (ports: {
    readonly kernel: BrewvaRuntime["kernel"];
    readonly model: BrewvaRuntime["model"];
  }) => BrewvaRuntime["turn"];
}): BrewvaRuntime {
  const kernel = createKernelPort(input.commit, input.runtimeTape.tape, {
    actionAdmissionOverrides: input.config.security.actionAdmissionOverrides,
    resolveToolAuthority: input.resolveToolAuthority,
  });
  const model = createModelPort(input.runtimeTape.tape);
  const turn = input.createTurn({ kernel, model });
  const runtime: BrewvaRuntime = {
    identity: input.identity,
    config: input.config,
    tape: input.runtimeTape.tape,
    kernel,
    model,
    async start(): Promise<RuntimeStartReceipt> {
      return { recoveredSessions: input.recoveredSessions ?? input.runtimeTape.loadFromDisk() };
    },
    turn,
    async close(): Promise<void> {
      await input.runtimeTape.close();
    },
  };
  return freezePort(runtime);
}

export function createBrewvaRuntime(options: BrewvaRuntimeOptions): BrewvaRuntime {
  if (!isRecord(options)) {
    throw new Error("runtime_options_required");
  }
  const runtimeOptions = options;
  const physics = normalizeRuntimePhysics(runtimeOptions.physics);
  const identity = resolveRuntimeIdentity(runtimeOptions);
  const configState = resolveRuntimeConfigState({
    cwd: identity.cwd,
    options: runtimeOptions,
  });
  const replayEvents = replayEventsForRuntimePhysics(physics);
  const runtimeTape = createRuntimeTape({
    cwd: identity.workspaceRoot,
    tapeDir: configState.config.tape.dir,
    enabled: runtimePhysicsUsesDurableTape(physics) ? configState.config.tape.enabled : false,
    initialEvents: replayEvents,
  });
  const commit = createRuntimePhysicsCommitPort({ physics, commit: runtimeTape.commit });
  return createFourPortRuntimeAssembly({
    identity,
    config: configState.readonlyConfig,
    runtimeTape,
    commit,
    resolveToolAuthority:
      physics.mode === "real" || physics.mode === "replay-then-real"
        ? physics.resolveToolAuthority
        : undefined,
    recoveredSessions: recoveredSessionsForRuntimePhysics({ physics, replayEvents }),
    createTurn({ kernel, model }) {
      return createRuntimePhysicsTurnRunner({
        physics,
        replayEvents,
        tape: runtimeTape.tape,
        commit,
        kernel,
        model,
        maxProviderToolContinuationsPerTurn: options.maxProviderToolContinuationsPerTurn,
      });
    },
  });
}
