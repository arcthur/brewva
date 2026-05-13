import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  createHostedRuntimePort,
  createToolRuntimePort,
  createOperatorRuntimePort,
} from "@brewva/brewva-runtime";
import type {
  BrewvaAuthorityPort,
  BrewvaConfig,
  BrewvaHostedRuntimePort,
  BrewvaInspectionPort,
  RuntimeOperatorPort,
} from "@brewva/brewva-runtime";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools/contracts";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface RuntimeFixtureOptions {
  config?: BrewvaConfig;
  authority?: DeepPartial<BrewvaAuthorityPort>;
  inspect?: DeepPartial<BrewvaInspectionPort>;
  operator?: DeepPartial<RuntimeOperatorPort>;
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

export function createRuntimeFixture(options: RuntimeFixtureOptions = {}): BrewvaHostedRuntimePort {
  const runtimeConfig =
    options.config || typeof options.events?.record === "function"
      ? structuredClone(options.config ?? DEFAULT_BREWVA_CONFIG)
      : undefined;
  if (runtimeConfig && typeof options.events?.record === "function") {
    runtimeConfig.infrastructure.events.level = "debug";
  }
  const runtime = new BrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), "brewva-ext-runtime-fixture-")),
    config: runtimeConfig,
  });

  if (options.authority) {
    assignDeep(
      runtime.authority as unknown as Record<string, unknown>,
      options.authority as Record<string, unknown>,
    );
  }
  if (options.inspect) {
    assignDeep(
      runtime.inspect as unknown as Record<string, unknown>,
      options.inspect as Record<string, unknown>,
    );
  }
  if (options.operator) {
    assignDeep(
      createOperatorRuntimePort(runtime).operator as unknown as Record<string, unknown>,
      options.operator as Record<string, unknown>,
    );
  }

  if (options.context) {
    const inspectContext = runtime.inspect.context as Record<string, unknown>;
    const operatorContext = createOperatorRuntimePort(runtime).operator.context as Record<
      string,
      unknown
    >;
    const operatorLifecycle = operatorContext.lifecycle as Record<string, unknown>;
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
    const inspectEvents = runtime.inspect.events as Record<string, unknown>;
    const authorityEvents = runtime.authority.events as Record<string, unknown>;
    const rawRecord = options.events.record;
    if (typeof rawRecord === "function") {
      runtime.inspect.events.records.subscribe((event) => {
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
    const inspectTools = runtime.inspect.tools as Record<string, unknown>;
    const authorityTools = runtime.authority.tools as Record<string, unknown>;
    const operatorTools = createOperatorRuntimePort(runtime).operator.tools as Record<
      string,
      unknown
    >;
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
    const inspectSession = runtime.inspect.session as Record<string, unknown>;
    const authoritySession = runtime.authority.session as Record<string, unknown>;
    const operatorSession = createOperatorRuntimePort(runtime).operator.session as Record<
      string,
      unknown
    >;
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

  return createHostedRuntimePort(runtime);
}

export function createBundledToolRuntime(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
  extras?: Pick<BrewvaBundledToolRuntime, "delegation" | "orchestration">,
): BrewvaBundledToolRuntime {
  return {
    ...createToolRuntimePort(runtime),
    ...extras,
  };
}
