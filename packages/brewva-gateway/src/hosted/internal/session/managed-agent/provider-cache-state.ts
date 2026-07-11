import { join, resolve } from "node:path";
import {
  buildProviderCacheBucketKey,
  resolveProviderCacheCapability,
} from "@brewva/brewva-provider-core/cache";
import type {
  Api,
  ProviderCachePolicy,
  ProviderPayloadMetadata,
} from "@brewva/brewva-provider-core/contracts";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type { BrewvaAgentProtocolTransport } from "@brewva/brewva-substrate/agent-protocol";
import type { ProviderCacheRenderState } from "@brewva/brewva-vocabulary/context";
import { ProviderCacheStickyLatches } from "../../provider/cache/index.js";
import type { HostedSessionLogger } from "../../shared/logger.js";

export interface ProviderCacheModelIdentity {
  provider: string;
  api: Api;
  id: string;
  baseUrl?: string;
}

export interface ManagedSessionProviderCacheStateOptions {
  getSessionId: () => string;
  clearToolSchemaSnapshot: (reason: string) => void;
  clearProviderSessions: (sessionId: string) => Promise<void>;
  logger?: HostedSessionLogger;
}

export class ManagedSessionProviderCacheState {
  readonly #providerCacheStickyLatches = new ProviderCacheStickyLatches();
  #providerCacheSessionClear: Promise<void> | null = null;
  #getSessionId: () => string;
  #clearToolSchemaSnapshot: (reason: string) => void;
  #clearProviderSessions: (sessionId: string) => Promise<void>;
  #logger?: HostedSessionLogger;

  constructor(options: ManagedSessionProviderCacheStateOptions) {
    this.#getSessionId = options.getSessionId;
    this.#clearToolSchemaSnapshot = options.clearToolSchemaSnapshot;
    this.#clearProviderSessions = options.clearProviderSessions;
    this.#logger = options.logger;
  }

  observeStickyLatches(input: Parameters<ProviderCacheStickyLatches["observe"]>[0]) {
    return this.#providerCacheStickyLatches.observe(input);
  }

  async waitForSessionClear(): Promise<void> {
    await this.#providerCacheSessionClear;
  }

  clearSessionState(): Promise<void> {
    this.#clearToolSchemaSnapshot("session_clear");
    this.#providerCacheStickyLatches.clear();
    const clear = this.#clearProviderSessions(this.#getSessionId());
    this.#providerCacheSessionClear = clear;
    void clear
      .finally(() => {
        if (this.#providerCacheSessionClear === clear) {
          this.#providerCacheSessionClear = null;
        }
      })
      .catch(() => undefined);
    return clear;
  }

  clearSessionStateBestEffort(): void {
    void this.clearSessionState().catch((error) => {
      this.#logger?.warn("provider cache session clear failed", {
        sessionId: this.#getSessionId(),
        error: toErrorMessage(error),
      });
    });
  }

  async markSessionCompacted(): Promise<void> {
    await this.clearSessionState();
  }
}

export function resolveProviderCacheDiagnosticDumpDirectory(cwd: string): string | undefined {
  const explicit =
    process.env.BREWVA_CACHE_BREAK_DUMP_DIR?.trim() ||
    process.env.BREWVA_PROVIDER_CACHE_DEBUG_DIR?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  return process.env.BREWVA_PROVIDER_CACHE_DEBUG_DUMP === "1"
    ? join(cwd, ".brewva", "diagnostics", "provider-cache")
    : undefined;
}

export function buildProviderCacheModelKey(model: ProviderCacheModelIdentity): string {
  return `${model.provider}\0${model.api}\0${model.id}`;
}

export function buildUnsupportedProviderCacheRender(input: {
  model: ProviderCacheModelIdentity;
  transport: BrewvaAgentProtocolTransport;
  sessionId: string;
  cachePolicy: ProviderCachePolicy;
}): ProviderCacheRenderState {
  const capability = resolveProviderCacheCapability({
    api: input.model.api,
    provider: input.model.provider,
    modelId: input.model.id,
    baseUrl: input.model.baseUrl,
    transport: input.transport,
  });
  const observableWithoutRenderedPolicy = capability.cacheCounters !== "none";
  return {
    status:
      input.cachePolicy.retention === "none"
        ? "disabled"
        : observableWithoutRenderedPolicy
          ? "degraded"
          : "unsupported",
    reason:
      input.cachePolicy.retention === "none"
        ? "cache_policy_disabled"
        : observableWithoutRenderedPolicy
          ? capability.reason
          : "provider_cache_observability_unavailable",
    renderedRetention: "none",
    bucketKey: buildProviderCacheBucketKey({
      provider: input.model.provider,
      api: input.model.api,
      model: input.model.id,
      sessionId: input.sessionId,
      policy: input.cachePolicy,
    }),
    capability,
  };
}

export function normalizeProviderCacheRender(input: {
  metadata?: ProviderPayloadMetadata;
  model: ProviderCacheModelIdentity;
  transport: BrewvaAgentProtocolTransport;
  sessionId: string;
  cachePolicy: ProviderCachePolicy;
  previousRender?: ProviderCacheRenderState;
  previousRenderModelKey?: string;
}): ProviderCacheRenderState {
  const metadataRender = input.metadata?.cacheRender;
  if (metadataRender) {
    return {
      status: metadataRender.status,
      reason: metadataRender.reason,
      renderedRetention: metadataRender.renderedRetention,
      bucketKey: metadataRender.bucketKey,
      capability: metadataRender.capability ?? input.metadata?.cacheCapability,
      cachedContentName: metadataRender.cachedContentName,
      cachedContentTtlSeconds: metadataRender.cachedContentTtlSeconds,
    };
  }
  if (
    input.previousRenderModelKey === buildProviderCacheModelKey(input.model) &&
    input.previousRender
  ) {
    return input.previousRender;
  }
  return buildUnsupportedProviderCacheRender(input);
}

export function providerCacheCountersAvailable(render: ProviderCacheRenderState): boolean {
  if (render.capability?.cacheCounters === "none") {
    return false;
  }
  return render.status === "rendered" || render.status === "degraded";
}
