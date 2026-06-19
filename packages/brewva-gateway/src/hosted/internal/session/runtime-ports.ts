import type {
  BrewvaConfig,
  BrewvaRuntime,
  BrewvaRuntimeIdentity,
  BrewvaRuntimeOptions,
  DeepReadonly,
  RuntimeProviderPort,
  RuntimePhysicsDeclaration,
  RuntimeToolAuthorityResolver,
  RuntimeToolExecutorPort,
  TurnInput,
} from "@brewva/brewva-runtime";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import {
  createActionPolicyRegistry,
  resolveToolAuthority as resolveActionPolicyAuthority,
} from "@brewva/brewva-runtime/security";
import type { BrewvaToolRuntimeCapabilitiesPort } from "@brewva/brewva-tools/contracts";
import type { ContextEvidenceKind } from "@brewva/brewva-vocabulary/context";
import { createRecoveryWalStore } from "../../../daemon/api.js";
import type { CollectSessionPromptOutputSession } from "../turn-adapter/collect-output.js";
import {
  createHostedRuntimeProviderPort,
  createHostedRuntimeToolAuthorityResolver,
  createHostedRuntimeToolExecutorPort,
  isRuntimeAdapterSession,
} from "../turn-adapter/runtime-turn-execution-ports.js";
import { createVerificationGateRuntimeProviderPort } from "../turn-adapter/runtime-turn-verification-gates.js";
import type { HostedRuntimeOpsPort } from "./runtime-ops-port.js";
import { createHostedRuntimeOps } from "./runtime-ops.js";

type HostedTurnSessionPorts = {
  readonly provider: RuntimeProviderPort;
  readonly toolExecutor: RuntimeToolExecutorPort;
  readonly authority: RuntimeToolAuthorityResolver;
};

export type { BrewvaRuntimeOptions };
export type HostedRuntimeAdapterOptions = Omit<BrewvaRuntimeOptions, "physics"> & {
  readonly physics?: RuntimePhysicsDeclaration;
  /** Evaluation clock for display-time projections; defaults to Date.now. */
  readonly clock?: () => number;
};

export type RuntimeAdapterOpsPort = HostedRuntimeOpsPort;
export type RuntimeAdapterCapabilitiesPort = BrewvaToolRuntimeCapabilitiesPort;

export interface HostedRuntimeExtensionsPort {
  readonly recovery: {
    readonly scheduler: ReturnType<typeof createRecoveryWalStore>;
  };
  readonly tools: {
    readonly name: "tools";
    onClearState(listener: (sessionId: string) => void): void;
    resolveCredentialBindings(sessionId: string, toolName: string): Record<string, string>;
  };
}

export interface RuntimeSkillSelectionWriter {
  readonly ops: {
    readonly skills: {
      readonly selection: {
        record(sessionId: string, receipt: object): unknown;
      };
    };
  };
}

export interface RuntimeToolSurfaceWriter {
  readonly ops: {
    readonly tools: {
      readonly surface: {
        recordResolved(sessionId: string, input: object): unknown;
      };
    };
  };
}

export interface RuntimeToolCapabilitySelectionWriter {
  readonly ops: {
    readonly tools: {
      readonly capabilitySelection: {
        record(sessionId: string, receipt: object): unknown;
      };
    };
  };
}

export interface RuntimeScheduleEventWriter {
  readonly ops: {
    readonly schedule: {
      readonly events: {
        recordWakeup(sessionId: string, input: object): unknown;
        recordChildStarted(sessionId: string, input: object): unknown;
        recordChildFinished(sessionId: string, input: object): unknown;
        recordChildFailed(sessionId: string, input: object): unknown;
      };
    };
  };
}

export interface HostedRuntimeAdapterPort {
  readonly identity: BrewvaRuntimeIdentity;
  readonly config: DeepReadonly<BrewvaConfig>;
  readonly runtime: BrewvaRuntime;
  readonly ops: RuntimeAdapterOpsPort;
  readonly extensions: HostedRuntimeExtensionsPort;
  /**
   * Register a hosted session under its sessionId so the adapter's single
   * router runtime resolves provider/tool/authority physics for that session's
   * turns. Replaces the old per-session runtime instance + createRuntime swap.
   */
  registerTurnSession(sessionId: string, session: CollectSessionPromptOutputSession): void;
}

