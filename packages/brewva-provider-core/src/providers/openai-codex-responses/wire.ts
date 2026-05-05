import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { isRecord, readObject, readString } from "../../utils/unknown-object.js";

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> },
) => {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
};

export function readWebSocketConstructor(): WebSocketConstructor | null {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  // Runtime WebSocket implementations expose compatible constructors without a shared SDK type.
  return typeof ctor === "function" ? (ctor as unknown as WebSocketConstructor) : null;
}

export function asCodexResponseStreamEvent(event: Record<string, unknown>): ResponseStreamEvent {
  // Codex websocket events are provider wire payloads narrowed after the record decoder boundary.
  return event as unknown as ResponseStreamEvent;
}

export function readCodexErrorMessage(event: Record<string, unknown>): string | undefined {
  return readString(event, "message");
}

export function readCodexErrorCode(event: Record<string, unknown>): string | undefined {
  return readString(event, "code");
}

export function readCodexFailedMessage(event: Record<string, unknown>): string | undefined {
  const response = readObject(event, "response");
  const error = readObject(response, "error");
  return readString(error, "message");
}

export function readCodexResponseObject(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const response = readObject(event, "response");
  return isRecord(response) ? response : undefined;
}
