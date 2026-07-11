import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { compactWhitespace, readNonEmptyString } from "@brewva/brewva-std/text";
import { readFiniteNumberValue } from "@brewva/brewva-std/unknown";

export const OAUTH_HTTP_TIMEOUT_MS = 30_000;
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;
export const OAUTH_DEVICE_FLOW_TIMEOUT_MS = 10 * 60 * 1000;

export interface OAuthTokenResponse {
  idToken?: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

export function readString(value: unknown): string | undefined {
  return readNonEmptyString(value);
}

export function readFiniteNumber(value: unknown): number | undefined {
  return readFiniteNumberValue(value);
}

export function generateOAuthState(): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}

export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

export async function fetchOAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OAUTH_HTTP_TIMEOUT_MS);
  unrefTimer(timeout);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error instanceof DOMException ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: unknown }).name === "AbortError")
    ) {
      throw new Error(`OAuth request timed out after ${OAUTH_HTTP_TIMEOUT_MS / 1000}s.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function truncateOAuthErrorBody(body: string): string {
  const compact = compactWhitespace(body);
  if (compact.length <= 500) {
    return compact;
  }
  return `${compact.slice(0, 497)}...`;
}

export async function formatOAuthHttpError(response: Response, prefix: string): Promise<string> {
  const body = await response.text().catch(() => "");
  const detail = truncateOAuthErrorBody(body);
  return detail.length > 0
    ? `${prefix}: ${response.status} ${detail}`
    : `${prefix}: ${response.status}`;
}

export const HTML_SUCCESS = `<!doctype html>
<html><head><title>Brewva Authorization Successful</title></head>
<body><h1>Authorization Successful</h1><p>You can close this window and return to Brewva.</p>
<script>setTimeout(() => window.close(), 2000)</script></body></html>`;

export function htmlError(error: string): string {
  const escapedError = escapeHtml(error);
  return `<!doctype html><html><head><title>Brewva Authorization Failed</title></head>
<body><h1>Authorization Failed</h1><p>${escapedError}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function isAddressInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

function oauthServerPort(server: Server): number | undefined {
  const address = server.address();
  return typeof address === "object" && typeof address?.port === "number"
    ? address.port
    : undefined;
}

export async function listenOAuthServer(input: {
  server: Server;
  port: number;
  host: string;
  missingPortMessage: string;
}): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      input.server.removeListener("error", onError);
      input.server.removeListener("listening", onListening);
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const actualPort = oauthServerPort(input.server);
      if (actualPort === undefined) {
        reject(new Error(input.missingPortMessage));
        return;
      }
      resolve(actualPort);
    };
    input.server.once("error", onError);
    input.server.once("listening", onListening);
    input.server.listen(input.port, input.host);
  });
}

export function closeOAuthServer(server: Server): void {
  try {
    server.close();
  } catch {}
}
