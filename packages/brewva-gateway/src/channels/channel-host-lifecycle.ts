import {
  BrewvaEffect,
  addScopedFinalizer,
  fromAbortableBoundaryPromise,
  runEdgeOperation,
  startScopedSchedule,
  type BrewvaBoundaryError,
  type BrewvaScope,
  type ScopedScheduleHandle,
} from "@brewva/brewva-effect";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createRecoveryWalRecovery, type RecoveryWalStore } from "@brewva/brewva-runtime/recovery";
import { createNonOverlappingTaskRunner } from "@brewva/brewva-std/async";
import { waitForAllSettledWithTimeout } from "../utils/async.js";
import { toErrorMessage } from "../utils/errors.js";
import type { AgentRuntimeManager } from "./agent-runtime-manager.js";
import type { ChannelModeLaunchBundle } from "./channel-bootstrap.js";
import type { ChannelSessionCoordinator } from "./channel-session-coordinator.js";
import type { ChannelTurnDispatcher } from "./channel-turn-dispatcher.js";

export interface RunChannelHostLifecycleInput {
  runtime: BrewvaRuntime;
  channel: string;
  verbose: boolean;
  bundle: ChannelModeLaunchBundle;
  recoveryWalStore: RecoveryWalStore;
  recoveryWalCompactIntervalMs: number;
  dispatcher: Pick<ChannelTurnDispatcher, "enqueueInboundTurn" | "listQueueTails">;
  sessionCoordinator: Pick<
    ChannelSessionCoordinator,
    "listQueueTails" | "disposeAllSessions" | "evictIdleAgentRuntimesByTtl"
  >;
  runtimeManager: Pick<AgentRuntimeManager, "disposeAll" | "evictIdleRuntimes">;
  shutdownSignal?: AbortSignal;
  setShuttingDown(value: boolean): void;
}

function waitForChannelShutdownSignal(
  input: RunChannelHostLifecycleInput,
): BrewvaEffect.Effect<NodeJS.Signals, BrewvaBoundaryError> {
  return fromAbortableBoundaryPromise(
    (signal) =>
      new Promise<NodeJS.Signals>((resolve) => {
        let settled = false;
        let removeExternalAbortListener: (() => void) | null = null;

        const cleanupListeners = () => {
          process.off("SIGINT", onSigInt);
          process.off("SIGTERM", onSigTerm);
          signal.removeEventListener("abort", onAbort);
          removeExternalAbortListener?.();
          removeExternalAbortListener = null;
        };

        const shutdown = (nextSignal: NodeJS.Signals): void => {
          if (settled) return;
          settled = true;
          input.setShuttingDown(true);
          cleanupListeners();
          resolve(nextSignal);
        };

        const onSigInt = (): void => shutdown("SIGINT");
        const onSigTerm = (): void => shutdown("SIGTERM");
        const onAbort = (): void => shutdown("SIGTERM");

        process.on("SIGINT", onSigInt);
        process.on("SIGTERM", onSigTerm);
        signal.addEventListener("abort", onAbort, { once: true });

        if (input.shutdownSignal) {
          const onExternalAbort = () => shutdown("SIGTERM");
          input.shutdownSignal.addEventListener("abort", onExternalAbort, { once: true });
          removeExternalAbortListener = () => {
            input.shutdownSignal?.removeEventListener("abort", onExternalAbort);
          };
          if (input.shutdownSignal.aborted) {
            shutdown("SIGTERM");
          }
        }
      }),
    input.shutdownSignal,
  );
}

