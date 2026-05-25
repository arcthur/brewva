import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedRuntimeAdapter } from "@brewva/brewva-gateway/hosted";
import type {
  HostedRuntimeAdapterOptions,
  HostedRuntimeAdapterPort,
  RuntimeAdapterCapabilitiesPort,
  RuntimeAdapterOpsPort,
  ToolRuntimeAdapterPort,
} from "@brewva/brewva-gateway/hosted";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools/contracts";
import { createManagedExecProcessRegistryRuntime } from "@brewva/brewva-tools/execution";

export type {
  HostedRuntimeAdapterOptions,
  HostedRuntimeAdapterPort,
  RuntimeAdapterCapabilitiesPort,
  RuntimeAdapterOpsPort,
  ToolRuntimeAdapterPort,
};
export type BrewvaRuntimeOptions = HostedRuntimeAdapterOptions;

export function createRuntimeInstanceFixture(
  options: HostedRuntimeAdapterOptions = {},
): HostedRuntimeAdapterPort {
  return createHostedRuntimeAdapter(options) as unknown as HostedRuntimeAdapterPort;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface RuntimeFixtureOptions {
  config?: BrewvaConfig;
  ops?: DeepPartial<RuntimeAdapterOpsPort>;
  capabilities?: DeepPartial<RuntimeAdapterCapabilitiesPort>;
  context?: Record<string, unknown>;
  events?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  session?: Record<string, unknown>;
}

export function createRuntimeConfig(mutate?: (config: BrewvaConfig) => void): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  mutate?.(config);
  return config;
}

export function createOpsRuntimeConfig(mutate?: (config: BrewvaConfig) => void): BrewvaConfig {
  return createRuntimeConfig((config) => {
    config.infrastructure.events.level = "ops";
    mutate?.(config);
  });
}

