import type {
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  Transport,
} from "@brewva/brewva-provider-core/contracts";

export interface ProviderCacheStickyLatchState {
  providerCacheRetained: boolean;
  providerCacheEdit: boolean;
  lowLatencyTransport: boolean;
  reasoningTransport: boolean;
  channelCapability: boolean;
}

export interface ProviderCacheStickyLatchInput {
  cachePolicy?: ProviderCachePolicy;
  cacheRender?: ProviderCacheRenderResult;
  transport?: Transport;
  reasoning?: unknown;
  channelContext?: unknown;
}

export class ProviderCacheStickyLatches {
  #state: ProviderCacheStickyLatchState = createEmptyProviderCacheStickyLatchState();

  observe(input: ProviderCacheStickyLatchInput): ProviderCacheStickyLatchState {
    this.#state = {
      providerCacheRetained:
        this.#state.providerCacheRetained ||
        (input.cachePolicy !== undefined && input.cachePolicy.retention !== "none") ||
        (input.cacheRender !== undefined && input.cacheRender.renderedRetention !== "none"),
      providerCacheEdit:
        this.#state.providerCacheEdit || (input.cacheRender?.reason ?? "").includes("edit"),
      lowLatencyTransport: this.#state.lowLatencyTransport || input.transport === "websocket",
      reasoningTransport: this.#state.reasoningTransport || hasReasoning(input.reasoning),
      channelCapability: this.#state.channelCapability || hasChannelContext(input.channelContext),
    };
    return this.snapshot();
  }

  snapshot(): ProviderCacheStickyLatchState {
    return { ...this.#state };
  }

  clear(): void {
    this.#state = createEmptyProviderCacheStickyLatchState();
  }
}

export function createEmptyProviderCacheStickyLatchState(): ProviderCacheStickyLatchState {
  return {
    providerCacheRetained: false,
    providerCacheEdit: false,
    lowLatencyTransport: false,
    reasoningTransport: false,
    channelCapability: false,
  };
}

function hasReasoning(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0 && value !== "off";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(hasReasoning);
  }
  return value !== undefined && value !== null && value !== false;
}

function hasChannelContext(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return false;
}
