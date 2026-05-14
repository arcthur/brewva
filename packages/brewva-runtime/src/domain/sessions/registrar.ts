import { inferEventCategory } from "../../runtime/runtime-helpers.js";
import type {
  RuntimeLazyServiceFactories,
  RuntimeServiceRegistrarOptions,
  RuntimeSessionServices,
} from "../../runtime/wiring.js";
import type { RuntimeLazyServiceRegistrarOptions } from "../../runtime/wiring.js";
import { ClaimProjectorService, type ClaimService } from "../claim/api.js";
import type { ReversibleMutationService } from "../governance/api.js";
import type { FileChangeService } from "../patching/api.js";
import type { ReasoningService } from "../reasoning/api.js";
import { registerRecoveryDomain } from "../recovery/api.js";
import { registerTapeDomain } from "../tape/api.js";
import type { TaskService } from "../task/api.js";
import { VerificationGate } from "../verification/api.js";
import { VerificationProjectorService } from "../verification/api.js";
import type { WorkbenchService } from "../workbench/api.js";
import { SESSIONS_EVENT_DESCRIPTORS } from "./event-descriptors.js";
import { EventPipelineService } from "./event-pipeline.js";
import { SessionLineageService } from "./lineage.js";
import { SessionLifecycleService } from "./session-lifecycle.js";
import { SessionRewindService } from "./session-rewind.js";
import { SessionWireService } from "./session-wire.js";
import { SessionTitleService } from "./title.js";

function isDeclaredCapabilityStateOwner(
  ownerCapability: string,
  options: RuntimeServiceRegistrarOptions,
): boolean {
  const skillOwnerPrefix = "brewva.skill.";
  if (!ownerCapability.startsWith(skillOwnerPrefix)) {
    return false;
  }
  return (
    options.coreDependencies.skillRegistry.get(ownerCapability.slice(skillOwnerPrefix.length)) !==
    undefined
  );
}

interface RuntimeProjectionSubscriberRegistrarOptions {
  cwd: string;
  kernel: RuntimeServiceRegistrarOptions["kernel"];
  verificationGate: VerificationGate;
  eventPipeline: EventPipelineService;
  taskService: TaskService;
  claimService: ClaimService;
}

function registerProjectionSubscribers(options: RuntimeProjectionSubscriberRegistrarOptions): void {
  const claimProjector = new ClaimProjectorService({
    cwd: options.cwd,
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getClaimState: (sessionId) => options.kernel.getClaimState(sessionId),
    eventPipeline: options.eventPipeline,
    taskService: options.taskService,
    claimService: options.claimService,
  });
  const verificationProjector = new VerificationProjectorService({
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getClaimState: (sessionId) => options.kernel.getClaimState(sessionId),
    verificationStateStore: options.verificationGate.stateStore,
    eventPipeline: options.eventPipeline,
    taskService: options.taskService,
    claimService: options.claimService,
  });

  void claimProjector;
  void verificationProjector;
}

export interface RuntimeSessionsDomainRegistration {
  services: RuntimeSessionServices;
  eventDescriptors: typeof SESSIONS_EVENT_DESCRIPTORS;
}

export interface RuntimeSessionsLazyDomainRegistration {
  lazyFactories: Pick<
    RuntimeLazyServiceFactories,
    "createSessionRewindService" | "createSessionWireService"
  >;
}

export interface RuntimeSessionsDomainDependencies {
  taskService: TaskService;
  claimService: ClaimService;
  reversibleMutationService: ReversibleMutationService;
  workbenchService: WorkbenchService;
  clearEffectCommitmentDeskState(sessionId: string): void;
}

