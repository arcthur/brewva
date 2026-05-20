import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { createBrewvaServiceRuntime } from "@brewva/brewva-effect/runtime";
import { resolveRuntimeSourceIdentity } from "@brewva/brewva-std/runtime-identity";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { ManagedExecProcessRegistryService, type ManagedExecProcessRegistry } from "./service.js";
import type {
  ManagedBoxExecFinishedSession,
  ManagedBoxExecRunningSession,
  ManagedBoxExecStartInput,
  ManagedBoxExecStartResult,
  ManagedExecFinishedSession,
  ManagedExecRunningSession,
  ManagedExecStartInput,
  ManagedExecStartResult,
  ManagedSession,
} from "./types.js";

export interface ManagedExecProcessRegistryRuntime {
  readonly runEffect: <A, E>(
    effect: BrewvaEffect.Effect<A, E, ManagedExecProcessRegistryService>,
  ) => Promise<A>;
  readonly startHost: (input: ManagedExecStartInput) => Promise<ManagedExecStartResult>;
  readonly startBox: (input: ManagedBoxExecStartInput) => Promise<ManagedBoxExecStartResult>;
  readonly getManaged: (
    ownerSessionId: string,
    sessionId: string,
  ) => Promise<ManagedSession | undefined>;
  readonly getRunning: (
    ownerSessionId: string,
    sessionId: string,
  ) => Promise<ManagedExecRunningSession | undefined>;
  readonly getRunningBox: (
    ownerSessionId: string,
    sessionId: string,
  ) => Promise<ManagedBoxExecRunningSession | undefined>;
  readonly getFinished: (
    ownerSessionId: string,
    sessionId: string,
  ) => Promise<ManagedExecFinishedSession | undefined>;
  readonly getFinishedBox: (
    ownerSessionId: string,
    sessionId: string,
  ) => Promise<ManagedBoxExecFinishedSession | undefined>;
  readonly listRunningBackground: (ownerSessionId: string) => Promise<ManagedExecRunningSession[]>;
  readonly listRunningBoxBackground: (
    ownerSessionId: string,
  ) => Promise<ManagedBoxExecRunningSession[]>;
  readonly listFinishedBackground: (
    ownerSessionId: string,
  ) => Promise<ManagedExecFinishedSession[]>;
  readonly listFinishedBoxBackground: (
    ownerSessionId: string,
  ) => Promise<ManagedBoxExecFinishedSession[]>;
  readonly markBackgrounded: (ownerSessionId: string, sessionId: string) => Promise<boolean>;
  readonly delete: (ownerSessionId: string, sessionId: string) => Promise<boolean>;
  readonly terminateHost: (session: ManagedExecRunningSession, force?: boolean) => Promise<boolean>;
  readonly terminateBox: (
    session: ManagedBoxExecRunningSession,
    force?: boolean,
  ) => Promise<boolean>;
  readonly waitActivity: (
    ownerSessionId: string,
    sessionId: string,
    timeoutMs: number,
  ) => Promise<void>;
  readonly cleanupExpired: (now?: number) => Promise<void>;
  readonly closeSession: (ownerSessionId: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

const runtimeHookRegistrations = new WeakMap<object, Set<ManagedExecProcessRegistryRuntime>>();

export function createManagedExecProcessRegistryRuntime(): ManagedExecProcessRegistryRuntime {
  const runtime = createBrewvaServiceRuntime(
    ManagedExecProcessRegistryService,
    ManagedExecProcessRegistryService.layer(),
    {
      name: "tools.exec.processRegistry",
    },
  );
  let closed = false;

  const runEffect = async <A, E>(
    effect: BrewvaEffect.Effect<A, E, ManagedExecProcessRegistryService>,
  ): Promise<A> => {
    if (closed) {
      throw new Error("managed exec process registry runtime is closed");
    }
    return await runtime.run(effect);
  };

  const runRegistry = async <A, E>(
    operation: (
      registry: ManagedExecProcessRegistry,
    ) => BrewvaEffect.Effect<A, E, ManagedExecProcessRegistryService>,
  ): Promise<A> => {
    if (closed) {
      throw new Error("managed exec process registry runtime is closed");
    }
    return await runtime.runService(operation);
  };

  const closeSession = async (ownerSessionId: string): Promise<void> => {
    const running = [
      ...(await runRegistry((registry) => registry.listRunningBackground(ownerSessionId))),
      ...(await runRegistry((registry) => registry.listRunningBoxBackground(ownerSessionId))),
    ];
    await Promise.allSettled(
      running.map(async (session) => {
        if (session.kind === "running") {
          await runRegistry((registry) => registry.terminateHost(session, true));
        } else {
          await runRegistry((registry) => registry.terminateBox(session, true));
        }
      }),
    );
  };

  return {
    runEffect,
    startHost: (input) => runRegistry((registry) => registry.startHost(input)),
    startBox: (input) => runRegistry((registry) => registry.startBox(input)),
    getManaged: (ownerSessionId, sessionId) =>
      runRegistry((registry) => registry.getManaged(ownerSessionId, sessionId)),
    getRunning: (ownerSessionId, sessionId) =>
      runRegistry((registry) => registry.getRunning(ownerSessionId, sessionId)),
    getRunningBox: (ownerSessionId, sessionId) =>
      runRegistry((registry) => registry.getRunningBox(ownerSessionId, sessionId)),
    getFinished: (ownerSessionId, sessionId) =>
      runRegistry((registry) => registry.getFinished(ownerSessionId, sessionId)),
    getFinishedBox: (ownerSessionId, sessionId) =>
      runRegistry((registry) => registry.getFinishedBox(ownerSessionId, sessionId)),
    listRunningBackground: (ownerSessionId) =>
      runRegistry((registry) => registry.listRunningBackground(ownerSessionId)),
    listRunningBoxBackground: (ownerSessionId) =>
      runRegistry((registry) => registry.listRunningBoxBackground(ownerSessionId)),
    listFinishedBackground: (ownerSessionId) =>
      runRegistry((registry) => registry.listFinishedBackground(ownerSessionId)),
    listFinishedBoxBackground: (ownerSessionId) =>
      runRegistry((registry) => registry.listFinishedBoxBackground(ownerSessionId)),
    markBackgrounded: (ownerSessionId, sessionId) =>
      runRegistry((registry) => registry.markBackgrounded(ownerSessionId, sessionId)),
    delete: (ownerSessionId, sessionId) =>
      runRegistry((registry) => registry.delete(ownerSessionId, sessionId)),
    terminateHost: (session, force) =>
      runRegistry((registry) => registry.terminateHost(session, force)),
    terminateBox: (session, force) =>
      runRegistry((registry) => registry.terminateBox(session, force)),
    waitActivity: (ownerSessionId, sessionId, timeoutMs) =>
      runRegistry((registry) => registry.waitActivity(ownerSessionId, sessionId, timeoutMs)),
    cleanupExpired: (now) => runRegistry((registry) => registry.cleanupExpired(now)),
    closeSession,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await runtime.dispose();
    },
  };
}

export function resolveManagedExecProcessRegistryRuntime(
  runtime: BrewvaBundledToolRuntime | undefined,
): ManagedExecProcessRegistryRuntime {
  if (!runtime) {
    return createManagedExecProcessRegistryRuntime();
  }
  if (runtime.execProcessRegistry) {
    registerManagedExecProcessRegistryRuntimeHooks(runtime, runtime.execProcessRegistry);
    return runtime.execProcessRegistry;
  }
  throw new Error(
    "managed exec process registry runtime is required for execution tools; build tools through buildBrewvaTools(...) or pass runtime.execProcessRegistry explicitly",
  );
}

export function registerManagedExecProcessRegistryRuntimeHooks(
  runtime: BrewvaBundledToolRuntime | undefined,
  registry: ManagedExecProcessRegistryRuntime,
): void {
  if (!runtime?.extensions?.tools?.onClearState) return;
  const runtimeKey = resolveRuntimeSourceIdentity(runtime as object);
  let registries = runtimeHookRegistrations.get(runtimeKey);
  if (!registries) {
    registries = new Set();
    runtimeHookRegistrations.set(runtimeKey, registries);
  }
  if (registries.has(registry)) return;
  registries.add(registry);
  runtime.extensions.tools.onClearState((sessionId) => {
    void registry.closeSession(sessionId).catch(() => {});
  });
}
