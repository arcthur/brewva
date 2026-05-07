import {
  BrewvaDeferred,
  BrewvaDuration,
  BrewvaEffect,
  BrewvaScope,
  BrewvaWorkerScope,
  runPromiseAtBoundary,
  withBrewvaObservability,
} from "@brewva/brewva-effect";
import type { BrewvaWalId } from "@brewva/brewva-runtime";
import { validateSessionWireFramePayload } from "../../protocol/validate.js";
import type {
  ParentToWorkerMessage,
  WorkerToParentMessage,
} from "../../session/worker-protocol.js";
import { SessionBackendStateError } from "../session-backend.js";
import type { SendPromptOutput } from "../session-backend.js";
import {
  type WorkerHandle,
  type WorkerRpcControllerDeps,
  type WorkerRpcErrorInput,
} from "./worker-state.js";

const WORKER_RPC_TIMEOUT_MS = 5 * 60_000;

function normalizeWorkerRpcTimeoutMs(timeoutMs: number): number {
  return Math.max(1_000, Math.trunc(timeoutMs));
}

function failDeferred<A>(deferred: BrewvaDeferred.Deferred<A, Error>, error: Error): void {
  BrewvaDeferred.doneUnsafe(deferred, BrewvaEffect.fail(error));
}

function succeedDeferred<A>(deferred: BrewvaDeferred.Deferred<A, Error>, payload: A): void {
  BrewvaDeferred.doneUnsafe(deferred, BrewvaEffect.succeed(payload));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function withWorkerRpcObservability<A, E, R>(
  handle: WorkerHandle,
  operation: string,
  effect: BrewvaEffect.Effect<A, E, R>,
): BrewvaEffect.Effect<A, E, R> {
  const fields = {
    sessionId: handle.sessionId,
    workerPid: handle.child.pid,
    operation,
  };
  return BrewvaScope.provide(handle.scope)(
    effect.pipe(
      BrewvaEffect.provide(
        BrewvaWorkerScope.layer({
          sessionId: handle.sessionId,
          pid: handle.child.pid ?? undefined,
        }),
      ),
      withBrewvaObservability(`brewva.gateway.worker.${operation}`, fields),
    ),
  );
}

export function toWorkerResultError(input: WorkerRpcErrorInput): Error {
  if (input.errorCode === "session_busy") {
    return new SessionBackendStateError("session_busy", input.error);
  }
  return new Error(input.error);
}

export function extractBusyTurnId(error: unknown): string | undefined {
  if (!(error instanceof SessionBackendStateError) || error.code !== "session_busy") {
    return undefined;
  }
  const match = error.message.match(/active turn:\s*(.+)$/i);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export class SessionWorkerRpcController {
  constructor(private readonly deps: WorkerRpcControllerDeps) {}

  attachWorkerListeners(handle: WorkerHandle): void {
    handle.child.on("message", (message) => {
      this.handleWorkerMessage(handle, message);
    });

    handle.child.on("exit", (code, signal) => {
      this.deps.logger.info("worker exited", {
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        code,
        signal,
      });
      this.failAllPending(handle, new Error("worker exited"));
      this.deps.onWorkerExited(handle, {
        code,
        signal,
      });
    });

    handle.child.on("error", (error) => {
      this.deps.logger.error("worker error", {
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        error: error.message,
      });
    });
  }

  request(
    handle: WorkerHandle,
    message: Exclude<ParentToWorkerMessage, { kind: "bridge.ping" | "init" }>,
    timeoutMs = WORKER_RPC_TIMEOUT_MS,
  ): Promise<Record<string, unknown> | undefined> {
    return runPromiseAtBoundary(this.requestEffect(handle, message, timeoutMs)).catch((error) =>
      Promise.reject(toError(error)),
    );
  }

  requestEffect(
    handle: WorkerHandle,
    message: Exclude<ParentToWorkerMessage, { kind: "bridge.ping" | "init" }>,
    timeoutMs = WORKER_RPC_TIMEOUT_MS,
  ): BrewvaEffect.Effect<Record<string, unknown> | undefined, Error> {
    return withWorkerRpcObservability(
      handle,
      "request",
      BrewvaEffect.gen({ self: this }, function* () {
        const deferred = yield* BrewvaEffect.sync(() => this.openPendingRequest(handle, message));
        return yield* this.awaitPendingRequestEffect(handle, message, deferred, timeoutMs);
      }),
    );
  }

  registerPendingTurn(
    handle: WorkerHandle,
    turnId: string,
    timeoutMs: number,
  ): Promise<SendPromptOutput> {
    return runPromiseAtBoundary(this.registerPendingTurnEffect(handle, turnId, timeoutMs));
  }

  registerPendingTurnEffect(
    handle: WorkerHandle,
    turnId: string,
    timeoutMs: number,
  ): BrewvaEffect.Effect<SendPromptOutput, Error> {
    return withWorkerRpcObservability(
      handle,
      "turn",
      BrewvaEffect.gen({ self: this }, function* () {
        const normalizedTurnId = yield* BrewvaEffect.sync(() =>
          this.validatePendingTurn(handle, turnId),
        );
        const deferred = yield* BrewvaEffect.sync(() =>
          this.openPendingTurn(handle, normalizedTurnId),
        );
        return yield* this.awaitPendingTurnEffect(handle, normalizedTurnId, deferred, timeoutMs);
      }),
    );
  }

  trackRecoveryWalId(handle: WorkerHandle, turnId: string, walId: BrewvaWalId): void {
    handle.activeRecoveryWalIds.set(turnId, walId);
  }

  untrackRecoveryWalId(handle: WorkerHandle, turnId: string): BrewvaWalId | undefined {
    const walId = handle.activeRecoveryWalIds.get(turnId);
    handle.activeRecoveryWalIds.delete(turnId);
    return walId;
  }

  rekeyRecoveryWalId(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void {
    if (fromTurnId === toTurnId) {
      return;
    }
    const walId = handle.activeRecoveryWalIds.get(fromTurnId);
    if (!walId) {
      return;
    }
    handle.activeRecoveryWalIds.delete(fromTurnId);
    handle.activeRecoveryWalIds.set(toTurnId, walId);
  }

  markRecoveryWalDone(handle: WorkerHandle, turnId: string): void {
    const walId = this.untrackRecoveryWalId(handle, turnId);
    if (!walId) return;
    this.deps.recoveryWalStore?.markDone(walId);
  }

  markRecoveryWalFailed(handle: WorkerHandle, turnId: string, error?: string): void {
    const walId = this.untrackRecoveryWalId(handle, turnId);
    if (!walId) return;
    this.deps.recoveryWalStore?.markFailed(walId, error);
  }

  rekeyPendingTurn(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void {
    if (fromTurnId === toTurnId) {
      return;
    }
    const pending = handle.pendingTurns.get(fromTurnId);
    if (!pending) {
      return;
    }
    handle.pendingTurns.delete(fromTurnId);
    handle.pendingTurns.set(toTurnId, pending);
  }

  resolvePendingTurn(handle: WorkerHandle, turnId: string, payload: SendPromptOutput): void {
    const pending = handle.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }
    handle.pendingTurns.delete(turnId);
    succeedDeferred(pending.deferred, payload);
    this.deps.touchActivity(handle);
  }

  rejectPendingTurn(handle: WorkerHandle, turnId: string, error: unknown): void {
    const pending = handle.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }
    handle.pendingTurns.delete(turnId);
    failDeferred(pending.deferred, error instanceof Error ? error : new Error(String(error)));
    this.deps.touchActivity(handle);
  }

  failAllPending(handle: WorkerHandle, error: Error): void {
    if (handle.readyDeferred) {
      failDeferred(handle.readyDeferred, error);
      handle.readyDeferred = undefined;
      handle.readyRequestId = undefined;
    }

    for (const pending of handle.pending.values()) {
      failDeferred(pending.deferred, error);
    }
    handle.pending.clear();

    for (const pendingTurn of handle.pendingTurns.values()) {
      failDeferred(pendingTurn.deferred, error);
    }
    handle.pendingTurns.clear();

    for (const queued of handle.turnQueue) {
      queued.reject(error);
      if (queued.walId) {
        this.deps.recoveryWalStore?.markFailed(queued.walId, `worker_crash:${error.message}`);
      }
    }
    handle.turnQueue = [];

    for (const [, walId] of handle.activeRecoveryWalIds) {
      this.deps.recoveryWalStore?.markFailed(walId, `worker_crash:${error.message}`);
    }
    handle.activeRecoveryWalIds.clear();
    handle.activeTurnId = null;
  }

  handleWorkerMessage(handle: WorkerHandle, raw: unknown): void {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const message = raw as WorkerToParentMessage;

    if (message.kind === "bridge.heartbeat") {
      handle.lastHeartbeatAt = message.ts;
      return;
    }

    if (message.kind === "log") {
      const baseFields = {
        sessionId: handle.sessionId,
        workerPid: handle.child.pid ?? null,
      };
      this.deps.logger.log(
        message.level,
        message.message,
        message.fields ? { ...baseFields, ...message.fields } : baseFields,
      );
      return;
    }

    if (message.kind === "ready") {
      if (handle.readyRequestId === message.requestId) {
        const readyDeferred = handle.readyDeferred;
        handle.readyRequestId = undefined;
        handle.readyDeferred = undefined;
        this.deps.touchActivity(handle);
        if (readyDeferred) {
          succeedDeferred(readyDeferred, message.payload);
        }
      }
      return;
    }

    if (message.kind === "event") {
      if (message.event === "session.wire.frame") {
        const validatedFrame = validateSessionWireFramePayload(message.payload.frame);
        if (!validatedFrame.ok) {
          this.deps.logger.warn("dropping invalid session wire frame from worker", {
            sessionId: handle.sessionId,
            workerPid: handle.child.pid ?? null,
            error: validatedFrame.error,
          });
          return;
        }
        const frame = validatedFrame.frame;
        this.deps.touchActivity(handle);
        if (frame.type === "turn.committed") {
          this.markRecoveryWalDone(handle, frame.turnId);
          this.resolvePendingTurn(handle, frame.turnId, {
            attemptId: frame.attemptId,
            assistantText: frame.assistantText,
            toolOutputs: frame.toolOutputs,
          });
          if (handle.activeTurnId === frame.turnId) {
            handle.activeTurnId = null;
          }
          this.deps.onTurnQueueReady(handle);
        } else if (frame.type === "session.closed" && handle.activeTurnId) {
          this.markRecoveryWalFailed(handle, handle.activeTurnId, frame.reason);
          this.rejectPendingTurn(handle, handle.activeTurnId, frame.reason ?? "session closed");
          handle.activeTurnId = null;
          this.deps.onTurnQueueReady(handle);
        } else if (frame.type === "attempt.started" && frame.reason === "initial") {
          handle.activeTurnId = frame.turnId;
        }
      }
      this.deps.onWorkerEvent?.(message);
      return;
    }

    if (message.kind === "result") {
      if (handle.readyRequestId === message.requestId && !message.ok) {
        const readyDeferred = handle.readyDeferred;
        handle.readyRequestId = undefined;
        handle.readyDeferred = undefined;
        if (readyDeferred) {
          failDeferred(readyDeferred, new Error(message.error));
        }
        return;
      }

      const pending = handle.pending.get(message.requestId);
      if (!pending) {
        return;
      }

      handle.pending.delete(message.requestId);
      this.deps.touchActivity(handle);
      if (message.ok) {
        succeedDeferred(pending.deferred, message.payload);
      } else {
        failDeferred(pending.deferred, toWorkerResultError(message));
      }
    }
  }

  private openPendingRequest(
    handle: WorkerHandle,
    message: Exclude<ParentToWorkerMessage, { kind: "bridge.ping" | "init" }>,
  ): BrewvaDeferred.Deferred<Record<string, unknown> | undefined, Error> {
    const deferred = BrewvaDeferred.makeUnsafe<Record<string, unknown> | undefined, Error>();
    handle.pending.set(message.requestId, { deferred });
    try {
      this.sendToWorker(handle, message);
    } catch (error) {
      handle.pending.delete(message.requestId);
      failDeferred(deferred, toError(error));
      throw error;
    }
    return deferred;
  }

  private awaitPendingRequestEffect(
    handle: WorkerHandle,
    message: Exclude<ParentToWorkerMessage, { kind: "bridge.ping" | "init" }>,
    deferred: BrewvaDeferred.Deferred<Record<string, unknown> | undefined, Error>,
    timeoutMs: number,
  ): BrewvaEffect.Effect<Record<string, unknown> | undefined, Error> {
    return BrewvaEffect.race(
      BrewvaDeferred.await(deferred),
      BrewvaEffect.sleep(BrewvaDuration.millis(normalizeWorkerRpcTimeoutMs(timeoutMs))).pipe(
        BrewvaEffect.andThen(
          BrewvaEffect.fail(new Error(`worker request timeout: ${message.kind}`)),
        ),
      ),
    ).pipe(
      BrewvaEffect.ensuring(
        BrewvaEffect.sync(() => {
          handle.pending.delete(message.requestId);
        }),
      ),
    );
  }

  private validatePendingTurn(handle: WorkerHandle, turnId: string): string {
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) {
      throw new Error("turnId is required");
    }
    if (handle.pendingTurns.has(normalizedTurnId)) {
      throw new SessionBackendStateError(
        "duplicate_active_turn_id",
        `duplicate active turn id: ${normalizedTurnId}`,
      );
    }
    return normalizedTurnId;
  }

  private openPendingTurn(
    handle: WorkerHandle,
    turnId: string,
  ): BrewvaDeferred.Deferred<SendPromptOutput, Error> {
    const deferred = BrewvaDeferred.makeUnsafe<SendPromptOutput, Error>();
    handle.pendingTurns.set(turnId, { deferred });
    return deferred;
  }

  private awaitPendingTurnEffect(
    handle: WorkerHandle,
    turnId: string,
    deferred: BrewvaDeferred.Deferred<SendPromptOutput, Error>,
    timeoutMs: number,
  ): BrewvaEffect.Effect<SendPromptOutput, Error> {
    return BrewvaEffect.race(
      BrewvaDeferred.await(deferred),
      BrewvaEffect.sleep(BrewvaDuration.millis(normalizeWorkerRpcTimeoutMs(timeoutMs))).pipe(
        BrewvaEffect.andThen(BrewvaEffect.fail(new Error(`worker turn timeout: ${turnId}`))),
      ),
    ).pipe(
      BrewvaEffect.ensuring(
        BrewvaEffect.sync(() => {
          handle.pendingTurns.delete(turnId);
        }),
      ),
    );
  }

  private sendToWorker(handle: WorkerHandle, message: ParentToWorkerMessage): void {
    handle.child.send(message);
  }
}
