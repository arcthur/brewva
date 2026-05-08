import { resolve } from "node:path";
import type { BrewvaConfig } from "../config/types.js";
import { ContextBudgetManager } from "../domain/context/api.js";
import { SessionCostTracker } from "../domain/cost/api.js";
import { EvidenceLedger } from "../domain/ledger/api.js";
import { ParallelBudgetManager } from "../domain/parallel/api.js";
import { ParallelResultStore } from "../domain/parallel/api.js";
import { FileChangeTracker } from "../domain/patching/api.js";
import { ProjectionEngine } from "../domain/projection/api.js";
import { RecoveryWalStore } from "../domain/recovery/api.js";
import type { RuntimeRecordEvent } from "../domain/sessions/api.js";
import { SkillRegistry } from "../domain/skills/api.js";
import { ReasoningReplayEngine } from "../domain/tape/api.js";
import { TurnReplayEngine } from "../domain/tape/api.js";
import { VerificationGate } from "../domain/verification/api.js";
import { BrewvaEventStore } from "../events/store.js";

export interface RuntimeCoreDependencies {
  skillRegistry: SkillRegistry;
  evidenceLedger: EvidenceLedger;
  verificationGate: VerificationGate;
  parallel: ParallelBudgetManager;
  parallelResults: ParallelResultStore;
  eventStore: BrewvaEventStore;
  recoveryWalStore: RecoveryWalStore;
  contextBudget: ContextBudgetManager;
  turnReplay: TurnReplayEngine;
  reasoningReplay: ReasoningReplayEngine;
  fileChanges: FileChangeTracker;
  costTracker: SessionCostTracker;
  projectionEngine: ProjectionEngine;
}

export interface RuntimeCoreRegistrarOptions {
  cwd: string;
  workspaceRoot: string;
  config: BrewvaConfig;
  recordEvent: RuntimeRecordEvent;
  getCurrentTurn(sessionId: string): number;
}

export function registerRuntimeCoreDependencies(
  options: RuntimeCoreRegistrarOptions,
): RuntimeCoreDependencies {
  const skillRegistry = new SkillRegistry({
    workspaceRoot: options.workspaceRoot,
    config: options.config,
  });

  const evidenceLedger = new EvidenceLedger(
    resolve(options.workspaceRoot, options.config.ledger.path),
  );
  const verificationGate = new VerificationGate(options.config);
  const parallel = new ParallelBudgetManager(options.config.parallel);
  const parallelResults = new ParallelResultStore();
  const eventStore = new BrewvaEventStore(
    options.config.infrastructure.events,
    options.workspaceRoot,
  );
  const recoveryWalStore = new RecoveryWalStore({
    workspaceRoot: options.workspaceRoot,
    config: options.config.infrastructure.recoveryWal,
    scope: "runtime",
    recordEvent: (input) => {
      options.recordEvent({
        sessionId: input.sessionId,
        type: input.type,
        payload: input.payload,
        skipTapeCheckpoint: true,
      });
    },
  });
  const contextBudget = new ContextBudgetManager(options.config.infrastructure.contextBudget);
  const turnReplay = new TurnReplayEngine({
    listEvents: (sessionId) => eventStore.list(sessionId),
    getTurn: (sessionId) => options.getCurrentTurn(sessionId),
  });
  const reasoningReplay = new ReasoningReplayEngine({
    listEvents: (sessionId) => eventStore.list(sessionId),
  });
  const fileChanges = new FileChangeTracker(options.cwd, {
    artifactsBaseDir: options.workspaceRoot,
  });
  const costTracker = new SessionCostTracker(options.config.infrastructure.costTracking);
  const projectionEngine = new ProjectionEngine({
    enabled: options.config.projection.enabled,
    rootDir: resolve(options.workspaceRoot, options.config.projection.dir),
    workingFile: options.config.projection.workingFile,
    maxWorkingChars: options.config.projection.maxWorkingChars,
    listEvents: (sessionId) => eventStore.list(sessionId),
    recordEvent: (eventInput) => options.recordEvent(eventInput),
  });

  return {
    skillRegistry,
    evidenceLedger,
    verificationGate,
    parallel,
    parallelResults,
    eventStore,
    recoveryWalStore,
    contextBudget,
    turnReplay,
    reasoningReplay,
    fileChanges,
    costTracker,
    projectionEngine,
  };
}
