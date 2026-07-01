import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";

/**
 * Provider HTTP transport policy (borrowed from pi-mono's `http-dispatcher`).
 *
 * Forces HTTP/1.1 (`allowH2: false`) for OpenAI-compatible provider calls to
 * dodge the Feilian gateway's intermittent HTTP/2 RST, with an idle body/headers
 * timeout and env-proxy support. Unlike pi-mono's process-global
 * `setGlobalDispatcher`, bun's OpenAI SDK does not route through the global
 * undici dispatcher, so the policy is injected per client via `getProviderFetch`
 * and therefore covers only the OpenAI providers, not MCP/other outbound HTTP.
 */

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
  { label: "30 sec", timeoutMs: 30_000 },
  { label: "1 min", timeoutMs: 60_000 },
  { label: "2 min", timeoutMs: 120_000 },
  { label: "5 min", timeoutMs: 300_000 },
  { label: "disabled", timeoutMs: 0 },
] as const;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") {
      return 0;
    }
    if (trimmed.length === 0) {
      return undefined;
    }
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
  const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
  if (choice) {
    return choice.label;
  }
  return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
  const proxy = httpProxy?.trim();
  if (!proxy) {
    return;
  }
  process.env.HTTP_PROXY ??= proxy;
  process.env.HTTPS_PROXY ??= proxy;
}

let currentIdleTimeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS;
let currentDispatcher: Dispatcher | undefined;

function buildDispatcher(timeoutMs: number): Dispatcher {
  return new EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
}

function ensureDispatcher(): Dispatcher {
  currentDispatcher ??= buildDispatcher(currentIdleTimeoutMs);
  return currentDispatcher;
}

function closeDispatcherQuietly(dispatcher: Dispatcher): void {
  // bun's builtin undici Dispatcher lacks close()/destroy(); only call it where
  // present (Node's undici) and let bun's runtime reclaim the old agent otherwise.
  const closable = dispatcher as { close?: () => Promise<unknown> };
  if (typeof closable.close === "function") {
    void closable.close().catch(() => {});
  }
}

/**
 * Idempotent, re-callable at startup and on settings changes. Rebuilds the
 * shared dispatcher and gracefully closes the previous one.
 */
export function configureProviderTransport(
  options: { idleTimeoutMs?: number; httpProxy?: string } = {},
): void {
  if (options.httpProxy !== undefined) {
    applyHttpProxySettings(options.httpProxy);
  }
  if (options.idleTimeoutMs !== undefined) {
    const normalized = parseHttpIdleTimeoutMs(options.idleTimeoutMs);
    if (normalized === undefined) {
      throw new Error(`Invalid HTTP idle timeout: ${String(options.idleTimeoutMs)}`);
    }
    currentIdleTimeoutMs = normalized;
  }
  const previous = currentDispatcher;
  currentDispatcher = buildDispatcher(currentIdleTimeoutMs);
  if (previous) {
    closeDispatcherQuietly(previous);
  }
}

/**
 * A `fetch` to inject into the OpenAI SDK. Reads the current dispatcher on every
 * call, so a later `configureProviderTransport` takes effect immediately.
 */
export function getProviderFetch(): typeof fetch {
  const providerFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...init,
        dispatcher: ensureDispatcher(),
      } as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
  return providerFetch as typeof fetch;
}
