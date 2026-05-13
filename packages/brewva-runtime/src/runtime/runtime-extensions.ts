import type { BrewvaWalId } from "../core/index.js";
import type { RecoveryWalRecord, RecoveryWalSource } from "../domain/schedule/api.js";
import type { RuntimeRecordEventInput } from "../domain/sessions/api.js";
import type { BrewvaEventRecord } from "../events/types.js";

export type ExtensionPort<TName extends string, TMethods extends object> = Readonly<TMethods> & {
  readonly name: TName;
};

export const RUNTIME_EXTENSION_OWNER_IDS = Object.freeze([
  "runtime.extension.hosted.events",
  "runtime.extension.recovery.scheduler",
  "runtime.extension.tools",
] as const);

export function listRuntimeExtensionOwnerIds(): string[] {
  return [...RUNTIME_EXTENSION_OWNER_IDS];
}

export interface BrewvaHostedEventExtensionMethods {
  record<TPayload extends object>(
    input: RuntimeRecordEventInput<TPayload>,
  ): BrewvaEventRecord | undefined;
  resolveLogPath(sessionId: string): string;
}

export interface BrewvaRecoverySchedulerExtensionMethods {
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

export interface BrewvaToolRuntimeExtensionMethods {
  recordEvent<TPayload extends object>(
    input: RuntimeRecordEventInput<TPayload>,
  ): BrewvaEventRecord | undefined;
  onClearState(listener: (sessionId: string) => void): void;
  resolveCredentialBindings(sessionId: string, toolName: string): Record<string, string>;
}

export type BrewvaHostedEventExtensionPort = ExtensionPort<
  "hosted.events",
  BrewvaHostedEventExtensionMethods
>;

export type BrewvaRecoverySchedulerExtensionPort = ExtensionPort<
  "recovery.scheduler",
  BrewvaRecoverySchedulerExtensionMethods
>;

export type BrewvaToolRuntimeExtensionPort = ExtensionPort<
  "tools",
  BrewvaToolRuntimeExtensionMethods
>;

export interface BrewvaToolRuntimeExtensions {
  readonly tools: BrewvaToolRuntimeExtensionPort;
}

export interface BrewvaRuntimeExtensions {
  readonly hosted: {
    readonly events: BrewvaHostedEventExtensionPort;
  };
  readonly recovery: {
    readonly scheduler: BrewvaRecoverySchedulerExtensionPort;
  };
  readonly tools: BrewvaToolRuntimeExtensionPort;
}

function defineExtensionPort<TName extends string, TMethods extends object>(input: {
  name: TName;
  methods: TMethods;
}): ExtensionPort<TName, TMethods> {
  return Object.seal({
    ...input.methods,
    name: input.name,
  }) as ExtensionPort<TName, TMethods>;
}

type ExtensionMethodKey<TValue extends object> = {
  readonly [TKey in keyof TValue]: TValue[TKey] extends (...args: never[]) => unknown
    ? TKey
    : never;
}[keyof TValue];

type BoundExtensionShape<
  TValue extends object,
  TMethodKeys extends readonly ExtensionMethodKey<TValue>[],
> = Pick<TValue, TMethodKeys[number]>;

export function createBoundExtensionPort<
  TName extends string,
  TValue extends object,
  const TMethodKeys extends readonly ExtensionMethodKey<TValue>[],
>(input: {
  name: TName;
  instance: TValue;
  methods: TMethodKeys;
}): ExtensionPort<TName, BoundExtensionShape<TValue, TMethodKeys>> {
  const publicShape: Record<string, unknown> = {};
  for (const key of input.methods) {
    const value = input.instance[key];
    if (typeof value !== "function") {
      throw new Error(`Expected extension method at key ${String(key)}`);
    }
    publicShape[String(key)] = value.bind(input.instance);
  }
  return defineExtensionPort({
    name: input.name,
    methods: publicShape as BoundExtensionShape<TValue, TMethodKeys>,
  });
}

export function createHostedEventExtensionPort(input: {
  record<TPayload extends object>(
    event: RuntimeRecordEventInput<TPayload>,
  ): BrewvaEventRecord | undefined;
  resolveLogPath(sessionId: string): string;
}): BrewvaHostedEventExtensionPort {
  return defineExtensionPort<"hosted.events", BrewvaHostedEventExtensionMethods>({
    name: "hosted.events",
    methods: {
      record: (event) => input.record(event),
      resolveLogPath: (sessionId) => input.resolveLogPath(sessionId),
    },
  });
}

export function createRecoverySchedulerExtensionPort(
  input: BrewvaRecoverySchedulerExtensionMethods,
): BrewvaRecoverySchedulerExtensionPort {
  return defineExtensionPort<"recovery.scheduler", BrewvaRecoverySchedulerExtensionMethods>({
    name: "recovery.scheduler",
    methods: input,
  });
}

export function createToolRuntimeExtensionPort(
  input: BrewvaToolRuntimeExtensionMethods,
): BrewvaToolRuntimeExtensionPort {
  return defineExtensionPort<"tools", BrewvaToolRuntimeExtensionMethods>({
    name: "tools",
    methods: input,
  });
}
