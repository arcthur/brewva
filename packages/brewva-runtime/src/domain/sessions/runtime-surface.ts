import type { BrewvaConfig } from "../../config/types.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { ContextService } from "../context/api.js";
import type { CredentialVaultService } from "../credentials/api.js";
import type { ParallelService } from "../parallel/api.js";
import type { TaskWatchdogService } from "../task/api.js";
import type { IntegrityStatus } from "./integrity.js";
import type { SessionLineageService } from "./lineage.js";
import type { SessionLifecycleService } from "./session-lifecycle.js";
import type { SessionRewindService } from "./session-rewind.js";
import type { SessionWireService } from "./session-wire.js";
import type { SessionTitleService } from "./title.js";
import type { SessionHydrationState } from "./types.js";

export interface SessionSurfaceDependencies {
  runtimeConfig: BrewvaConfig;
  getContextService(): ContextService;
  getSessionLifecycleService(): SessionLifecycleService;
  getSessionTitleService(): SessionTitleService;
  getTaskWatchdogService(): TaskWatchdogService;
  getParallelService(): ParallelService;
  getSessionRewindService(): SessionRewindService;
  getSessionLineageService(): SessionLineageService;
  getCredentialVaultService(): CredentialVaultService;
}

export interface SessionWireSurfaceDependencies {
  getSessionWireService(): SessionWireService;
}