export function registerSessionsDomain(
  options: RuntimeServiceRegistrarOptions,
  support: RuntimeSessionsDomainDependencies,
): RuntimeSessionsDomainRegistration {
  const tapeDomain = registerTapeDomain(options);

  const eventPipeline = new EventPipelineService({
    events: options.coreDependencies.eventStore,
    level: options.config.infrastructure.events.level,
    inferEventCategory,
    observeReplayEvent: (event) => {
      options.coreDependencies.turnReplay.observeEvent(event);
      options.coreDependencies.reasoningReplay.observeEvent(event);
    },
    ingestProjectionEvent: (event) => options.coreDependencies.projectionEngine.ingestEvent(event),
    maybeRecordTapeCheckpoint: (event) =>
      tapeDomain.services.getTapeService().maybeRecordTapeCheckpoint(event),
  });

  registerProjectionSubscribers({
    cwd: options.cwd,
    kernel: options.kernel,
    verificationGate: options.coreDependencies.verificationGate,
    eventPipeline,
    taskService: support.taskService,
    claimService: support.claimService,
  });

  const recoveryDomain = registerRecoveryDomain(
    {
      recoveryWalStore: options.coreDependencies.recoveryWalStore,
    },
    {
      eventPipeline,
    },
  );

  const sessionLineageService = new SessionLineageService({
    eventStore: options.coreDependencies.eventStore,
    recordEvent: (input) => options.kernel.recordEvent(input),
    isCapabilityStateOwnerDeclared: (ownerCapability) =>
      isDeclaredCapabilityStateOwner(ownerCapability, options),
  });

  const sessionTitleService = new SessionTitleService({
    eventStore: options.coreDependencies.eventStore,
    recordEvent: (input) => options.kernel.recordEvent(input),
  });

  const sessionLifecycleService = new SessionLifecycleService({
    sessionState: options.sessionState,
    contextBudget: options.coreDependencies.contextBudget,
    fileChanges: options.coreDependencies.fileChanges,
    verificationGate: options.coreDependencies.verificationGate,
    parallel: options.coreDependencies.parallel,
    parallelResults: options.coreDependencies.parallelResults,
    costTracker: options.coreDependencies.costTracker,
    projectionEngine: options.coreDependencies.projectionEngine,
    turnReplay: options.coreDependencies.turnReplay,
    eventStore: options.coreDependencies.eventStore,
    recoveryWalStore: options.coreDependencies.recoveryWalStore,
    reversibleMutationService: support.reversibleMutationService,
    workbenchService: support.workbenchService,
    recordEvent: (input) => options.kernel.recordEvent(input),
  });

  sessionLifecycleService.onClearState((sessionId) => {
    recoveryDomain.services.toolLifecycleRecoveryWalService.clearSession(sessionId);
    support.reversibleMutationService.clear(sessionId);
    support.workbenchService.clear(sessionId);
    support.clearEffectCommitmentDeskState(sessionId);
    options.coreDependencies.reasoningReplay.clear(sessionId);
  });

  return {
    services: {
      eventPipeline,
      toolLifecycleRecoveryWalService: recoveryDomain.services.toolLifecycleRecoveryWalService,
      sessionLifecycleService,
      sessionTitleService,
      sessionLineageService,
      getTapeService: () => tapeDomain.services.getTapeService(),
    },
    eventDescriptors: SESSIONS_EVENT_DESCRIPTORS,
  };
}

export function registerSessionsLazyDomain(
  options: RuntimeLazyServiceRegistrarOptions,
  support: {
    getReasoningService(): ReasoningService;
    getFileChangeService(): FileChangeService;
  },
): RuntimeSessionsLazyDomainRegistration {
  let sessionRewindService: SessionRewindService | undefined;
  let sessionWireService: SessionWireService | undefined;
  return {
    lazyFactories: {
      createSessionRewindService: () => {
        sessionRewindService ??= new SessionRewindService({
          eventStore: options.coreDependencies.eventStore,
          reasoningService: support.getReasoningService(),
          fileChangeService: support.getFileChangeService(),
          getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
          recordEvent: (input) => options.kernel.recordEvent(input),
          getSessionLifecycleSnapshot: (sessionId) =>
            options.getSessionLifecycleSnapshot(sessionId),
          resolveToolAuthority: (toolName, args) => options.resolveToolAuthority(toolName, args),
        });
        return sessionRewindService;
      },
      createSessionWireService: () => {
        sessionWireService ??= new SessionWireService({
          queryStructuredEvents: (sessionId) =>
            options.eventPipeline.queryStructuredEvents(sessionId),
          subscribeEvents: (listener) => options.eventPipeline.subscribeEvents(listener),
        });
        return sessionWireService;
      },
    },
  };
}
