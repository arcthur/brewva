import type {
  BrewvaEventRecord,
  BrewvaWalId,
  RecoveryWalRecord,
  RecoveryWalSource,
} from "./contracts/index.js";
import { BREWVA_RUNTIME_METHOD_GROUPS } from "./runtime-symbols.js";
import type { BrewvaHostedRuntimePort, BrewvaRuntime } from "./runtime.js";
import type { RuntimeRecordEvent, RuntimeRecordEventInput } from "./services/event-pipeline.js";

type InternalRecoveryWalPort = {
  appendPending(
    envelope: unknown,
    source: RecoveryWalSource,
    options?: { ttlMs?: number; dedupeKey?: string },
  ): RecoveryWalRecord;
  markInflight(walId: BrewvaWalId): RecoveryWalRecord | undefined;
  markDone(walId: BrewvaWalId): RecoveryWalRecord | undefined;
  markFailed(walId: BrewvaWalId, error?: string): RecoveryWalRecord | undefined;
  markExpired(walId: BrewvaWalId): RecoveryWalRecord | undefined;
  listPending(): RecoveryWalRecord[];
};

type InternalRuntimeMethodGroups = {
  recoveryWal: InternalRecoveryWalPort;
  events: {
    record: RuntimeRecordEvent;
    resolveLogPath(sessionId: string): string;
  };
};

type RuntimeMethodGroupsCarrier = {
  [BREWVA_RUNTIME_METHOD_GROUPS]?: InternalRuntimeMethodGroups;
};

function bindMethods<TObject extends object, const TKeys extends readonly (keyof TObject)[]>(
  owner: TObject,
  keys: TKeys,
): Pick<TObject, TKeys[number]> {
  const result = {} as Pick<TObject, TKeys[number]>;
  for (const key of keys) {
    const value = owner[key];
    if (typeof value !== "function") {
      throw new Error(`Expected method at key ${String(key)}`);
    }
    (result as Record<string, unknown>)[String(key)] = value.bind(owner);
  }
  return result;
}

function requireRuntimeMethodGroups(
  runtime: RuntimeMethodGroupsCarrier,
): InternalRuntimeMethodGroups {
  const methodGroups = runtime[BREWVA_RUNTIME_METHOD_GROUPS];
  if (!methodGroups) {
    throw new Error("Brewva runtime internal method groups are unavailable");
  }
  return methodGroups;
}

export interface BrewvaSchedulerIngressPort {
  appendPending(
    envelope: unknown,
    source: RecoveryWalSource,
    options?: { ttlMs?: number; dedupeKey?: string },
  ): RecoveryWalRecord;
  markInflight(walId: BrewvaWalId): RecoveryWalRecord | undefined;
  markDone(walId: BrewvaWalId): RecoveryWalRecord | undefined;
  markFailed(walId: BrewvaWalId, error?: string): RecoveryWalRecord | undefined;
  markExpired(walId: BrewvaWalId): RecoveryWalRecord | undefined;
  listPending(): RecoveryWalRecord[];
}

export interface BrewvaRuntimeInternalEventAppendPort {
  record: RuntimeRecordEvent;
  resolveLogPath(sessionId: string): string;
}

export interface BrewvaToolRuntimeInternalPort {
  recordEvent: RuntimeRecordEvent;
  onClearState(listener: (sessionId: string) => void): void;
  resolveCredentialBindings(sessionId: string, toolName: string): Record<string, string>;
  resolveSandboxApiKey(sessionId: string): string | undefined;
  appendGuardedSupplementalBlocks(
    sessionId: string,
    blocks: readonly { familyId: string; content: string }[],
    scopeId?: string,
  ): Array<{
    familyId: string;
    accepted: boolean;
    truncated?: boolean;
    finalTokens?: number;
    droppedReason?: "hard_limit" | "budget_exhausted";
  }>;
}

export function createSchedulerIngressPort(runtime: BrewvaRuntime): BrewvaSchedulerIngressPort {
  const methodGroups = requireRuntimeMethodGroups(runtime as RuntimeMethodGroupsCarrier);
  return bindMethods(methodGroups.recoveryWal, [
    "appendPending",
    "markInflight",
    "markDone",
    "markFailed",
    "markExpired",
    "listPending",
  ] as const);
}

export function createRuntimeInternalEventAppendPort(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
): BrewvaRuntimeInternalEventAppendPort {
  const methodGroups = requireRuntimeMethodGroups(runtime as RuntimeMethodGroupsCarrier);
  return bindMethods(methodGroups.events, ["record", "resolveLogPath"] as const);
}

export function resolveRuntimeEventLogPath(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
  sessionId: string,
): string {
  return createRuntimeInternalEventAppendPort(runtime).resolveLogPath(sessionId);
}

export function createToolRuntimeInternalPort(
  runtime: BrewvaRuntime,
): BrewvaToolRuntimeInternalPort {
  return {
    recordEvent: createRuntimeInternalEventAppendPort(runtime).record,
    onClearState: runtime.maintain.session.onClearState,
    resolveCredentialBindings: runtime.maintain.session.resolveCredentialBindings,
    resolveSandboxApiKey: runtime.maintain.session.resolveSandboxApiKey,
    appendGuardedSupplementalBlocks: (sessionId, blocks, scopeId) =>
      runtime.maintain.context
        .appendGuardedSupplementalBlocks(sessionId, blocks, undefined, scopeId)
        .map((result) => ({
          familyId: result.familyId,
          accepted: result.accepted,
          truncated: result.truncated,
          finalTokens: result.finalTokens,
          droppedReason: result.droppedReason,
        })),
  };
}

export function recordRuntimeEvent<TPayload extends object>(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
  input: RuntimeRecordEventInput<TPayload>,
): BrewvaEventRecord | undefined {
  return createRuntimeInternalEventAppendPort(runtime).record(input);
}