// The tools-facing port. `capabilities` is the capability-scoped projection of
// the gateway `ops` facade (see `toToolRuntimeAdapterPort`). It is defined
// independently of `HostedRuntimeAdapterPort` so the wide adapter does not have
// to carry a redundant `capabilities` alias of `ops`.
export interface ToolRuntimeAdapterPort {
  readonly identity: BrewvaRuntimeIdentity;
  readonly config: DeepReadonly<BrewvaConfig>;
  readonly capabilities: RuntimeAdapterCapabilitiesPort;
  readonly extensions: {
    readonly tools: HostedRuntimeExtensionsPort["tools"];
  };
}

function freezePort<TPort extends object>(port: TPort): Readonly<TPort> {
  return Object.freeze(port);
}

export function hasRuntimeOpsAdapter(
  input: unknown,
): input is Pick<HostedRuntimeAdapterPort, "ops"> {
  if (typeof input !== "object" || input === null || !("ops" in input)) {
    return false;
  }
  const ops = input.ops;
  return typeof ops === "object" && ops !== null;
}

export function getRuntimeOpsPort(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
): HostedRuntimeAdapterPort["ops"] {
  return runtime.ops;
}

export function getRuntimeEventsOpsPort(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
): HostedRuntimeAdapterPort["ops"]["events"] {
  return runtime.ops.events;
}

export function getRuntimeTaskOpsPort(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
): HostedRuntimeAdapterPort["ops"]["task"] {
  return runtime.ops.task;
}

