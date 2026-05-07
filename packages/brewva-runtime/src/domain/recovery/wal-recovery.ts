import {
  BrewvaCause,
  BrewvaEffect,
  BrewvaExit,
  BrewvaSchema,
  runPromiseAtBoundary,
} from "@brewva/brewva-effect";
import type { BrewvaConfig } from "../../config/types.js";
import type {
  RecoveryWalRecord,
  RecoveryWalRecoveryResult,
  RecoveryWalSource,
} from "../schedule/types.js";
import { RecoveryWalStore } from "./wal-store.js";

export interface RecoveryWalRecoverHandlerInput {
  record: RecoveryWalRecord;
  store: RecoveryWalStore;
}

export type RecoveryWalRecoverHandler = (
  input: RecoveryWalRecoverHandlerInput,
) => Promise<void> | void;

export interface RecoveryWalRecoveryOptions {
  workspaceRoot: string;
  config: BrewvaConfig["infrastructure"]["recoveryWal"];
  now?: () => number;
  handlers?: Partial<Record<RecoveryWalSource, RecoveryWalRecoverHandler>>;
  scopeFilter?: (scope: string) => boolean;
  recordEvent?: (input: { sessionId: string; type: string; payload?: object }) => void;
}

function buildEmptySummary(): RecoveryWalRecoveryResult {
  return {
    recoveredAt: 0,
    scanned: 0,
    retried: 0,
    expired: 0,
    failed: 0,
    skipped: 0,
    compacted: 0,
    bySource: {
      channel: {
        scanned: 0,
        retried: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
      schedule: {
        scanned: 0,
        retried: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
      gateway: {
        scanned: 0,
        retried: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
      heartbeat: {
        scanned: 0,
        retried: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
      tool: {
        scanned: 0,
        retried: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
    },
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown_recovery_error";
}

export class RecoveryWalRecoveryError extends BrewvaSchema.TaggedErrorClass<RecoveryWalRecoveryError>()(
  "RecoveryWalRecoveryError",
  {
    message: BrewvaSchema.String,
    operation: BrewvaSchema.String,
    cause: BrewvaSchema.optional(BrewvaSchema.Unknown),
  },
) {}

function toRecoveryWalRecoveryError(operation: string, cause: unknown): RecoveryWalRecoveryError {
  return new RecoveryWalRecoveryError({
    message: `Recovery WAL recovery failed during ${operation}`,
    operation,
    cause,
  });
}

function recoverable<A>(
  operation: string,
  run: () => A | PromiseLike<A>,
): BrewvaEffect.Effect<A, RecoveryWalRecoveryError> {
  return BrewvaEffect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (error) => toRecoveryWalRecoveryError(operation, error),
  });
}

export class RecoveryWalRecovery {
  private readonly now: () => number;
  private readonly handlers: Partial<Record<RecoveryWalSource, RecoveryWalRecoverHandler>>;
  private readonly scopeFilter: (scope: string) => boolean;
  private readonly maxRetries: number;
  private readonly defaultTtlMs: number;
  private readonly scheduleTurnTtlMs: number;
  private readonly toolTurnTtlMs: number;
  private readonly recordEvent?:
    | ((input: { sessionId: string; type: string; payload?: object }) => void)
    | undefined;

  constructor(private readonly options: RecoveryWalRecoveryOptions) {
    this.now = options.now ?? (() => Date.now());
    this.handlers = options.handlers ?? {};
    this.scopeFilter = options.scopeFilter ?? (() => true);
    this.maxRetries = Math.max(0, Math.floor(options.config.maxRetries));
    this.defaultTtlMs = Math.max(1, Math.floor(options.config.defaultTtlMs));
    this.scheduleTurnTtlMs = Math.max(1, Math.floor(options.config.scheduleTurnTtlMs));
    this.toolTurnTtlMs = Math.max(1, Math.floor(options.config.toolTurnTtlMs));
    this.recordEvent = options.recordEvent;
  }

  async recover(): Promise<RecoveryWalRecoveryResult> {
    return await runPromiseAtBoundary(this.recoverEffect());
  }

  recoverEffect(): BrewvaEffect.Effect<RecoveryWalRecoveryResult, RecoveryWalRecoveryError> {
    return BrewvaEffect.gen({ self: this }, function* () {
      const result = buildEmptySummary();
      const recoveredAt = this.now();
      result.recoveredAt = recoveredAt;
      if (!this.options.config.enabled) {
        return result;
      }

      const scopes = yield* recoverable("list_scopes", () =>
        RecoveryWalStore.listScopeIds({
          workspaceRoot: this.options.workspaceRoot,
          dir: this.options.config.dir,
        }).filter((scope) => this.scopeFilter(scope)),
      );

      for (const scope of scopes) {
        const store = yield* recoverable(
          "open_scope",
          () =>
            new RecoveryWalStore({
              workspaceRoot: this.options.workspaceRoot,
              config: this.options.config,
              scope,
              now: this.now,
              recordEvent: this.recordEvent,
            }),
        );
        const rows = yield* recoverable("list_pending", () => store.listPending());
        for (const row of rows) {
          result.scanned += 1;
          result.bySource[row.source].scanned += 1;

          if (this.isExpired(row, recoveredAt)) {
            yield* recoverable("mark_expired", () => store.markExpired(row.walId));
            result.expired += 1;
            result.bySource[row.source].expired += 1;
            continue;
          }

          if (row.attempts >= this.maxRetries) {
            yield* recoverable("mark_max_retries_failed", () =>
              store.markFailed(row.walId, "max_retries_exhausted"),
            );
            result.failed += 1;
            result.bySource[row.source].failed += 1;
            continue;
          }

          const handler = this.handlers[row.source];
          if (!handler) {
            result.skipped += 1;
            result.bySource[row.source].skipped += 1;
            continue;
          }

          const handlerExit = yield* BrewvaEffect.tryPromise({
            try: () => Promise.resolve(handler({ record: row, store })),
            catch: (error) => error,
          }).pipe(BrewvaEffect.exit);
          if (BrewvaExit.isSuccess(handlerExit)) {
            result.retried += 1;
            result.bySource[row.source].retried += 1;
            continue;
          }

          const error = BrewvaCause.squash(handlerExit.cause);
          yield* recoverable("mark_handler_failed", () =>
            store.markFailed(row.walId, `recovery_retry_failed:${toErrorMessage(error)}`),
          );
          result.failed += 1;
          result.bySource[row.source].failed += 1;
        }

        const compacted = yield* recoverable("compact_scope", () => store.compact());
        result.compacted += compacted.dropped;
      }

      yield* recoverable("emit_recovery_completed", () => this.emitRecoveryCompleted(result));
      return result;
    });
  }

  private isExpired(record: RecoveryWalRecord, nowMs: number): boolean {
    const ttlMs =
      typeof record.ttlMs === "number" && Number.isFinite(record.ttlMs) && record.ttlMs > 0
        ? Math.floor(record.ttlMs)
        : record.source === "schedule"
          ? this.scheduleTurnTtlMs
          : record.source === "tool"
            ? this.toolTurnTtlMs
            : this.defaultTtlMs;
    const lastActivity = Math.max(record.createdAt, record.updatedAt);
    return lastActivity + ttlMs < nowMs;
  }

  private emitRecoveryCompleted(result: RecoveryWalRecoveryResult): void {
    this.recordEvent?.({
      sessionId: "recovery_wal:recovery",
      type: "recovery_wal_recovery_completed",
      payload: {
        recoveredAt: result.recoveredAt,
        scanned: result.scanned,
        retried: result.retried,
        expired: result.expired,
        failed: result.failed,
        skipped: result.skipped,
        compacted: result.compacted,
        bySource: result.bySource,
      },
    });
  }
}