export function createSessionSurfaceMethods(deps: SessionSurfaceDependencies) {
  return {
    authority: {
      workerResults: {
        record: (sessionId: string, result: Parameters<ParallelService["recordWorkerResult"]>[1]) =>
          deps.getParallelService().recordWorkerResult(sessionId, result),
        applyMerged: (
          sessionId: string,
          input: Parameters<ParallelService["applyMergedWorkerResults"]>[1],
        ) => deps.getParallelService().applyMergedWorkerResults(sessionId, input),
      },
      rewind: {
        recordCheckpoint: (
          sessionId: string,
          input?: Parameters<SessionRewindService["recordCheckpoint"]>[1],
        ) => deps.getSessionRewindService().recordCheckpoint(sessionId, input),
        rewind: (sessionId: string, input?: Parameters<SessionRewindService["rewind"]>[1]) =>
          deps.getSessionRewindService().rewind(sessionId, input),
        redo: (sessionId: string, input?: Parameters<SessionRewindService["redo"]>[1]) =>
          deps.getSessionRewindService().redo(sessionId, input),
      },
      compaction: {
        commit: (
          sessionId: string,
          input: Parameters<ContextService["markContextCompacted"]>[1],
        ): Promise<BrewvaEventRecord> =>
          deps.getContextService().markContextCompacted(sessionId, input),
      },
      title: {
        recordGenerated: (
          sessionId: string,
          input: Parameters<SessionTitleService["recordGeneratedTitle"]>[1],
        ): BrewvaEventRecord =>
          deps.getSessionTitleService().recordGeneratedTitle(sessionId, input),
      },
      lineage: {
        createNode: (
          sessionId: string,
          input: Parameters<SessionLineageService["createLineageNode"]>[1],
        ) => deps.getSessionLineageService().createLineageNode(sessionId, input),
        recordSummary: (
          sessionId: string,
          input: Parameters<SessionLineageService["recordLineageSummary"]>[1],
        ) => deps.getSessionLineageService().recordLineageSummary(sessionId, input),
        recordOutcome: (
          sessionId: string,
          input: Parameters<SessionLineageService["recordLineageOutcome"]>[1],
        ) => deps.getSessionLineageService().recordLineageOutcome(sessionId, input),
        recordSelection: (
          sessionId: string,
          input: Parameters<SessionLineageService["recordLineageSelection"]>[1],
        ) => deps.getSessionLineageService().recordLineageSelection(sessionId, input),
        adoptOutcome: (
          sessionId: string,
          input: Parameters<SessionLineageService["adoptLineageOutcome"]>[1],
        ) => deps.getSessionLineageService().adoptLineageOutcome(sessionId, input),
        recordContextEntry: (
          sessionId: string,
          input: Parameters<SessionLineageService["recordContextEntry"]>[1],
        ) => deps.getSessionLineageService().recordContextEntry(sessionId, input),
        recordCapabilityState: (
          sessionId: string,
          input: Parameters<SessionLineageService["recordCapabilityState"]>[1],
        ) => deps.getSessionLineageService().recordCapabilityState(sessionId, input),
      },
    },
    inspect: {
      workerResults: {
        list: (sessionId: string) => deps.getParallelService().listWorkerResults(sessionId),
        merge: (sessionId: string) => deps.getParallelService().mergeWorkerResults(sessionId),
      },
      lifecycle: {
        getOpenToolCalls: (sessionId: string) =>
          deps.getSessionLifecycleService().getOpenToolCalls(sessionId),
        getUncleanShutdownDiagnostic: (sessionId: string) =>
          deps.getSessionLifecycleService().getUncleanShutdownDiagnostic(sessionId),
        getHydration: (sessionId: string): SessionHydrationState => {
          deps.getSessionLifecycleService().ensureHydrated(sessionId);
          return deps.getSessionLifecycleService().getHydrationState(sessionId);
        },
        getIntegrity: (sessionId: string): IntegrityStatus => {
          deps.getSessionLifecycleService().ensureHydrated(sessionId);
          return deps.getSessionLifecycleService().getIntegrityStatus(sessionId);
        },
      },
      rewind: {
        getState: (sessionId: string) => deps.getSessionRewindService().getRewindState(sessionId),
        listTargets: (sessionId: string) =>
          deps.getSessionRewindService().listRewindTargets(sessionId),
      },
      title: {
        get: (sessionId: string) => deps.getSessionTitleService().getTitle(sessionId),
      },
      lineage: {
        getTree: (sessionId: string) => deps.getSessionLineageService().getLineageTree(sessionId),
        getNode: (sessionId: string, lineageNodeId: string) =>
          deps.getSessionLineageService().getLineageNode(sessionId, lineageNodeId),
        listChildren: (sessionId: string, lineageNodeId: string) =>
          deps.getSessionLineageService().listLineageChildren(sessionId, lineageNodeId),
        getContextEntryPath: (
          sessionId: string,
          input?: Parameters<SessionLineageService["getContextEntryPath"]>[1],
        ) => deps.getSessionLineageService().getContextEntryPath(sessionId, input),
      },
    },
    operator: {
      workerResults: {
        clear: (sessionId: string) => deps.getParallelService().clearWorkerResults(sessionId),
      },
      state: {
        clear: (sessionId: string) =>
          deps.getSessionLifecycleService().clearSessionState(sessionId),
        onClear: (listener: (sessionId: string) => void) =>
          deps.getSessionLifecycleService().onClearState(listener),
      },
      stall: {
        poll: (
          sessionId: string,
          input?: {
            now?: number;
            thresholdMs?: number;
          },
        ) =>
          deps.getTaskWatchdogService().pollTaskProgress({
            sessionId,
            now: input?.now,
            thresholdMs: input?.thresholdMs,
          }),
      },
      credentials: {
        resolveBindings: (sessionId: string, toolName: string) => {
          deps.getSessionLifecycleService().ensureHydrated(sessionId);
          return deps
            .getCredentialVaultService()
            .resolveToolBindings(toolName, deps.runtimeConfig.security.credentials.bindings);
        },
      },
    },
  };
}

export function createSessionWireSurfaceMethods(deps: SessionWireSurfaceDependencies) {
  return {
    query: (sessionId: string) => deps.getSessionWireService().query(sessionId),
    subscribe: (sessionId: string, listener: Parameters<SessionWireService["subscribe"]>[1]) =>
      deps.getSessionWireService().subscribe(sessionId, listener),
  };
}

export type RuntimeSessionSurfaceMethods = ReturnType<typeof createSessionSurfaceMethods>;
export type RuntimeSessionWireSurfaceMethods = ReturnType<typeof createSessionWireSurfaceMethods>;

export function createSessionAuthoritySurface(deps: SessionSurfaceDependencies) {
  return createSessionSurfaceMethods(deps).authority;
}

export function createSessionInspectSurface(deps: SessionSurfaceDependencies) {
  return createSessionSurfaceMethods(deps).inspect;
}

export function createSessionOperatorSurface(deps: SessionSurfaceDependencies) {
  return createSessionSurfaceMethods(deps).operator;
}

export function createSessionWireInspectSurface(deps: SessionWireSurfaceDependencies) {
  return createSessionWireSurfaceMethods(deps);
}
