import type { BrewvaWalId } from "../core/index.js";
import type { RecoveryWalRecord, RecoveryWalSource } from "../domain/schedule/api.js";
import type { RuntimeRecordEventInput } from "../domain/sessions/api.js";
import type { BrewvaEventRecord } from "../events/types.js";

const runtimeExtensionPortBrand = Symbol("brewva.runtime.extension-port");

export type RuntimeCapabilityToken = string & {
  readonly __brand: "RuntimeCapabilityToken";
};

export type RuntimeExtensionAuthority =
  | "channels"
  | "context"
  | "credentials"
  | "event-log"
  | "hosted"
  | "parallel"
  | "plugin"
  | "recovery"
  | "replay"
  | "semantic-artifacts";

export type ExtensionPort<
  TName extends string,
  TAuthority extends RuntimeExtensionAuthority,
  TMethods extends object,
> = Readonly<TMethods> & {
  readonly name: TName;
  readonly authority: TAuthority;
  readonly capabilities: readonly RuntimeCapabilityToken[];
  readonly [runtimeExtensionPortBrand]: TAuthority;
};

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
  "hosted",
  BrewvaHostedEventExtensionMethods
>;

export type BrewvaRecoverySchedulerExtensionPort = ExtensionPort<
  "recovery.scheduler",
  "recovery",
  BrewvaRecoverySchedulerExtensionMethods
>;

export type BrewvaToolRuntimeExtensionPort = ExtensionPort<
  "tools",
  "plugin",
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

function asCapabilityToken(value: string): RuntimeCapabilityToken {
  return value as RuntimeCapabilityToken;
}

function defineExtensionPort<
  TName extends string,
  TAuthority extends RuntimeExtensionAuthority,
  TMethods extends object,
>(input: {
  name: TName;
  authority: TAuthority;
  capabilities: readonly string[];
  methods: TMethods;
}): ExtensionPort<TName, TAuthority, TMethods> {
  return Object.seal({
    ...input.methods,
    name: input.name,
    authority: input.authority,
    capabilities: Object.freeze(input.capabilities.map(asCapabilityToken)),
    [runtimeExtensionPortBrand]: input.authority,
  }) as ExtensionPort<TName, TAuthority, TMethods>;
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
  TAuthority extends RuntimeExtensionAuthority,
  TValue extends object,
  const TMethodKeys extends readonly ExtensionMethodKey<TValue>[],
>(input: {
  name: TName;
  authority: TAuthority;
  capabilityPrefix: string;
  instance: TValue;
  methods: TMethodKeys;
}): ExtensionPort<TName, TAuthority, BoundExtensionShape<TValue, TMethodKeys>> {
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
    authority: input.authority,
    capabilities: input.methods
      .map((methodName) => String(methodName))
      .toSorted()
      .map((methodName) => `${input.capabilityPrefix}.${methodName}`),
    methods: publicShape as BoundExtensionShape<TValue, TMethodKeys>,
  });
}

export function createHostedEventExtensionPort(input: {
  record<TPayload extends object>(
    event: RuntimeRecordEventInput<TPayload>,
  ): BrewvaEventRecord | undefined;
  resolveLogPath(sessionId: string): string;
}): BrewvaHostedEventExtensionPort {
  return defineExtensionPort<"hosted.events", "hosted", BrewvaHostedEventExtensionMethods>({
    name: "hosted.events",
    authority: "hosted",
    capabilities: ["extensions.hosted.events.record", "extensions.hosted.events.resolveLogPath"],
    methods: {
      record: (event) => input.record(event),
      resolveLogPath: (sessionId) => input.resolveLogPath(sessionId),
    },
  });
}

export function createRecoverySchedulerExtensionPort(
  input: BrewvaRecoverySchedulerExtensionMethods,
): BrewvaRecoverySchedulerExtensionPort {
  return defineExtensionPort<
    "recovery.scheduler",
    "recovery",
    BrewvaRecoverySchedulerExtensionMethods
  >({
    name: "recovery.scheduler",
    authority: "recovery",
    capabilities: [
      "extensions.recovery.scheduler.appendPending",
      "extensions.recovery.scheduler.markInflight",
      "extensions.recovery.scheduler.markDone",
      "extensions.recovery.scheduler.markFailed",
      "extensions.recovery.scheduler.markExpired",
      "extensions.recovery.scheduler.listPending",
    ],
    methods: input,
  });
}

export function createToolRuntimeExtensionPort(
  input: BrewvaToolRuntimeExtensionMethods,
): BrewvaToolRuntimeExtensionPort {
  return defineExtensionPort<"tools", "plugin", BrewvaToolRuntimeExtensionMethods>({
    name: "tools",
    authority: "plugin",
    capabilities: [
      "extensions.tools.recordEvent",
      "extensions.tools.onClearState",
      "extensions.tools.resolveCredentialBindings",
    ],
    methods: input,
  });
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isExtensionPort(
  value: unknown,
): value is ExtensionPort<string, RuntimeExtensionAuthority, object> {
  return (
    isObjectRecord(value) && runtimeExtensionPortBrand in value && Array.isArray(value.capabilities)
  );
}

export function listExtensionPortCapabilities(value: unknown): string[] {
  const capabilities = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (!isObjectRecord(candidate) || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    if (isExtensionPort(candidate)) {
      for (const capability of candidate.capabilities) {
        capabilities.add(String(capability));
      }
      return;
    }
    for (const nested of Object.values(candidate)) {
      visit(nested);
    }
  };

  visit(value);
  return [...capabilities].toSorted();
}