function assignDeep(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof target[key] === "object" &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      assignDeep(target[key] as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    target[key] = value;
  }
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function createRuntimeFixture(
  options: RuntimeFixtureOptions = {},
): HostedRuntimeAdapterPort {
  const runtimeConfig =
    options.config || typeof options.events?.record === "function"
      ? structuredClone(options.config ?? DEFAULT_BREWVA_CONFIG)
      : undefined;
  if (runtimeConfig && typeof options.events?.record === "function") {
    runtimeConfig.infrastructure.events.level = "debug";
  }
  const runtime = createRuntimeInstanceFixture({
    cwd: mkdtempSync(join(tmpdir(), "brewva-ext-runtime-fixture-")),
    config: runtimeConfig,
  });

  if (options.ops) {
    assignDeep(
      runtime.ops as unknown as Record<string, unknown>,
      options.ops as Record<string, unknown>,
    );
  }
  if (options.capabilities) {
    assignDeep(
      runtime.capabilities as unknown as Record<string, unknown>,
      options.capabilities as Record<string, unknown>,
    );
  }

  if (options.context) {
    const inspectContext = runtime.ops.context as Record<string, unknown>;
    const operatorContext = runtime.ops.context as Record<string, unknown>;
    const operatorLifecycle = runtime.ops.context.lifecycle as Record<string, unknown>;
    const inspectUsage = inspectContext.usage as Record<string, unknown>;
    const inspectCompaction = inspectContext.compaction as Record<string, unknown>;
    const operatorCompaction = operatorContext.compaction as Record<string, unknown>;
    assignIfDefined(operatorLifecycle, "onUserInput", options.context.onUserInput);
    assignIfDefined(inspectUsage, "get", options.context.getUsage);
    assignIfDefined(inspectUsage, "getStatus", options.context.getStatus);
    assignIfDefined(inspectCompaction, "getGateStatus", options.context.getCompactionGateStatus);
    assignIfDefined(operatorCompaction, "request", options.context.requestCompaction);
    assignIfDefined(
      operatorCompaction,
      "checkAndRequest",
      options.context.checkAndRequestCompaction,
    );
    for (const [key, value] of Object.entries(options.context)) {
      if (key in inspectContext) {
        inspectContext[key] = value;
      }
      if (key in operatorContext) {
        operatorContext[key] = value;
      }
    }
  }
  if (options.events) {
    const inspectEvents = runtime.ops.events as Record<string, unknown>;
    const authorityEvents = runtime.ops.events as Record<string, unknown>;
    const rawRecord = options.events.record;
    if (typeof rawRecord === "function") {
      runtime.ops.events.records.subscribe((event) => {
        rawRecord({
          sessionId: event.sessionId,
          type: event.type,
          turn: event.turn,
          payload: event.payload,
          timestamp: event.timestamp,
        });
      });
    }
    for (const [key, value] of Object.entries(options.events)) {
      if (key === "record") {
        continue;
      }
      if (key in inspectEvents) {
        inspectEvents[key] = value;
      }
      if (key in authorityEvents) {
        authorityEvents[key] = value;
      }
    }
  }
  if (options.tools) {
    const inspectTools = runtime.ops.tools as Record<string, unknown>;
    const authorityTools = runtime.ops.tools as Record<string, unknown>;
    const operatorTools = runtime.ops.tools as Record<string, unknown>;
    const authorityInvocation = authorityTools.invocation as Record<string, unknown>;
    const authorityParallel = authorityTools.parallel as Record<string, unknown>;
    const authorityResourceLeases = authorityTools.resourceLeases as Record<string, unknown>;
    const authorityPatches = authorityTools.patches as Record<string, unknown>;
    const inspectResourceLeases = inspectTools.resourceLeases as Record<string, unknown>;
    const operatorActionPolicies = operatorTools.actionPolicies as Record<string, unknown>;
    assignIfDefined(authorityInvocation, "start", options.tools.start);
    assignIfDefined(authorityInvocation, "finish", options.tools.finish);
    assignIfDefined(authorityInvocation, "recordResult", options.tools.recordResult);
    assignIfDefined(authorityParallel, "acquire", options.tools.acquireParallelSlot);
    assignIfDefined(authorityParallel, "acquireAsync", options.tools.acquireParallelSlotAsync);
    assignIfDefined(authorityParallel, "release", options.tools.releaseParallelSlot);
    assignIfDefined(authorityResourceLeases, "request", options.tools.requestResourceLease);
    assignIfDefined(authorityResourceLeases, "cancel", options.tools.cancelResourceLease);
    assignIfDefined(authorityPatches, "rollbackLastPatchSet", options.tools.rollbackLastPatchSet);
    assignIfDefined(authorityPatches, "redoLastPatchSet", options.tools.redoLastPatchSet);
    assignIfDefined(authorityPatches, "rollbackLastMutation", options.tools.rollbackLastMutation);
    assignIfDefined(inspectResourceLeases, "list", options.tools.listResourceLeases);
    assignIfDefined(operatorActionPolicies, "register", options.tools.registerActionPolicy);
    assignIfDefined(operatorActionPolicies, "unregister", options.tools.unregisterActionPolicy);
    for (const [key, value] of Object.entries(options.tools)) {
      if (key in inspectTools) {
        inspectTools[key] = value;
      }
      if (key in authorityTools) {
        authorityTools[key] = value;
      }
      if (key in operatorTools) {
        operatorTools[key] = value;
      }
    }
  }
  if (options.session) {
    const inspectSession = runtime.ops.session as Record<string, unknown>;
    const authoritySession = runtime.ops.session as Record<string, unknown>;
    const operatorSession = runtime.ops.session as Record<string, unknown>;
    for (const [key, value] of Object.entries(options.session)) {
      if (key in inspectSession) {
        inspectSession[key] = value;
      }
      if (key in authoritySession) {
        authoritySession[key] = value;
      }
      if (key in operatorSession) {
        operatorSession[key] = value;
      }
    }
  }

  return runtime;
}

export function createBundledToolRuntime(
  runtime: HostedRuntimeAdapterPort,
  extras?: Pick<BrewvaBundledToolRuntime, "delegation" | "orchestration">,
): BrewvaBundledToolRuntime {
  return {
    identity: runtime.identity,
    config: runtime.config,
    capabilities: runtime.capabilities,
    extensions: {
      tools: runtime.extensions.tools,
    },
    execProcessRegistry: createManagedExecProcessRegistryRuntime(),
    ...extras,
  };
}
