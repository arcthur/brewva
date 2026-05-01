import type { BrewvaConfig } from "../../config/types.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { ContextService } from "../context/api.js";
import type { CredentialVaultService } from "../credentials/api.js";
import type { ParallelService } from "../parallel/api.js";
import type { TaskWatchdogService } from "../task/api.js";
import type { IntegrityStatus } from "./integrity.js";
import type { SessionLifecycleService } from "./session-lifecycle.js";
import type { SessionRewindService } from "./session-rewind.js";
import type { SessionWireService } from "./session-wire.js";
import type { SessionHydrationState } from "./types.js";

export interface SessionSurfaceDependencies {
  runtimeConfig: BrewvaConfig;
  getContextService(): ContextService;
  getSessionLifecycleService(): SessionLifecycleService;
  getTaskWatchdogService(): TaskWatchdogService;
  getParallelService(): ParallelService;
  getSessionRewindService(): SessionRewindService;
  getCredentialVaultService(): CredentialVaultService;
}

export interface SessionWireSurfaceDependencies {
  getSessionWireService(): SessionWireService;
}

export function createSessionSurfaceMethods(deps: SessionSurfaceDependencies) {
  return {
    recordWorkerResult: (
      sessionId: string,
      result: Parameters<ParallelService["recordWorkerResult"]>[1],
    ) => deps.getParallelService().recordWorkerResult(sessionId, result),
    listWorkerResults: (sessionId: string) =>
      deps.getParallelService().listWorkerResults(sessionId),
    getOpenToolCalls: (sessionId: string) =>
      deps.getSessionLifecycleService().getOpenToolCalls(sessionId),
    getUncleanShutdownDiagnostic: (sessionId: string) =>
      deps.getSessionLifecycleService().getUncleanShutdownDiagnostic(sessionId),
    mergeWorkerResults: (sessionId: string) =>
      deps.getParallelService().mergeWorkerResults(sessionId),
    applyMergedWorkerResults: (
      sessionId: string,
      input: Parameters<ParallelService["applyMergedWorkerResults"]>[1],
    ) => deps.getParallelService().applyMergedWorkerResults(sessionId, input),
    clearWorkerResults: (sessionId: string) =>
      deps.getParallelService().clearWorkerResults(sessionId),
    pollStall: (
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
    clearState: (sessionId: string) =>
      deps.getSessionLifecycleService().clearSessionState(sessionId),
    onClearState: (listener: (sessionId: string) => void) =>
      deps.getSessionLifecycleService().onClearState(listener),
    getHydration: (sessionId: string): SessionHydrationState => {
      deps.getSessionLifecycleService().ensureHydrated(sessionId);
      return deps.getSessionLifecycleService().getHydrationState(sessionId);
    },
    getIntegrity: (sessionId: string): IntegrityStatus => {
      deps.getSessionLifecycleService().ensureHydrated(sessionId);
      return deps.getSessionLifecycleService().getIntegrityStatus(sessionId);
    },
    recordRewindCheckpoint: (
      sessionId: string,
      input?: Parameters<SessionRewindService["recordCheckpoint"]>[1],
    ) => deps.getSessionRewindService().recordCheckpoint(sessionId, input),
    rewind: (sessionId: string, input?: Parameters<SessionRewindService["rewind"]>[1]) =>
      deps.getSessionRewindService().rewind(sessionId, input),
    redo: (sessionId: string, input?: Parameters<SessionRewindService["redo"]>[1]) =>
      deps.getSessionRewindService().redo(sessionId, input),
    getRewindState: (sessionId: string) => deps.getSessionRewindService().getRewindState(sessionId),
    listRewindTargets: (sessionId: string) =>
      deps.getSessionRewindService().listRewindTargets(sessionId),
    commitCompaction: (
      sessionId: string,
      input: Parameters<ContextService["markContextCompacted"]>[1],
    ): BrewvaEventRecord => deps.getContextService().markContextCompacted(sessionId, input),
    resolveCredentialBindings: (sessionId: string, toolName: string) => {
      deps.getSessionLifecycleService().ensureHydrated(sessionId);
      return deps
        .getCredentialVaultService()
        .resolveToolBindings(toolName, deps.runtimeConfig.security.credentials.bindings);
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

export const sessionSurfaceContribution = {
  authority: [
    "recordRewindCheckpoint",
    "rewind",
    "redo",
    "commitCompaction",
    "applyMergedWorkerResults",
  ],
  inspect: [
    "listWorkerResults",
    "getOpenToolCalls",
    "getUncleanShutdownDiagnostic",
    "mergeWorkerResults",
    "getHydration",
    "getIntegrity",
    "getRewindState",
    "listRewindTargets",
  ],
  maintain: [
    "recordWorkerResult",
    "clearWorkerResults",
    "pollStall",
    "clearState",
    "onClearState",
    "resolveCredentialBindings",
  ],
} as const satisfies SurfaceContribution<RuntimeSessionSurfaceMethods>;

export const sessionWireSurfaceContribution = {
  inspect: ["query", "subscribe"],
} as const satisfies SurfaceContribution<RuntimeSessionWireSurfaceMethods>;

export const sessionRuntimeSurface = defineRuntimeSurfaceModule({
  name: "session",
  createMethods: createSessionSurfaceMethods,
  contribution: sessionSurfaceContribution,
});

export const sessionWireRuntimeSurface = defineRuntimeSurfaceModule({
  name: "sessionWire",
  createMethods: createSessionWireSurfaceMethods,
  contribution: sessionWireSurfaceContribution,
});
