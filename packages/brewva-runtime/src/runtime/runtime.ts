import { resolve } from "node:path";
import { resolveWorkspaceRootDir } from "../config/paths.js";
import { createTurnRunner } from "./engine/turn.js";
import { createKernelPort } from "./kernel/kernel.js";
import { createModelPort } from "./model/model.js";
import type {
  BrewvaRuntime,
  BrewvaRuntimeOptions,
  RuntimeProviderPort,
  RuntimeStartReceipt,
  RuntimeToolExecutorPort,
  RuntimeToolAuthorityResolver,
} from "./runtime-api.js";
import { CANONICAL_EVENT_TYPES, RUNTIME_RECOVERY_CAUSES } from "./runtime-api.js";
import { resolveRuntimeConfigState } from "./runtime-config-state.js";
import { createRuntimeTape } from "./tape/memory-tape.js";

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
  MaterializationInput,
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
  RuntimeStartReceipt,
  RuntimeSuspendedPayload,
  RuntimeToolAuthorityResolver,
  RuntimeToolExecutorInput,
  RuntimeToolExecutorPort,
  SessionId,
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
  readonly provider?: RuntimeProviderPort;
  readonly toolExecutor?: RuntimeToolExecutorPort;
  readonly resolveToolAuthority?: RuntimeToolAuthorityResolver;
}): BrewvaRuntime {
  const kernel = createKernelPort(input.runtimeTape.commit, input.runtimeTape.tape, {
    actionAdmissionOverrides: input.config.security.actionAdmissionOverrides,
    resolveToolAuthority: input.resolveToolAuthority,
  });
  const model = createModelPort(input.runtimeTape.tape);
  const turn = createTurnRunner({
    tape: input.runtimeTape.commit,
    kernel,
    model,
    provider: input.provider,
    toolExecutor: input.toolExecutor,
  });
  const runtime: BrewvaRuntime = {
    identity: input.identity,
    config: input.config,
    tape: input.runtimeTape.tape,
    kernel,
    model,
    async start(): Promise<RuntimeStartReceipt> {
      return { recoveredSessions: input.runtimeTape.loadFromDisk() };
    },
    turn,
    async close(): Promise<void> {
      await input.runtimeTape.close();
    },
  };
  return freezePort(runtime);
}

export function createBrewvaRuntime(options: BrewvaRuntimeOptions = {}): BrewvaRuntime {
  const identity = resolveRuntimeIdentity(options);
  const configState = resolveRuntimeConfigState({
    cwd: identity.cwd,
    options,
  });
  const runtimeTape = createRuntimeTape({
    cwd: identity.workspaceRoot,
    tapeDir: configState.config.tape.dir,
    enabled: configState.config.tape.enabled,
  });
  return createFourPortRuntimeAssembly({
    identity,
    config: configState.readonlyConfig,
    runtimeTape,
    provider: options.provider,
    toolExecutor: options.toolExecutor,
    resolveToolAuthority: options.resolveToolAuthority,
  });
}