export function createHostedRuntimeAdapter(
  options: HostedRuntimeAdapterOptions = {},
): HostedRuntimeAdapterPort {
  const observedSessionIds = new Set<string>();

  function rememberSessions(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      observedSessionIds.add(sessionId);
    }
  }

  function wrapRuntime(runtime: BrewvaRuntime): BrewvaRuntime {
    // Start once per adapter instance. The hosted adapter owns a single runtime
    // and the per-turn registerTurnSessionRuntime path calls start() on every
    // turn; without memoization that re-runs loadFromDisk() (a full tape reread)
    // each turn. Memoize the first start so it is paid once.
    let startReceipt: ReturnType<BrewvaRuntime["start"]> | undefined;
    return Object.freeze({
      identity: runtime.identity,
      config: runtime.config,
      tape: runtime.tape,
      kernel: runtime.kernel,
      model: runtime.model,
      start() {
        startReceipt ??= (async () => {
          const receipt = await runtime.start();
          rememberSessions(receipt.recoveredSessions);
          return receipt;
        })();
        return startReceipt;
      },
      turn(input: TurnInput) {
        observedSessionIds.add(input.sessionId);
        return runtime.turn(input);
      },
      close: () => runtime.close(),
    });
  }

  const sessionRegistry = new Map<string, HostedTurnSessionPorts>();
  const fallbackAuthorityRegistry = createActionPolicyRegistry();

  function portsFor(sessionId: string): HostedTurnSessionPorts {
    const ports = sessionRegistry.get(sessionId);
    if (!ports) {
      throw new Error(`hosted_runtime_session_not_registered:${sessionId}`);
    }
    return ports;
  }

  // One stable runtime per adapter. Its physics routes each turn to the
  // registered session's ports by sessionId — no noop shell, no per-turn swap.
  // Omitting `options.physics` defaults to real routing; callers that want a noop
  // runtime (e.g. inspect-only paths) must pass `physics: { mode: "noop" }`.
  const routerPhysics: RuntimePhysicsDeclaration = options.physics ?? {
    mode: "real",
    provider: {
      stream(input) {
        return portsFor(input.turn.sessionId).provider.stream(input);
      },
    },
    toolExecutor: {
      execute(commitment, executorInput) {
        return portsFor(commitment.call.sessionId).toolExecutor.execute(commitment, executorInput);
      },
    },
    resolveToolAuthority: (toolName, args, sessionId) => {
      const ports = sessionId ? sessionRegistry.get(sessionId) : undefined;
      if (ports) {
        return ports.authority(toolName, args, sessionId);
      }
      // Direct kernel use outside a hosted turn (e.g. tape-replay queries) has no
      // registered session; fall back to the default action policy, matching the
      // prior noop-adapter behavior.
      return resolveActionPolicyAuthority(
        toolName,
        fallbackAuthorityRegistry,
        args,
        runtime.config.security.actionAdmissionOverrides,
      );
    },
  };

  const runtime = wrapRuntime(createBrewvaRuntime({ ...options, physics: routerPhysics }));

  function registerTurnSession(
    sessionId: string,
    session: CollectSessionPromptOutputSession,
  ): void {
    observedSessionIds.add(sessionId);
    if (sessionRegistry.has(sessionId) || !isRuntimeAdapterSession(session)) {
      return;
    }
    sessionRegistry.set(sessionId, {
      provider: createVerificationGateRuntimeProviderPort(
        createHostedRuntimeProviderPort(session),
        session,
      ),
      toolExecutor: createHostedRuntimeToolExecutorPort(session),
      authority: createHostedRuntimeToolAuthorityResolver(session, {
        actionAdmissionOverrides: runtime.config.security.actionAdmissionOverrides,
      }),
    });
  }

  const ops = createHostedRuntimeOps({
    runtime,
    listSessionIds: () => [...observedSessionIds].toSorted(),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  // Release a session's router ports when its state is cleared, so the registry
  // does not grow unbounded across the adapter's lifetime.
  ops.session.state.onClear((clearedSessionId) => {
    sessionRegistry.delete(clearedSessionId);
  });
  const recoveryWal = createRecoveryWalStore({
    workspaceRoot: runtime.identity.workspaceRoot,
    config: runtime.config.infrastructure.recoveryWal,
    scope: "runtime",
  });
  const extensions: HostedRuntimeExtensionsPort = Object.freeze({
    recovery: Object.freeze({
      scheduler: recoveryWal,
    }),
    tools: {
      name: "tools" as const,
      onClearState(listener: (sessionId: string) => void): void {
        ops.session.state.onClear(listener);
      },
      resolveCredentialBindings: () => ({}),
    },
  });
  const adapter: HostedRuntimeAdapterPort = {
    identity: runtime.identity,
    config: runtime.config,
    runtime,
    ops,
    extensions,
    registerTurnSession,
  };
  return freezePort(adapter);
}

export function toToolRuntimeAdapterPort(
  runtime: HostedRuntimeAdapterPort,
): ToolRuntimeAdapterPort {
  return Object.freeze({
    identity: runtime.identity,
    config: runtime.config,
    capabilities: runtime.ops,
    extensions: Object.freeze({
      tools: runtime.extensions.tools,
    }),
  });
}

export function setRuntimeTaskSpec(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  taskSpec: Parameters<HostedRuntimeAdapterPort["ops"]["task"]["spec"]["set"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["task"]["spec"]["set"]> {
  return runtime.ops.task.spec.set(sessionId, taskSpec);
}

export function upsertRuntimeClaimFact(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["claim"]["facts"]["upsert"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["claim"]["facts"]["upsert"]> {
  return runtime.ops.claim.facts.upsert(sessionId, input);
}

export function getRuntimeCostSummary(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["cost"]["summary"]["get"]> {
  return runtime.ops.cost.summary.get(sessionId);
}

export function getRuntimeCostPosture(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["cost"]["posture"]["get"]> {
  return runtime.ops.cost.posture.get(sessionId);
}

export function getRuntimeTaskState(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["task"]["state"]["get"]> {
  return runtime.ops.task.state.get(sessionId);
}

export function getRuntimeClaimState(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["claim"]["state"]["get"]> {
  return runtime.ops.claim.state.get(sessionId);
}

export function getRuntimeTapeStatus(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["tape"]["status"]["get"]> {
  return runtime.ops.tape.status.get(sessionId);
}

export function getRuntimeContextUsage(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["usage"]["get"]> {
  return runtime.ops.context.usage.get(sessionId);
}

export function getRuntimeContextStatus(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  usage: Parameters<HostedRuntimeAdapterPort["ops"]["context"]["usage"]["getStatus"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["usage"]["getStatus"]> {
  return runtime.ops.context.usage.getStatus(sessionId, usage);
}

export function getRuntimeCompactionGateStatus(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  usage?: Parameters<HostedRuntimeAdapterPort["ops"]["context"]["compaction"]["getGateStatus"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["compaction"]["getGateStatus"]> {
  return runtime.ops.context.compaction.getGateStatus(sessionId, usage);
}

export function getRuntimePendingCompactionReason(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["compaction"]["getPendingReason"]> {
  return runtime.ops.context.compaction.getPendingReason(sessionId);
}

export function getRuntimeContextEvidenceLatest(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  key: ContextEvidenceKind,
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["evidence"]["latest"]> {
  return runtime.ops.context.evidence.latest(sessionId, key);
}

export function explainRuntimeToolAccess(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["tools"]["access"]["explain"]>[0],
): ReturnType<HostedRuntimeAdapterPort["ops"]["tools"]["access"]["explain"]> {
  return runtime.ops.tools.access.explain(input);
}

export function getRuntimeToolActionPolicy(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  toolName: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["tools"]["access"]["getActionPolicy"]> {
  return runtime.ops.tools.access.getActionPolicy(toolName);
}

export function listRuntimeWorkerResults(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["workerResults"]["list"]> {
  return runtime.ops.session.workerResults.list(sessionId);
}

export function recordRuntimeWorkerResult(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["workerResults"]["record"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["workerResults"]["record"]> {
  return runtime.ops.session.workerResults.record(sessionId, input);
}

export function listRuntimePendingProposalRequests(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["proposals"]["requests"]["listPending"]> {
  return runtime.ops.proposals.requests.listPending(sessionId);
}

export function listRuntimeProposalRequests(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  query?: Parameters<HostedRuntimeAdapterPort["ops"]["proposals"]["requests"]["list"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["proposals"]["requests"]["list"]> {
  return runtime.ops.proposals.requests.list(sessionId, query);
}

export function listRuntimeEventSessionIds(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
): ReturnType<HostedRuntimeAdapterPort["ops"]["events"]["records"]["listSessionIds"]> {
  return runtime.ops.events.records.listSessionIds();
}

export function listRuntimeEvents(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["events"]["records"]["list"]> {
  return runtime.ops.events.records.list(sessionId);
}

export function queryRuntimeEvents(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  query?: Parameters<HostedRuntimeAdapterPort["ops"]["events"]["records"]["query"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["events"]["records"]["query"]> {
  return runtime.ops.events.records.query(sessionId, query);
}

export function subscribeRuntimeEvents(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  listener: Parameters<HostedRuntimeAdapterPort["ops"]["events"]["records"]["subscribe"]>[0],
): ReturnType<HostedRuntimeAdapterPort["ops"]["events"]["records"]["subscribe"]> {
  return runtime.ops.events.records.subscribe(listener);
}

export function queryStructuredRuntimeEvents(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  query?: Parameters<HostedRuntimeAdapterPort["ops"]["events"]["records"]["queryStructured"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["events"]["records"]["queryStructured"]> {
  return runtime.ops.events.records.queryStructured(sessionId, query);
}

export function toStructuredRuntimeEvent(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  event: Parameters<HostedRuntimeAdapterPort["ops"]["events"]["records"]["toStructured"]>[0],
): ReturnType<HostedRuntimeAdapterPort["ops"]["events"]["records"]["toStructured"]> {
  return runtime.ops.events.records.toStructured(event);
}

export function subscribeRuntimeSessionWire(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  listener: Parameters<HostedRuntimeAdapterPort["ops"]["sessionWire"]["subscribe"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["sessionWire"]["subscribe"]> {
  return runtime.ops.sessionWire.subscribe(sessionId, listener);
}

export function getRuntimeLifecycleSnapshot(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["lifecycle"]["getSnapshot"]> {
  return runtime.ops.lifecycle.getSnapshot(sessionId);
}

export function getRuntimeContextUsageRatio(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  usage: Parameters<HostedRuntimeAdapterPort["ops"]["context"]["usage"]["getRatio"]>[0],
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["usage"]["getRatio"]> {
  return runtime.ops.context.usage.getRatio(usage);
}

export function getRuntimeContextCompactionInstructions(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["compaction"]["getInstructions"]> {
  return runtime.ops.context.compaction.getInstructions();
}

export function resolveRuntimeContextCompactionEligibility(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  input: Parameters<
    HostedRuntimeAdapterPort["ops"]["context"]["compaction"]["resolveEligibility"]
  >[0],
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["compaction"]["resolveEligibility"]> {
  return runtime.ops.context.compaction.resolveEligibility(input);
}

export function getRuntimeContextPromptHistoryViewBaseline(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["prompt"]["getHistoryViewBaseline"]> {
  return runtime.ops.context.prompt.getHistoryViewBaseline(sessionId);
}

export function listRuntimeWorkbenchEntries(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["workbench"]["list"]> {
  return runtime.ops.workbench.list(sessionId);
}

export function renderRuntimeTurnDigest(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["events"]["effects"]["renderTurnDigest"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["events"]["effects"]["renderTurnDigest"]> {
  return runtime.ops.events.effects.renderTurnDigest(sessionId, input);
}

export function sanitizeRuntimeContextInput(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  input: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["sanitizeInput"]> {
  return runtime.ops.context.sanitizeInput(input);
}

export function getRuntimeVisibleReadEpoch(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["visibleRead"]["getEpoch"]> {
  return runtime.ops.context.visibleRead.getEpoch(sessionId);
}

export function isRuntimeVisibleReadCurrent(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["context"]["visibleRead"]["isCurrent"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["context"]["visibleRead"]["isCurrent"]> {
  return runtime.ops.context.visibleRead.isCurrent(sessionId, input);
}

export function getRuntimeSessionTitle(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["title"]["get"]> {
  return runtime.ops.session.title.get(sessionId);
}

export function getRuntimeSessionLineageNode(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  lineageNodeId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["getNode"]> {
  return runtime.ops.session.lineage.getNode(sessionId, lineageNodeId);
}

export function getRuntimeSessionLineageTree(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["getTree"]> {
  return runtime.ops.session.lineage.getTree(sessionId);
}

export function listRuntimeSessionLineageChildren(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  lineageNodeId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["listChildren"]> {
  return runtime.ops.session.lineage.listChildren(sessionId, lineageNodeId);
}

export function getRuntimeSessionLineageContextEntryPath(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<
    HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["getContextEntryPath"]
  >[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["getContextEntryPath"]> {
  return runtime.ops.session.lineage.getContextEntryPath(sessionId, input);
}

export function queryRuntimeSessionWire(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["sessionWire"]["query"]> {
  return runtime.ops.sessionWire.query(sessionId);
}

export function recordRuntimeSkillSelection(
  runtime: RuntimeSkillSelectionWriter,
  sessionId: string,
  receipt: object,
): unknown {
  return runtime.ops.skills.selection.record(sessionId, receipt);
}

export function getRuntimeSkillCatalogEntry(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  skillName: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["skills"]["catalog"]["get"]> {
  return runtime.ops.skills.catalog.get(skillName);
}

export function recordRuntimeWorkbenchNote(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["workbench"]["note"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["workbench"]["note"]> {
  return runtime.ops.workbench.note(sessionId, input);
}

export function recordRuntimeLineageOutcome(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["recordOutcome"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["recordOutcome"]> {
  return runtime.ops.session.lineage.recordOutcome(sessionId, input);
}

export function adoptRuntimeLineageOutcome(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["adoptOutcome"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["adoptOutcome"]> {
  return runtime.ops.session.lineage.adoptOutcome(sessionId, input);
}

export function recordRuntimeToolSurfaceResolved(
  runtime: RuntimeToolSurfaceWriter,
  sessionId: string,
  input: object,
): unknown {
  return runtime.ops.tools.surface.recordResolved(sessionId, input);
}

export function recordRuntimeToolCapabilitySelection(
  runtime: RuntimeToolCapabilitySelectionWriter,
  sessionId: string,
  receipt: object,
): unknown {
  return runtime.ops.tools.capabilitySelection.record(sessionId, receipt);
}

export function recordRuntimeScheduleWakeup(
  runtime: RuntimeScheduleEventWriter,
  sessionId: string,
  input: object,
): unknown {
  return runtime.ops.schedule.events.recordWakeup(sessionId, input);
}

export function recordRuntimeScheduleChildStarted(
  runtime: RuntimeScheduleEventWriter,
  sessionId: string,
  input: object,
): unknown {
  return runtime.ops.schedule.events.recordChildStarted(sessionId, input);
}

export function recordRuntimeScheduleChildFinished(
  runtime: RuntimeScheduleEventWriter,
  sessionId: string,
  input: object,
): unknown {
  return runtime.ops.schedule.events.recordChildFinished(sessionId, input);
}

export function recordRuntimeScheduleChildFailed(
  runtime: RuntimeScheduleEventWriter,
  sessionId: string,
  input: object,
): unknown {
  return runtime.ops.schedule.events.recordChildFailed(sessionId, input);
}

export function acquireRuntimeParallelSlot(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  runId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["tools"]["parallel"]["acquire"]> {
  return runtime.ops.tools.parallel.acquire(sessionId, runId, { kind: "delegation" });
}

export function releaseRuntimeParallelSlot(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
  runId: string,
): ReturnType<HostedRuntimeAdapterPort["ops"]["tools"]["parallel"]["release"]> {
  return runtime.ops.tools.parallel.release(sessionId, runId);
}

export {
  commitRuntimeSessionCompaction,
  createRuntimeLineageNode,
  finishRuntimeToolInvocation,
  recordHostedRuntimeEvent,
  recordRuntimeAssistantCost,
  recordRuntimeGeneratedTitle,
  recordRuntimeLineageContextEntry,
  recordRuntimeLineageSummary,
  recordRuntimeReasoningCheckpoint,
  recordRuntimeContinuationAnchor,
  recordRuntimeTurnRewindCheckpoint,
  startRuntimeToolInvocation,
} from "./projection/runtime-write-adapters.js";
