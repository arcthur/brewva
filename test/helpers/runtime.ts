import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  createToolRuntimePort,
  type BrewvaAuthorityPort,
  type BrewvaConfig,
  type BrewvaInspectionPort,
  type BrewvaMaintenancePort,
} from "@brewva/brewva-runtime";
import { createToolRuntimeInternalPort } from "@brewva/brewva-runtime/internal";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools";

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
  maintain?: DeepPartial<BrewvaMaintenancePort>;
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

export function createRuntimeFixture(options: RuntimeFixtureOptions = {}): BrewvaRuntime {
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
  if (options.maintain) {
    assignDeep(
      runtime.maintain as unknown as Record<string, unknown>,
      options.maintain as Record<string, unknown>,
    );
  }

  if (options.context) {
    const inspectContext = runtime.inspect.context as Record<string, unknown>;
    const maintainContext = runtime.maintain.context as Record<string, unknown>;
    for (const [key, value] of Object.entries(options.context)) {
      if (key in inspectContext) {
        inspectContext[key] = value;
      }
      if (key in maintainContext) {
        maintainContext[key] = value;
      }
    }
  }
  if (options.events) {
    const inspectEvents = runtime.inspect.events as Record<string, unknown>;
    const authorityEvents = runtime.authority.events as Record<string, unknown>;
    const rawRecord = options.events.record;
    if (typeof rawRecord === "function") {
      runtime.inspect.events.subscribe((event) => {
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
    const maintainTools = runtime.maintain.tools as Record<string, unknown>;
    for (const [key, value] of Object.entries(options.tools)) {
      if (key in inspectTools) {
        inspectTools[key] = value;
      }
      if (key in authorityTools) {
        authorityTools[key] = value;
      }
      if (key in maintainTools) {
        maintainTools[key] = value;
      }
    }
  }
  if (options.session) {
    const inspectSession = runtime.inspect.session as Record<string, unknown>;
    const authoritySession = runtime.authority.session as Record<string, unknown>;
    const maintainSession = runtime.maintain.session as Record<string, unknown>;
    for (const [key, value] of Object.entries(options.session)) {
      if (key in inspectSession) {
        inspectSession[key] = value;
      }
      if (key in authoritySession) {
        authoritySession[key] = value;
      }
      if (key in maintainSession) {
        maintainSession[key] = value;
      }
    }
  }

  return runtime;
}

export function createBundledToolRuntime(
  runtime: BrewvaRuntime,
  extras?: Pick<BrewvaBundledToolRuntime, "delegation" | "orchestration" | "semanticReranker">,
): BrewvaBundledToolRuntime {
  return {
    ...createToolRuntimePort(runtime),
    internal: createToolRuntimeInternalPort(runtime),
    ...extras,
  };
}