export function runChannelHostLifecycleEffect(
  input: RunChannelHostLifecycleInput,
): BrewvaEffect.Effect<void, BrewvaBoundaryError, BrewvaScope.Scope> {
  const recoveryWalScope = input.recoveryWalStore.getScope();
  const recoveryWalMaintenance = createNonOverlappingTaskRunner(async () => {
    try {
      input.recoveryWalStore.compact();
      await input.sessionCoordinator.evictIdleAgentRuntimesByTtl(Date.now());
      const evicted = input.runtimeManager.evictIdleRuntimes(Date.now());
      if (evicted.length > 0) {
        input.runtime.extensions.hosted.events.record({
          sessionId: recoveryWalScope,
          type: "channel_runtime_evicted",
          payload: {
            agentIds: evicted,
            source: "runtime_idle_reclaim",
          },
          skipTapeCheckpoint: true,
        });
      }
    } catch (error) {
      if (input.verbose) {
        console.error(`[channel:${input.channel}:wal] compact failed: ${toErrorMessage(error)}`);
      }
    }
  });
  let recoveryWalCompactTimer: ScopedScheduleHandle | null = null;
  let bridgeStarted = false;
  let bundleStarted = false;

  const stopRecoveryWalMaintenance = async (): Promise<void> => {
    if (!recoveryWalCompactTimer) return;
    const timer = recoveryWalCompactTimer;
    recoveryWalCompactTimer = null;
    await timer.close();
  };

  const disposeQueues = async (): Promise<void> => {
    await waitForAllSettledWithTimeout(
      [...input.dispatcher.listQueueTails(), ...input.sessionCoordinator.listQueueTails()],
      input.runtime.config.infrastructure.interruptRecovery.gracefulTimeoutMs,
    );
    await input.sessionCoordinator.disposeAllSessions();
    input.runtimeManager.disposeAll();
  };

  const recovery = createRecoveryWalRecovery({
    workspaceRoot: input.runtime.workspaceRoot,
    config: input.runtime.config.infrastructure.recoveryWal,
    scopeFilter: (scope) => scope === recoveryWalScope,
    recordEvent: (event) => {
      input.runtime.extensions.hosted.events.record({
        sessionId: event.sessionId,
        type: event.type,
        payload: event.payload,
        skipTapeCheckpoint: true,
      });
    },
    handlers: {
      channel: async ({ record }) => {
        await input.dispatcher.enqueueInboundTurn(record.envelope, { walId: record.walId });
      },
    },
  });
  return BrewvaEffect.gen(function* () {
    yield* addScopedFinalizer(async () => {
      await stopRecoveryWalMaintenance();
      await recoveryWalMaintenance.whenIdle();
      if (bundleStarted) {
        await input.bundle.onStop?.();
        bundleStarted = false;
      }
      if (bridgeStarted) {
        await input.bundle.bridge.stop();
        bridgeStarted = false;
      }
      await disposeQueues();
      if (input.verbose) {
        console.error("[channel] shutdown completed");
      }
    });

    yield* fromAbortableBoundaryPromise(() => recovery.recover(), input.shutdownSignal);
    input.recoveryWalStore.compact();

    if (input.recoveryWalStore.isWalEnabled()) {
      recoveryWalCompactTimer = startScopedSchedule({
        intervalMs: input.recoveryWalCompactIntervalMs,
        run: () => BrewvaEffect.promise(() => recoveryWalMaintenance.run()),
      });
    }

    yield* fromAbortableBoundaryPromise(() => input.bundle.bridge.start(), input.shutdownSignal);
    bridgeStarted = true;
    yield* fromAbortableBoundaryPromise(
      () => Promise.resolve(input.bundle.onStart?.()),
      input.shutdownSignal,
    );
    bundleStarted = true;

    if (input.verbose) {
      console.error(`[channel] ${input.channel} bridge started`);
    }

    const signal = yield* waitForChannelShutdownSignal(input);
    if (input.verbose) {
      console.error(`[channel] received ${signal}, stopping...`);
    }
  });
}

export async function runChannelHostLifecycle(input: RunChannelHostLifecycleInput): Promise<void> {
  return runEdgeOperation("brewva.channel.host.lifecycle", runChannelHostLifecycleEffect(input), {
    fields: {
      channel: input.channel,
      workspaceRoot: input.runtime.workspaceRoot,
    },
  });
}
