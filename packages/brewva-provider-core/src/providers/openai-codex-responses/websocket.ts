import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type {
  AssistantMessage,
  ProviderEventSink,
  Model,
  ProviderStreamError,
  ProviderSessionResources,
} from "../../contracts/index.js";
import { providerTryPromise } from "../../stream/effect-interop.js";
import type { IncrementalToolCallFolder } from "../../stream/tool-call-folder.js";
import { processResponsesStream } from "../openai-responses/stream-events.js";
import {
  clearCodexContinuationState,
  codexSessionGenerationMatches,
  getCodexContinuationSessionCount,
  readCodexContinuationState,
  readCodexSessionGeneration,
  rememberCodexContinuationState,
} from "./continuation-state.js";
import type { OpenAICodexResponsesOptions, RequestBody } from "./contract.js";
import { buildCodexContinuationRequest } from "./request.js";
import { trackCodexResponse, type CodexResponseTracker } from "./response-tracker.js";
import { mapCodexEvents } from "./sse.js";
import { readWebSocketConstructor } from "./wire.js";

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

interface CachedWebSocketConnection {
  socket: WebSocketLike;
  busy: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const codexWebSocketFallbackSessions = new Set<string>();

export function clearCodexSessionState(sessionId: string): void {
  clearCodexContinuationState(sessionId);
  codexWebSocketFallbackSessions.delete(sessionId);
  const cached = websocketSessionCache.get(sessionId);
  if (!cached) {
    return;
  }
  if (cached.idleTimer) {
    clearTimeout(cached.idleTimer);
  }
  closeWebSocketSilently(cached.socket, 1000, "session_clear");
  websocketSessionCache.delete(sessionId);
}

export function recordCodexWebSocketFallback(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  codexWebSocketFallbackSessions.add(sessionId);
}

export function isCodexWebSocketFallbackActive(sessionId: string | undefined): boolean {
  return !!sessionId && codexWebSocketFallbackSessions.has(sessionId);
}

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

function getWebSocketConstructor(): WebSocketConstructor | null {
  return readWebSocketConstructor();
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
  const readyState = (socket as { readyState?: unknown }).readyState;
  return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
  const readyState = getWebSocketReadyState(socket);
  return readyState === undefined || readyState === 1;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
  try {
    socket.close(code, reason);
  } catch {}
}

function normalizeConnectTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) {
    return DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
  }
  if (!Number.isFinite(value)) {
    return DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
  }
  const normalized = Math.max(0, Math.trunc(value));
  return normalized > 0 ? normalized : undefined;
}

function scheduleSessionWebSocketExpiry(sessionId: string, entry: CachedWebSocketConnection): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
    websocketSessionCache.delete(sessionId);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
  entry.idleTimer.unref?.();
}

async function connectWebSocket(
  url: string,
  headers: Headers,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<WebSocketLike> {
  const WebSocketCtor = getWebSocketConstructor();
  if (!WebSocketCtor) {
    throw new Error("WebSocket transport is not available in this runtime");
  }

  const wsHeaders = headersToRecord(headers);
  delete wsHeaders["OpenAI-Beta"];
  delete wsHeaders["openai-beta"];

  return new Promise<WebSocketLike>((resolve, reject) => {
    let settled = false;
    let socket: WebSocketLike;
    const connectTimeoutMs = normalizeConnectTimeoutMs(timeoutMs);
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      socket = new WebSocketCtor(url, { headers: wsHeaders });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const onOpen: WebSocketListener = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError: WebSocketListener = (event) => {
      const error = extractWebSocketError(event);
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onClose: WebSocketListener = (event) => {
      const error = extractWebSocketCloseError(event);
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close(1000, "aborted");
      reject(new Error("Request was aborted"));
    };
    const onConnectTimeout = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close(1000, "connect_timeout");
      reject(new Error(`Codex websocket connection timed out after ${connectTimeoutMs} ms`));
    };

    const cleanup = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
      }
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
    if (connectTimeoutMs !== undefined) {
      connectTimer = setTimeout(onConnectTimeout, connectTimeoutMs);
      connectTimer.unref?.();
    }
  });
}

async function acquireWebSocket(
  url: string,
  headers: Headers,
  sessionId: string | undefined,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<{ socket: WebSocketLike; release: (options?: { keep?: boolean }) => void }> {
  if (!sessionId) {
    const socket = await connectWebSocket(url, headers, signal, timeoutMs);
    return {
      socket,
      release: () => {
        closeWebSocketSilently(socket);
      },
    };
  }

  const cached = websocketSessionCache.get(sessionId);
  if (cached) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = undefined;
    }
    if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        release: ({ keep } = {}) => {
          if (!keep || !isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            websocketSessionCache.delete(sessionId);
            return;
          }
          cached.busy = false;
          scheduleSessionWebSocketExpiry(sessionId, cached);
        },
      };
    }
    if (cached.busy) {
      const socket = await connectWebSocket(url, headers, signal, timeoutMs);
      return {
        socket,
        release: () => {
          closeWebSocketSilently(socket);
        },
      };
    }
    if (!isWebSocketReusable(cached.socket)) {
      closeWebSocketSilently(cached.socket);
      websocketSessionCache.delete(sessionId);
    }
  }

  const socket = await connectWebSocket(url, headers, signal, timeoutMs);
  const entry: CachedWebSocketConnection = { socket, busy: true };
  websocketSessionCache.set(sessionId, entry);
  return {
    socket,
    release: ({ keep } = {}) => {
      if (!keep || !isWebSocketReusable(entry.socket)) {
        closeWebSocketSilently(entry.socket);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (websocketSessionCache.get(sessionId) === entry) {
          websocketSessionCache.delete(sessionId);
        }
        return;
      }
      entry.busy = false;
      scheduleSessionWebSocketExpiry(sessionId, entry);
    },
  };
}

