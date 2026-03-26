import type { ContextBudgetManager } from "./context/budget.js";
import type { ContextInjectionCollector } from "./context/injection.js";
import type { VerificationOutcomeSnapshot } from "./context/runtime-status.js";
import type { ToolOutputDistillationEntry } from "./context/tool-output-distilled.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
  ContextBudgetUsage,
  TaskState,
  TruthState,
} from "./contracts/index.js";
import type { SessionCostTracker } from "./cost/tracker.js";
import type { BrewvaEventStore } from "./events/store.js";
import type { GovernancePort } from "./governance/port.js";
import type { EvidenceLedger } from "./ledger/evidence-ledger.js";
import type { ParallelBudgetManager } from "./parallel/budget.js";
import type { ParallelResultStore } from "./parallel/results.js";
import type { ProjectionEngine } from "./projection/engine.js";
import type { RuntimeRecordEventInput } from "./services/event-pipeline.js";
import type { RuntimeSessionStateStore } from "./services/session-state.js";
import type { FileChangeTracker } from "./state/file-change-tracker.js";
import type { TurnReplayEngine } from "./tape/replay-engine.js";
import type { VerificationGate } from "./verification/gate.js";

export interface RuntimeKernelContext {
  cwd: string;
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  governancePort?: GovernancePort;
  sessionState: RuntimeSessionStateStore;
  contextBudget: ContextBudgetManager;
  contextInjection: ContextInjectionCollector;
  projectionEngine: ProjectionEngine;
  turnReplay: TurnReplayEngine;
  eventStore: BrewvaEventStore;
  evidenceLedger: EvidenceLedger;
  verificationGate: VerificationGate;
  parallel: ParallelBudgetManager;
  parallelResults: ParallelResultStore;
  fileChanges: FileChangeTracker;
  costTracker: SessionCostTracker;
  getCurrentTurn(sessionId: string): number;
  getTaskState(sessionId: string): TaskState;
  getTruthState(sessionId: string): TruthState;
  recordEvent(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined;
  sanitizeInput(text: string): string;
  getRecentToolOutputDistillations(
    sessionId: string,
    maxEntries?: number,
  ): ToolOutputDistillationEntry[];
  getLatestVerificationOutcome(sessionId: string): VerificationOutcomeSnapshot | undefined;
  isContextBudgetEnabled(): boolean;
  observeContextUsage?(sessionId: string, usage: ContextBudgetUsage | undefined): void;
}
