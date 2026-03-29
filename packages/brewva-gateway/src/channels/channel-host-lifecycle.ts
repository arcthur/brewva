import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { TurnWALRecovery, type TurnWALStore } from "@brewva/brewva-runtime/channels";
import { waitForAllSettledWithTimeout } from "../utils/async.js";
import { toErrorMessage } from "../utils/errors.js";
import { createSerializedAsyncTaskRunner } from "../utils/serialized-async-task-runner.js";
import type { AgentRuntimeManager } from "./agent-runtime-manager.js";
import type { ChannelModeLaunchBundle } from "./channel-bootstrap.js";
import type { ChannelSessionCoordinator } from "./channel-session-coordinator.js";
import type { ChannelTurnDispatcher } from "./channel-turn-dispatcher.js";

export async function runChannelHostLifecycle(input: {
  runtime: BrewvaRuntime;
  channel: string;
  verbose: boolean;
  bundle: ChannelModeLaunchBundle;
  turnWalStore: TurnWALStore;
  turnWalCompactIntervalMs: number;
  dispatcher: Pick<ChannelTurnDispatcher, "enqueueInboundTurn" | "listQueueTails">;
  sessionCoordinator: Pick<
    ChannelSessionCoordinator,
    "listQueueTails" | "disposeAllSessions" | "evictIdleAgentRuntimesByTtl"
  >;
  runtimeManager: Pick<AgentRuntimeManager, "disposeAll" | "evictIdleRuntimes">;
  shutdownSignal?: AbortSignal;
  setShuttingDown(value: boolean): void;
}): Promise<void> {
  const turnWalMaintenance = createSerializedAsyncTaskRunner(async () => {
    try {
      input.turnWalStore.compact();
      await input.sessionCoordinator.evictIdleAgentRuntimesByTtl(Date.now());
      const evicted = input.runtimeManager.evictIdleRuntimes(Date.now());
      if (evicted.length > 0) {
        input.runtime.events.record({
          sessionId: input.turnWalStore.scope,
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
  let turnWalCompactTimer: ReturnType<typeof setInterval> | null = null;

  const stopTurnWalMaintenance = (): void => {
    if (!turnWalCompactTimer) return;
    clearInterval(turnWalCompactTimer);
    turnWalCompactTimer = null;
  };

  const disposeQueues = async (): Promise<void> => {
    await waitForAllSettledWithTimeout(
      [...input.dispatcher.listQueueTails(), ...input.sessionCoordinator.listQueueTails()],
      input.runtime.config.infrastructure.interruptRecovery.gracefulTimeoutMs,
    );
    await input.sessionCoordinator.disposeAllSessions();
    input.runtimeManager.disposeAll();
  };

  const recovery = new TurnWALRecovery({
    workspaceRoot: input.runtime.workspaceRoot,
    config: input.runtime.config.infrastructure.turnWal,
    scopeFilter: (scope) => scope === input.turnWalStore.scope,
    recordEvent: (event) => {
      input.runtime.events.record({
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
  await recovery.recover();
  input.turnWalStore.compact();

  if (input.turnWalStore.isEnabled) {
    turnWalCompactTimer = setInterval(() => {
      void turnWalMaintenance.run();
    }, input.turnWalCompactIntervalMs);
    turnWalCompactTimer.unref?.();
  }

  try {
    await input.bundle.bridge.start();
    await input.bundle.onStart?.();
  } catch (error) {
    stopTurnWalMaintenance();
    await turnWalMaintenance.whenIdle();
    await Promise.allSettled([input.bundle.onStop?.(), input.bundle.bridge.stop()]);
    throw error;
  }

  if (input.verbose) {
    console.error(`[channel] ${input.channel} bridge started`);
  }

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    let removeAbortListener: (() => void) | null = null;

    const cleanupListeners = () => {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      removeAbortListener?.();
      removeAbortListener = null;
    };

    const shutdown = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      input.setShuttingDown(true);

      void (async () => {
        try {
          if (input.verbose) {
            console.error(`[channel] received ${signal}, stopping...`);
          }
          stopTurnWalMaintenance();
          await turnWalMaintenance.whenIdle();
          await input.bundle.onStop?.();
          await input.bundle.bridge.stop();
          await disposeQueues();
          cleanupListeners();
          if (input.verbose) {
            console.error("[channel] shutdown completed");
          }
          resolve();
        } catch (error) {
          cleanupListeners();
          reject(error);
        }
      })();
    };

    const onSigInt = (): void => shutdown("SIGINT");
    const onSigTerm = (): void => shutdown("SIGTERM");
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);

    if (input.shutdownSignal) {
      const onAbort = () => shutdown("SIGTERM");
      input.shutdownSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        input.shutdownSignal?.removeEventListener("abort", onAbort);
      };
      if (input.shutdownSignal.aborted) {
        shutdown("SIGTERM");
      }
    }
  });
}