function extractWebSocketError(event: unknown): Error {
  if (event && typeof event === "object" && "message" in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return new Error(message);
    }
  }
  return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
  if (event && typeof event === "object") {
    const code = "code" in event ? (event as { code?: unknown }).code : undefined;
    const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
    const codeText = typeof code === "number" ? ` ${code}` : "";
    const reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
    return new Error(`WebSocket closed${codeText}${reasonText}`.trim());
  }
  return new Error("WebSocket closed");
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (data && typeof data === "object" && "arrayBuffer" in data) {
    const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
    const arrayBuffer = await blobLike.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return null;
}

async function* parseWebSocket(
  socket: WebSocketLike,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let failed: Error | null = null;
  let sawCompletion = false;

  const wake = () => {
    if (!pending) return;
    const resolve = pending;
    pending = null;
    resolve();
  };

  const onMessage: WebSocketListener = (event) => {
    void (async () => {
      if (!event || typeof event !== "object" || !("data" in event)) return;
      const text = await decodeWebSocketData((event as { data?: unknown }).data);
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (
          type === "response.completed" ||
          type === "response.done" ||
          type === "response.incomplete"
        ) {
          sawCompletion = true;
          done = true;
        }
        queue.push(parsed);
        wake();
      } catch {}
    })();
  };

  const onError: WebSocketListener = (event) => {
    failed = extractWebSocketError(event);
    done = true;
    wake();
  };

  const onClose: WebSocketListener = (event) => {
    if (sawCompletion) {
      done = true;
      wake();
      return;
    }
    if (!failed) {
      failed = extractWebSocketCloseError(event);
    }
    done = true;
    wake();
  };

  const onAbort = () => {
    failed = new Error("Request was aborted");
    done = true;
    wake();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        pending = resolve;
      });
    }

    if (failed) {
      throw failed;
    }
    if (!sawCompletion) {
      throw new Error("WebSocket stream closed before response.completed");
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

function cloneProtocolPayload<T>(value: T): T {
  return structuredClone(value);
}

export function processWebSocketStream(
  url: string,
  body: RequestBody,
  headers: Headers,
  output: AssistantMessage,
  stream: ProviderEventSink,
  model: Model<"openai-codex-responses">,
  toolCalls: IncrementalToolCallFolder,
  onStart: () => void,
  options?: OpenAICodexResponsesOptions,
): BrewvaEffect.Effect<void, ProviderStreamError> {
  return BrewvaEffect.gen(function* () {
    const { socket, release } = yield* providerTryPromise(() =>
      acquireWebSocket(
        url,
        headers,
        options?.sessionId,
        options?.signal,
        options?.websocketConnectTimeoutMs,
      ),
    );
    let keepConnection = true;
    const sessionGeneration = options?.sessionId
      ? readCodexSessionGeneration(options.sessionId)
      : undefined;
    const continuation = options?.sessionId
      ? readCodexContinuationState(options.sessionId, model)
      : undefined;
    const outboundBody = buildCodexContinuationRequest(
      body,
      continuation,
      options?.previousResponseId,
    );
    const tracker: CodexResponseTracker = { outputItems: [] };

    yield* BrewvaEffect.gen(function* () {
      socket.send(JSON.stringify({ type: "response.create", ...outboundBody }));
      onStart();
      yield* processResponsesStream(
        mapCodexEvents(trackCodexResponse(parseWebSocket(socket, options?.signal), tracker)),
        output,
        stream,
        model,
        toolCalls,
      );
      const responseId = tracker.responseId ?? output.responseId;
      if (
        options?.sessionId &&
        responseId &&
        sessionGeneration !== undefined &&
        codexSessionGenerationMatches(options.sessionId, sessionGeneration)
      ) {
        rememberCodexContinuationState(options.sessionId, {
          model: model.id,
          previousRequest: cloneProtocolPayload(body),
          lastResponse: {
            responseId,
            outputItems: cloneProtocolPayload(tracker.outputItems),
          },
        });
      }
      if (options?.signal?.aborted) {
        keepConnection = false;
      }
    }).pipe(
      BrewvaEffect.catch((error) => {
        keepConnection = false;
        return BrewvaEffect.fail(error);
      }),
      BrewvaEffect.ensuring(
        providerTryPromise(async () => {
          release({ keep: keepConnection });
        }).pipe(BrewvaEffect.catch(() => BrewvaEffect.void)),
      ),
    );
  });
}

export const sessionResources: ProviderSessionResources = {
  clearSession(sessionId) {
    clearCodexSessionState(sessionId);
  },
};

export function rememberCachedWebSocketConnection(sessionId: string, socket: WebSocketLike): void {
  websocketSessionCache.set(sessionId, { socket, busy: false });
}

export function getCodexSessionCacheState(): {
  websocketSessionCount: number;
  continuationSessionCount: number;
  websocketFallbackSessionCount: number;
} {
  return {
    websocketSessionCount: websocketSessionCache.size,
    continuationSessionCount: getCodexContinuationSessionCount(),
    websocketFallbackSessionCount: codexWebSocketFallbackSessions.size,
  };
}
