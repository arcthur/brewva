import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createCredentialVaultServiceFromSecurityConfig } from "@brewva/brewva-runtime/credentials";
import type { CredentialVaultService } from "@brewva/brewva-runtime/credentials";
import type {
  BrewvaModelCatalog,
  BrewvaRegisteredModel,
  BrewvaSessionModelCatalogView,
} from "@brewva/brewva-substrate";
import {
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_PROVIDER,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_TOKEN_URL,
  hasGoogleOAuthClientConfig,
  loadGeminiCliOAuthCredential,
  parseGoogleOAuthTokenResponse,
  resolveGoogleOAuthClientConfig,
  resolveGeminiCliOAuthCredentialPath,
  resolveGoogleProjectId,
  toGoogleHostedOAuthCredential,
} from "./google-oauth.js";
import type { HostedAuthCredential } from "./hosted-auth-store.js";

export type ProviderConnectionGroup = "popular" | "other";
export type ProviderConnectionSource = "oauth" | "vault" | "provider_config" | "none";

export interface ProviderConnection {
  id: string;
  name: string;
  description?: string;
  modelProviders?: string[];
  group: ProviderConnectionGroup;
  connected: boolean;
  connectionSource: ProviderConnectionSource;
  modelCount: number;
  availableModelCount: number;
  credentialRef: string;
}

export interface ProviderAuthPromptCondition {
  key: string;
  op: "eq" | "neq";
  value: string;
}

export interface ProviderAuthTextPrompt {
  type: "text";
  key: string;
  message: string;
  placeholder?: string;
  masked?: boolean;
  when?: ProviderAuthPromptCondition;
}

export interface ProviderAuthSelectPrompt {
  type: "select";
  key: string;
  message: string;
  options: Array<{
    label: string;
    value: string;
    hint?: string;
  }>;
  when?: ProviderAuthPromptCondition;
}

export type ProviderAuthPrompt = ProviderAuthTextPrompt | ProviderAuthSelectPrompt;

export interface ProviderApiKeyAuthMethod {
  id: string;
  kind: "api_key";
  type: "api";
  label: string;
  detail?: string;
  credentialRef: string;
  credentialProvider?: string;
  modelProviderFilter?: string;
  prompts?: ProviderAuthPrompt[];
}

export interface ProviderOAuthAuthMethod {
  id: string;
  kind: "oauth";
  type: "oauth";
  label: string;
  detail?: string;
  credentialProvider?: string;
  modelProviderFilter?: string;
  prompts?: ProviderAuthPrompt[];
}

export type ProviderAuthMethod = ProviderApiKeyAuthMethod | ProviderOAuthAuthMethod;

export interface ProviderOAuthAuthorization {
  url: string;
  method: "auto" | "code";
  instructions: string;
  copyText?: string;
  openBrowser?: boolean;
  manualCode?: {
    prompt: string;
  };
}

export interface ProviderOAuthCompletion extends ProviderOAuthAuthorization {
  complete(code?: string): Promise<HostedAuthCredential>;
}

export interface ProviderAuthHandler {
  provider: string;
  listAuthMethods(): readonly ProviderOAuthAuthMethod[];
  authorizeOAuth(
    methodId: string,
    inputs?: Record<string, string>,
  ): Promise<ProviderOAuthCompletion | undefined>;
}

export interface ProviderConnectionPort {
  listProviders(): Promise<ProviderConnection[]>;
  listAuthMethods(provider: string): ProviderAuthMethod[];
  connectApiKey(provider: string, key: string, inputs?: Record<string, string>): Promise<void>;
  authorizeOAuth(
    provider: string,
    methodId: string,
    inputs?: Record<string, string>,
  ): Promise<ProviderOAuthAuthorization | undefined>;
  completeOAuth(provider: string, methodId: string, code?: string): Promise<void>;
  disconnect(provider: string): Promise<void>;
  refresh(): Promise<void>;
}

type ProviderConnectionModelCatalog = Pick<BrewvaSessionModelCatalogView, "getAll"> &
  Partial<Pick<BrewvaSessionModelCatalogView, "getAvailable">> &
  Partial<Pick<BrewvaModelCatalog, "hasConfiguredAuth">> & {
    refresh?: () => void;
  };

type ProviderConnectionAuthStore = {
  get?(provider: string): HostedAuthCredential | undefined;
  set?(provider: string, credential: HostedAuthCredential): void;
  remove?(provider: string): void;
  setFallbackResolver?: (resolver: (provider: string) => string | undefined) => void;
};

const POPULAR_PROVIDER_ORDER = [
  "openai",
  "openai-codex",
  "anthropic",
  "github-copilot",
  "google",
  "deepseek",
  "kimi-coding",
  "openrouter",
] as const;

const TOKEN_PROVIDERS = new Set(["github-copilot"]);
const API_KEY_UNSUPPORTED_PROVIDERS = new Set<string>(["google"]);
const OPENAI_PROVIDER = "openai";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const GOOGLE_PROVIDER = GOOGLE_OAUTH_PROVIDER;
const KIMI_PROVIDER = "kimi-coding";
const KIMI_CODE_PROVIDER = "kimi-coding";
const MOONSHOT_CN_PROVIDER = "moonshot-cn";
const MOONSHOT_AI_PROVIDER = "moonshot-ai";
const KIMI_COVERED_PROVIDERS = [
  KIMI_CODE_PROVIDER,
  MOONSHOT_CN_PROVIDER,
  MOONSHOT_AI_PROVIDER,
] as const;
const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_OAUTH_ISSUER = "https://auth.openai.com";
const OPENAI_CODEX_OAUTH_PORT = 1455;
const OPENAI_CODEX_OAUTH_BIND_HOST = "127.0.0.1";
const OPENAI_CODEX_OAUTH_PATH = "/auth/callback";
const OPENAI_CODEX_OAUTH_SUCCESS_PATH = "/success";
const OPENAI_CODEX_OAUTH_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const OPENAI_CODEX_OAUTH_ORIGINATOR = "codex_cli_rs";
const OPENAI_CODEX_OAUTH_RETRY_ATTEMPTS = 10;
const OPENAI_CODEX_OAUTH_RETRY_DELAY_MS = 200;
const OPENAI_CODEX_OAUTH_VERIFIER_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const GITHUB_COPILOT_OAUTH_CLIENT_ID = "Ov23li8tweQw6odWQebz";
const OAUTH_HTTP_TIMEOUT_MS = 30_000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;
const OAUTH_DEVICE_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const GOOGLE_OAUTH_CALLBACK_PATH = "/oauth2callback";
const GOOGLE_OAUTH_SUCCESS_PATH = "/success";
const GOOGLE_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  "kimi-coding": "Kimi",
  "moonshot-ai": "Moonshot AI Open Platform (moonshot.ai)",
  "moonshot-cn": "Moonshot AI Open Platform (moonshot.cn)",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  openrouter: "OpenRouter",
};

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  anthropic: "API key",
  deepseek: "API key",
  "github-copilot": "GitHub OAuth or token",
  google: "Google OAuth or Gemini CLI import",
  "kimi-coding": "Kimi Code or Moonshot API key",
  "moonshot-ai": "API key",
  "moonshot-cn": "API key",
  openai: "ChatGPT Plus/Pro or API key",
  "openai-codex": "ChatGPT Plus/Pro or API key",
  openrouter: "API key",
};

interface OAuthTokenResponse {
  idToken?: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

const pendingOAuthCompletions = new Map<
  string,
  Pick<ProviderOAuthCompletion, "complete"> & {
    credentialProvider: string;
    completionPromise?: Promise<HostedAuthCredential>;
    stored?: boolean;
  }
>();

export function getProviderCredentialRef(provider: string): string {
  return `vault://${provider}/${TOKEN_PROVIDERS.has(provider) ? "token" : "apiKey"}`;
}

function createVault(runtime: BrewvaRuntime): CredentialVaultService {
  return createCredentialVaultServiceFromSecurityConfig(
    runtime.workspaceRoot,
    runtime.config.security as Parameters<typeof createCredentialVaultServiceFromSecurityConfig>[1],
  );
}

export function configureCredentialVaultModelAuth(input: {
  runtime: BrewvaRuntime;
  authStore: { setFallbackResolver?: (resolver: (provider: string) => string | undefined) => void };
}): void {
  const vault = createVault(input.runtime);
  input.authStore.setFallbackResolver?.((provider) => {
    try {
      return vault.get(getProviderCredentialRef(provider));
    } catch {
      return undefined;
    }
  });
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function base64UrlEncode(buffer: Buffer | ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  return Buffer.from(bytes).toString("base64url");
}

function generatePkce(): { verifier: string; challenge: string } {
  const bytes = randomBytes(43);
  const verifier = Array.from(
    bytes,
    (byte) => OPENAI_CODEX_OAUTH_VERIFIER_CHARS[byte % OPENAI_CODEX_OAUTH_VERIFIER_CHARS.length],
  ).join("");
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function generateOAuthState(): string {
  return base64UrlEncode(randomBytes(32));
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

async function fetchOAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
  const compact = body.replace(/\s+/gu, " ").trim();
  if (compact.length <= 500) {
    return compact;
  }
  return `${compact.slice(0, 497)}...`;
}

async function formatOAuthHttpError(response: Response, prefix: string): Promise<string> {
  const body = await response.text().catch(() => "");
  const detail = truncateOAuthErrorBody(body);
  return detail.length > 0
    ? `${prefix}: ${response.status} ${detail}`
    : `${prefix}: ${response.status}`;
}

function buildOpenAICodexAuthorizeUrl(input: {
  redirectUri: string;
  pkce: { challenge: string };
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: OPENAI_CODEX_OAUTH_SCOPE,
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: input.state,
    originator: OPENAI_CODEX_OAUTH_ORIGINATOR,
  });
  return `${OPENAI_CODEX_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

function parseOpenAICodexAuthorizationInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (!value) {
    return {};
  }

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Continue parsing plain query strings or raw authorization codes.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function extractOpenAIAccountId(tokens: OAuthTokenResponse): string | undefined {
  const claims =
    (tokens.idToken ? parseJwtClaims(tokens.idToken) : undefined) ??
    parseJwtClaims(tokens.accessToken);
  if (!claims) {
    return undefined;
  }
  const direct = readString(claims.chatgpt_account_id);
  if (direct) {
    return direct;
  }
  const authClaims = asRecord(claims["https://api.openai.com/auth"]);
  const nested = readString(authClaims?.chatgpt_account_id);
  if (nested) {
    return nested;
  }
  const organizations = claims.organizations;
  if (Array.isArray(organizations)) {
    const first = asRecord(organizations[0]);
    return readString(first?.id);
  }
  return undefined;
}

function toOpenAICodexCredential(tokens: OAuthTokenResponse): HostedAuthCredential {
  const expiresAt =
    typeof tokens.expiresIn === "number"
      ? Date.now() + Math.max(0, tokens.expiresIn) * 1000
      : undefined;
  const credential: Extract<HostedAuthCredential, { type: "oauth" }> = {
    type: "oauth",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt,
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: expiresAt,
  };
  const accountId = extractOpenAIAccountId(tokens);
  return accountId ? { ...credential, accountId } : credential;
}

async function exchangeOpenAICodexCodeForTokens(input: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<OAuthTokenResponse> {
  const response = await fetchOAuth(`${OPENAI_CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
      code_verifier: input.codeVerifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(await formatOAuthHttpError(response, "Token exchange failed"));
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const accessToken = readString(payload.access_token);
  if (!accessToken) {
    throw new Error("Token exchange response was missing access_token.");
  }
  return {
    idToken: readString(payload.id_token),
    accessToken,
    refreshToken: readString(payload.refresh_token),
    expiresIn: readFiniteNumber(payload.expires_in),
  };
}

const HTML_SUCCESS = `<!doctype html>
<html><head><title>Brewva Authorization Successful</title></head>
<body><h1>Authorization Successful</h1><p>You can close this window and return to Brewva.</p>
<script>setTimeout(() => window.close(), 2000)</script></body></html>`;

function htmlError(error: string): string {
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

interface PendingOpenAICodexBrowserOAuth {
  pkce: { verifier: string; challenge: string };
  redirectUri: string;
  state: string;
  resolve(tokens: OAuthTokenResponse): void;
  reject(error: Error): void;
}

let openAICodexOAuthServer: ReturnType<typeof createServer> | undefined;
let openAICodexOAuthServerBinding: { port: number; redirectUri: string } | undefined;
let openAICodexOAuthServerClosing: Promise<void> | undefined;
let openAICodexOAuthCallbackCompleted = false;
let pendingOpenAICodexBrowserOAuth: PendingOpenAICodexBrowserOAuth | undefined;

function openAICodexOAuthRedirectUri(port: number): string {
  return `http://localhost:${port}${OPENAI_CODEX_OAUTH_PATH}`;
}

function openAICodexOAuthSuccessUri(port: number): string {
  return `http://localhost:${port}${OPENAI_CODEX_OAUTH_SUCCESS_PATH}`;
}

function isAddressInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

function openAICodexOAuthServerPort(server: ReturnType<typeof createServer>): number | undefined {
  const address = server.address();
  return typeof address === "object" && typeof address?.port === "number"
    ? address.port
    : undefined;
}

function writeOpenAICodexHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    Connection: "close",
  });
  res.end(body);
}

async function submitOpenAICodexBrowserAuthorization(input: {
  code: string;
  state?: string;
  source: "callback" | "manual";
}): Promise<OAuthTokenResponse> {
  const pending = pendingOpenAICodexBrowserOAuth;
  if (!pending) {
    throw new Error("No pending OpenAI Codex OAuth authorization.");
  }
  if (input.state && input.state !== pending.state) {
    throw new Error("Invalid state — potential CSRF attack.");
  }
  pendingOpenAICodexBrowserOAuth = undefined;
  try {
    const tokens = await exchangeOpenAICodexCodeForTokens({
      code: input.code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.pkce.verifier,
    });
    if (input.source === "callback") {
      openAICodexOAuthCallbackCompleted = true;
    }
    pending.resolve(tokens);
    return tokens;
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

async function submitOpenAICodexBrowserAuthorizationInput(
  input: string,
): Promise<OAuthTokenResponse> {
  const parsed = parseOpenAICodexAuthorizationInput(input);
  if (!parsed.code) {
    throw new Error("Missing authorization code.");
  }
  return await submitOpenAICodexBrowserAuthorization({
    code: parsed.code,
    state: parsed.state,
    source: "manual",
  });
}

async function handleOpenAICodexOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const binding = openAICodexOAuthServerBinding;
  const port = binding?.port ?? OPENAI_CODEX_OAUTH_PORT;
  const url = new URL(req.url || "/", `http://localhost:${port}`);

  if (url.pathname === OPENAI_CODEX_OAUTH_PATH) {
    const oauthError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (oauthError) {
      pendingOpenAICodexBrowserOAuth?.reject(new Error(oauthError));
      pendingOpenAICodexBrowserOAuth = undefined;
      writeOpenAICodexHtml(res, 200, htmlError(oauthError));
      return;
    }

    if (!code) {
      const message = "Missing authorization code.";
      pendingOpenAICodexBrowserOAuth?.reject(new Error(message));
      pendingOpenAICodexBrowserOAuth = undefined;
      writeOpenAICodexHtml(res, 400, htmlError(message));
      return;
    }

    if (!state) {
      const message = "Missing authorization state.";
      pendingOpenAICodexBrowserOAuth?.reject(new Error(message));
      pendingOpenAICodexBrowserOAuth = undefined;
      writeOpenAICodexHtml(res, 400, htmlError(message));
      return;
    }

    try {
      await submitOpenAICodexBrowserAuthorization({ code, state, source: "callback" });
      res.writeHead(302, {
        Location: openAICodexOAuthSuccessUri(port),
        Connection: "close",
      });
      res.end();
    } catch (submitError) {
      writeOpenAICodexHtml(
        res,
        400,
        htmlError(submitError instanceof Error ? submitError.message : String(submitError)),
      );
    }
    return;
  }

  if (url.pathname === OPENAI_CODEX_OAUTH_SUCCESS_PATH) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close",
    });
    res.end(HTML_SUCCESS, () => stopOpenAICodexOAuthServer());
    return;
  }

  if (url.pathname === "/cancel") {
    pendingOpenAICodexBrowserOAuth?.reject(new Error("Login cancelled"));
    pendingOpenAICodexBrowserOAuth = undefined;
    res.writeHead(200, { Connection: "close" });
    res.end("Login cancelled", () => stopOpenAICodexOAuthServer());
    return;
  }

  res.writeHead(404, { Connection: "close" });
  res.end("Not found");
}

function createOpenAICodexOAuthServer(): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    void handleOpenAICodexOAuthRequest(req, res).catch((error: unknown) => {
      writeOpenAICodexHtml(
        res,
        500,
        htmlError(error instanceof Error ? error.message : String(error)),
      );
    });
  });
}

async function listenOpenAICodexOAuthServer(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const actualPort = openAICodexOAuthServerPort(server);
      if (actualPort === undefined) {
        reject(new Error("OpenAI browser login callback server did not expose a port."));
        return;
      }
      resolve(actualPort);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, OPENAI_CODEX_OAUTH_BIND_HOST);
  });
}

function closeOpenAICodexOAuthServer(server: ReturnType<typeof createServer>): void {
  try {
    server.close();
  } catch {
    // The listen attempt can fail before Node marks the server as running.
  }
}

async function sendOpenAICodexOAuthCancelRequest(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: OPENAI_CODEX_OAUTH_PORT,
        path: "/cancel",
        method: "GET",
        timeout: 2_000,
        headers: {
          Connection: "close",
        },
      },
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    );
    request.on("error", () => resolve());
    request.on("timeout", () => {
      request.destroy();
      resolve();
    });
    request.end();
  });
}

async function startOpenAICodexOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (openAICodexOAuthServer) {
    return (
      openAICodexOAuthServerBinding ?? {
        port: OPENAI_CODEX_OAUTH_PORT,
        redirectUri: openAICodexOAuthRedirectUri(OPENAI_CODEX_OAUTH_PORT),
      }
    );
  }

  await openAICodexOAuthServerClosing;
  openAICodexOAuthServerClosing = undefined;

  const bindServer = async (port: number) => {
    const server = createOpenAICodexOAuthServer();
    try {
      const actualPort = await listenOpenAICodexOAuthServer(server, port);
      const binding = { port: actualPort, redirectUri: openAICodexOAuthRedirectUri(actualPort) };
      openAICodexOAuthServer = server;
      openAICodexOAuthServerBinding = binding;
      openAICodexOAuthCallbackCompleted = false;
      return binding;
    } catch (error) {
      closeOpenAICodexOAuthServer(server);
      throw error;
    }
  };

  let cancelAttempted = false;
  for (let attempt = 0; attempt < OPENAI_CODEX_OAUTH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await bindServer(OPENAI_CODEX_OAUTH_PORT);
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }
      if (!cancelAttempted) {
        cancelAttempted = true;
        await sendOpenAICodexOAuthCancelRequest();
      }
      await sleep(OPENAI_CODEX_OAUTH_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `OpenAI browser login requires localhost:${OPENAI_CODEX_OAUTH_PORT}/auth/callback because that redirect URI is registered with OpenAI. That port is already in use by another process; close the other Codex/OpenCode/Brewva login or choose ChatGPT Pro/Plus (headless).`,
  );
}

function stopOpenAICodexOAuthServer(): void {
  if (!openAICodexOAuthServer) {
    return;
  }
  const server = openAICodexOAuthServer;
  openAICodexOAuthServer = undefined;
  openAICodexOAuthServerBinding = undefined;
  openAICodexOAuthCallbackCompleted = false;
  openAICodexOAuthServerClosing = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function stopOpenAICodexOAuthServerAfterSuccessRedirect(): void {
  const timer = setTimeout(() => stopOpenAICodexOAuthServer(), 5_000);
  unrefTimer(timer);
}

function waitForOpenAICodexBrowserCallback(input: {
  pkce: { verifier: string; challenge: string };
  redirectUri: string;
  state: string;
}): Promise<OAuthTokenResponse> {
  if (pendingOpenAICodexBrowserOAuth) {
    throw new Error("OpenAI Codex OAuth is already in progress.");
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (!pendingOpenAICodexBrowserOAuth) {
          return;
        }
        pendingOpenAICodexBrowserOAuth = undefined;
        reject(new Error("OAuth callback timed out."));
      },
      5 * 60 * 1000,
    );
    timeout.unref();
    pendingOpenAICodexBrowserOAuth = {
      ...input,
      resolve(tokens) {
        clearTimeout(timeout);
        resolve(tokens);
      },
      reject(error) {
        clearTimeout(timeout);
        reject(error);
      },
    };
  });
}

async function authorizeOpenAICodexBrowser(): Promise<ProviderOAuthCompletion> {
  const { redirectUri } = await startOpenAICodexOAuthServer();
  const pkce = generatePkce();
  const state = generateOAuthState();
  const callbackPromise = waitForOpenAICodexBrowserCallback({ pkce, redirectUri, state });
  return {
    url: buildOpenAICodexAuthorizeUrl({ redirectUri, pkce, state }),
    method: "auto",
    openBrowser: true,
    instructions:
      "Approve the login in your browser or ChatGPT app. Brewva will continue after the browser redirects to localhost.",
    manualCode: {
      prompt:
        "Paste the final redirect URL or authorization code. Leave empty to keep waiting in the browser.",
    },
    async complete(code) {
      try {
        if (code?.trim()) {
          await submitOpenAICodexBrowserAuthorizationInput(code);
        }
        return toOpenAICodexCredential(await callbackPromise);
      } finally {
        if (openAICodexOAuthCallbackCompleted) {
          stopOpenAICodexOAuthServerAfterSuccessRedirect();
        } else {
          stopOpenAICodexOAuthServer();
        }
      }
    },
  };
}

async function authorizeOpenAICodexHeadless(): Promise<ProviderOAuthCompletion> {
  const response = await fetchOAuth(
    `${OPENAI_CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "brewva",
      },
      body: JSON.stringify({ client_id: OPENAI_CODEX_OAUTH_CLIENT_ID }),
    },
  );
  if (!response.ok) {
    throw new Error(await formatOAuthHttpError(response, "Failed to start device authorization"));
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const deviceAuthId = readString(payload.device_auth_id);
  const userCode = readString(payload.user_code);
  if (!deviceAuthId || !userCode) {
    throw new Error("Device authorization response was incomplete.");
  }
  const parsedInterval = Number.parseInt(readString(payload.interval) ?? "", 10);
  const intervalMs = Math.max(Number.isFinite(parsedInterval) ? parsedInterval : 5, 1) * 1000;

  return {
    url: `${OPENAI_CODEX_OAUTH_ISSUER}/codex/device`,
    method: "auto",
    instructions: `Enter code: ${userCode}`,
    copyText: userCode,
    async complete() {
      const deadline = Date.now() + OAUTH_DEVICE_FLOW_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const tokenResponse = await fetchOAuth(
          `${OPENAI_CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "brewva",
            },
            body: JSON.stringify({
              device_auth_id: deviceAuthId,
              user_code: userCode,
            }),
          },
        );

        if (tokenResponse.ok) {
          const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
          const authorizationCode = readString(tokenPayload.authorization_code);
          const codeVerifier = readString(tokenPayload.code_verifier);
          if (!authorizationCode || !codeVerifier) {
            throw new Error("Device token response was incomplete.");
          }
          return toOpenAICodexCredential(
            await exchangeOpenAICodexCodeForTokens({
              code: authorizationCode,
              redirectUri: `${OPENAI_CODEX_OAUTH_ISSUER}/deviceauth/callback`,
              codeVerifier,
            }),
          );
        }

        if (tokenResponse.status !== 403 && tokenResponse.status !== 404) {
          throw new Error(await formatOAuthHttpError(tokenResponse, "Device authorization failed"));
        }
        await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS);
      }
      throw new Error("Device authorization timed out.");
    },
  };
}

interface PendingGoogleBrowserOAuth {
  redirectUri: string;
  state: string;
  projectId: string;
  resolve(tokens: OAuthTokenResponse): void;
  reject(error: Error): void;
}

let googleOAuthServer: ReturnType<typeof createServer> | undefined;
let googleOAuthServerBinding: { port: number; redirectUri: string } | undefined;
let googleOAuthServerClosing: Promise<void> | undefined;
let googleOAuthCallbackCompleted = false;
let pendingGoogleBrowserOAuth: PendingGoogleBrowserOAuth | undefined;

function googleOAuthRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

function googleOAuthSuccessUri(port: number): string {
  return `http://127.0.0.1:${port}${GOOGLE_OAUTH_SUCCESS_PATH}`;
}

function buildGoogleOAuthAuthorizeUrl(input: { redirectUri: string; state: string }): string {
  const oauthClient = resolveGoogleOAuthClientConfig();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: oauthClient.clientId,
    redirect_uri: input.redirectUri,
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

function parseGoogleOAuthAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) {
    return {};
  }
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Continue parsing plain query strings or raw authorization codes.
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

async function exchangeGoogleOAuthCodeForTokens(input: {
  code: string;
  redirectUri: string;
}): Promise<OAuthTokenResponse> {
  const oauthClient = resolveGoogleOAuthClientConfig();
  const response = await fetchOAuth(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: oauthClient.clientId,
      client_secret: oauthClient.clientSecret,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(await formatOAuthHttpError(response, "Google token exchange failed"));
  }
  const parsed = parseGoogleOAuthTokenResponse((await response.json()) as Record<string, unknown>);
  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresIn: parsed.expiresIn,
    tokenType: parsed.tokenType,
    scope: parsed.scope,
  };
}

async function submitGoogleBrowserAuthorization(input: {
  code: string;
  state?: string;
  source: "callback" | "manual";
}): Promise<OAuthTokenResponse> {
  const pending = pendingGoogleBrowserOAuth;
  if (!pending) {
    throw new Error("No pending Google OAuth authorization.");
  }
  if (input.state && input.state !== pending.state) {
    throw new Error("Invalid state — potential CSRF attack.");
  }
  pendingGoogleBrowserOAuth = undefined;
  try {
    const tokens = await exchangeGoogleOAuthCodeForTokens({
      code: input.code,
      redirectUri: pending.redirectUri,
    });
    if (input.source === "callback") {
      googleOAuthCallbackCompleted = true;
    }
    pending.resolve(tokens);
    return tokens;
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

async function submitGoogleBrowserAuthorizationInput(input: string): Promise<OAuthTokenResponse> {
  const parsed = parseGoogleOAuthAuthorizationInput(input);
  if (!parsed.code) {
    throw new Error("Missing authorization code.");
  }
  return await submitGoogleBrowserAuthorization({
    code: parsed.code,
    state: parsed.state,
    source: "manual",
  });
}

function writeGoogleOAuthHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    Connection: "close",
  });
  res.end(body);
}

async function handleGoogleOAuthRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const binding = googleOAuthServerBinding;
  const port = binding?.port ?? 0;
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

  if (url.pathname === GOOGLE_OAUTH_CALLBACK_PATH) {
    const oauthError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (oauthError) {
      pendingGoogleBrowserOAuth?.reject(new Error(oauthError));
      pendingGoogleBrowserOAuth = undefined;
      writeGoogleOAuthHtml(res, 200, htmlError(oauthError));
      return;
    }
    if (!code) {
      const message = "Missing authorization code.";
      pendingGoogleBrowserOAuth?.reject(new Error(message));
      pendingGoogleBrowserOAuth = undefined;
      writeGoogleOAuthHtml(res, 400, htmlError(message));
      return;
    }
    if (!state) {
      const message = "Missing authorization state.";
      pendingGoogleBrowserOAuth?.reject(new Error(message));
      pendingGoogleBrowserOAuth = undefined;
      writeGoogleOAuthHtml(res, 400, htmlError(message));
      return;
    }

    try {
      await submitGoogleBrowserAuthorization({ code, state, source: "callback" });
      res.writeHead(302, {
        Location: googleOAuthSuccessUri(port),
        Connection: "close",
      });
      res.end();
    } catch (submitError) {
      writeGoogleOAuthHtml(
        res,
        400,
        htmlError(submitError instanceof Error ? submitError.message : String(submitError)),
      );
    }
    return;
  }

  if (url.pathname === GOOGLE_OAUTH_SUCCESS_PATH) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close",
    });
    res.end(HTML_SUCCESS, () => stopGoogleOAuthServer());
    return;
  }

  if (url.pathname === "/cancel") {
    pendingGoogleBrowserOAuth?.reject(new Error("Login cancelled"));
    pendingGoogleBrowserOAuth = undefined;
    res.writeHead(200, { Connection: "close" });
    res.end("Login cancelled", () => stopGoogleOAuthServer());
    return;
  }

  res.writeHead(404, { Connection: "close" });
  res.end("Not found");
}

function createGoogleOAuthServer(): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    void handleGoogleOAuthRequest(req, res).catch((error: unknown) => {
      writeGoogleOAuthHtml(
        res,
        500,
        htmlError(error instanceof Error ? error.message : String(error)),
      );
    });
  });
}

async function startGoogleOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (googleOAuthServer) {
    return (
      googleOAuthServerBinding ?? {
        port: 0,
        redirectUri: googleOAuthRedirectUri(0),
      }
    );
  }

  await googleOAuthServerClosing;
  googleOAuthServerClosing = undefined;
  const server = createGoogleOAuthServer();
  const actualPort = await listenOpenAICodexOAuthServer(server, 0);
  const binding = { port: actualPort, redirectUri: googleOAuthRedirectUri(actualPort) };
  googleOAuthServer = server;
  googleOAuthServerBinding = binding;
  googleOAuthCallbackCompleted = false;
  return binding;
}

function stopGoogleOAuthServer(): void {
  if (!googleOAuthServer) {
    return;
  }
  const server = googleOAuthServer;
  googleOAuthServer = undefined;
  googleOAuthServerBinding = undefined;
  googleOAuthCallbackCompleted = false;
  googleOAuthServerClosing = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function stopGoogleOAuthServerAfterSuccessRedirect(): void {
  const timer = setTimeout(() => stopGoogleOAuthServer(), 5_000);
  unrefTimer(timer);
}

function waitForGoogleBrowserCallback(input: {
  redirectUri: string;
  state: string;
  projectId: string;
}): Promise<OAuthTokenResponse> {
  if (pendingGoogleBrowserOAuth) {
    throw new Error("Google OAuth is already in progress.");
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pendingGoogleBrowserOAuth) {
        return;
      }
      pendingGoogleBrowserOAuth = undefined;
      reject(new Error("Google OAuth callback timed out."));
    }, GOOGLE_OAUTH_TIMEOUT_MS);
    timeout.unref();
    pendingGoogleBrowserOAuth = {
      ...input,
      resolve(tokens) {
        clearTimeout(timeout);
        resolve(tokens);
      },
      reject(error) {
        clearTimeout(timeout);
        reject(error);
      },
    };
  });
}

function requireGoogleProjectId(inputs: Record<string, string>): string {
  const projectId = resolveGoogleProjectId({ projectId: inputs.projectId, env: process.env });
  if (!projectId) {
    throw new Error(
      "Google Cloud project ID is required. Enter it in /model or set GOOGLE_CLOUD_PROJECT.",
    );
  }
  return projectId;
}

async function authorizeGoogleBrowser(
  inputs: Record<string, string> = {},
): Promise<ProviderOAuthCompletion> {
  const projectId = requireGoogleProjectId(inputs);
  const { redirectUri } = await startGoogleOAuthServer();
  const state = generateOAuthState();
  const callbackPromise = waitForGoogleBrowserCallback({ redirectUri, state, projectId });
  return {
    url: buildGoogleOAuthAuthorizeUrl({ redirectUri, state }),
    method: "auto",
    openBrowser: true,
    instructions:
      "Approve Google Gemini access in your browser. Brewva will continue after the browser redirects to localhost.",
    manualCode: {
      prompt:
        "Paste the final redirect URL or authorization code. Leave empty to keep waiting in the browser.",
    },
    async complete(code) {
      try {
        if (code?.trim()) {
          await submitGoogleBrowserAuthorizationInput(code);
        }
        return toGoogleHostedOAuthCredential({
          tokens: await callbackPromise,
          projectId,
        }) as HostedAuthCredential;
      } finally {
        if (googleOAuthCallbackCompleted) {
          stopGoogleOAuthServerAfterSuccessRedirect();
        } else {
          stopGoogleOAuthServer();
        }
      }
    },
  };
}

async function authorizeGoogleGeminiCliImport(
  inputs: Record<string, string> = {},
): Promise<ProviderOAuthCompletion> {
  const sourcePath = resolveGeminiCliOAuthCredentialPath({
    credentialPath: inputs.credentialPath,
    env: process.env,
  });
  return {
    url: `file://${sourcePath}`,
    method: "auto",
    openBrowser: false,
    instructions: `Import OAuth credentials from ${sourcePath}.`,
    async complete() {
      return loadGeminiCliOAuthCredential({
        credentialPath: inputs.credentialPath,
        projectId: inputs.projectId,
        env: process.env,
      }).credential as HostedAuthCredential;
    },
  };
}

function normalizeGitHubDomain(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.host;
  } catch {
    return "";
  }
}

function githubCopilotUrls(domain: string): { deviceCodeUrl: string; accessTokenUrl: string } {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  };
}

function githubCopilotDeviceFlowErrorMessage(error: string): string {
  switch (error) {
    case "expired_token":
    case "token_expired":
      return "GitHub device authorization expired. Reopen /model to request a new code.";
    case "access_denied":
      return "GitHub device authorization was denied.";
    case "incorrect_device_code":
      return "GitHub device authorization failed: incorrect device code.";
    case "incorrect_client_credentials":
      return "GitHub device authorization failed: incorrect client credentials.";
    case "device_flow_disabled":
      return "GitHub device authorization failed: device flow is disabled for this OAuth app.";
    case "unsupported_grant_type":
      return "GitHub device authorization failed: unsupported grant type.";
    default:
      return `GitHub device authorization failed: ${error}`;
  }
}

async function waitForGitHubCopilotDevicePoll(
  intervalMs: number,
  deadline: number,
): Promise<boolean> {
  const waitMs = intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS;
  if (Date.now() + waitMs >= deadline) {
    return false;
  }
  await sleep(waitMs);
  return true;
}

async function authorizeGitHubCopilot(
  inputs: Record<string, string> = {},
): Promise<ProviderOAuthCompletion> {
  const deploymentType = inputs.deploymentType || "github.com";
  const domain =
    deploymentType === "enterprise"
      ? normalizeGitHubDomain(inputs.enterpriseUrl ?? "")
      : "github.com";
  if (!domain) {
    throw new Error("GitHub Enterprise URL is required.");
  }
  const urls = githubCopilotUrls(domain);
  const response = await fetchOAuth(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "brewva",
    },
    body: JSON.stringify({
      client_id: GITHUB_COPILOT_OAUTH_CLIENT_ID,
      scope: "read:user",
    }),
  });
  if (!response.ok) {
    throw new Error(
      await formatOAuthHttpError(response, "Failed to start GitHub device authorization"),
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const verificationUri =
    readString(payload.verification_uri_complete) ?? readString(payload.verification_uri);
  const userCode = readString(payload.user_code);
  const deviceCode = readString(payload.device_code);
  const intervalSeconds = readFiniteNumber(payload.interval) ?? 5;
  const expiresInSeconds =
    readFiniteNumber(payload.expires_in) ?? OAUTH_DEVICE_FLOW_TIMEOUT_MS / 1000;
  if (!verificationUri || !userCode || !deviceCode) {
    throw new Error("GitHub device authorization response was incomplete.");
  }

  return {
    url: verificationUri,
    method: "auto",
    instructions: `Enter code: ${userCode}`,
    copyText: userCode,
    async complete() {
      let intervalMs = Math.max(intervalSeconds, 1) * 1000;
      const deadline = Date.now() + Math.max(expiresInSeconds, 1) * 1000;
      while (Date.now() < deadline) {
        const tokenResponse = await fetchOAuth(urls.accessTokenUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": "brewva",
          },
          body: JSON.stringify({
            client_id: GITHUB_COPILOT_OAUTH_CLIENT_ID,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
        const accessToken = readString(tokenPayload.access_token);
        if (accessToken) {
          const credential: Extract<HostedAuthCredential, { type: "oauth" }> = {
            type: "oauth",
            accessToken,
            refreshToken: accessToken,
            expiresAt: 0,
            access: accessToken,
            refresh: accessToken,
            expires: 0,
          };
          return deploymentType === "enterprise"
            ? { ...credential, enterpriseUrl: domain }
            : credential;
        }

        const error = readString(tokenPayload.error);
        if (error === "authorization_pending") {
          if (!(await waitForGitHubCopilotDevicePoll(intervalMs, deadline))) {
            break;
          }
          continue;
        }
        if (error === "slow_down") {
          const serverInterval = readFiniteNumber(tokenPayload.interval);
          intervalMs = Math.max(serverInterval ? serverInterval * 1000 : intervalMs + 5_000, 1_000);
          if (!(await waitForGitHubCopilotDevicePoll(intervalMs, deadline))) {
            break;
          }
          continue;
        }
        if (error) {
          throw new Error(githubCopilotDeviceFlowErrorMessage(error));
        }
        if (!tokenResponse.ok) {
          throw new Error(
            await formatOAuthHttpError(tokenResponse, "GitHub device authorization failed"),
          );
        }
        throw new Error("GitHub device authorization failed.");
      }
      throw new Error("GitHub device authorization expired. Reopen /model to request a new code.");
    },
  };
}

function createOpenAIChatGPTAuthHandler(provider: string): ProviderAuthHandler {
  const methods: readonly ProviderOAuthAuthMethod[] = [
    {
      id: "chatgpt_browser",
      kind: "oauth",
      type: "oauth",
      label: "ChatGPT Pro/Plus (browser)",
    },
    {
      id: "chatgpt_headless",
      kind: "oauth",
      type: "oauth",
      label: "ChatGPT Pro/Plus (headless)",
    },
  ];
  return {
    provider,
    listAuthMethods() {
      return methods;
    },
    async authorizeOAuth(methodId) {
      if (methodId === "chatgpt_browser") {
        return authorizeOpenAICodexBrowser();
      }
      if (methodId === "chatgpt_headless") {
        return authorizeOpenAICodexHeadless();
      }
      return undefined;
    },
  };
}

function createGitHubCopilotAuthHandler(): ProviderAuthHandler {
  const methods: readonly ProviderOAuthAuthMethod[] = [
    {
      id: "github_copilot",
      kind: "oauth",
      type: "oauth",
      label: "Login with GitHub Copilot",
      prompts: [
        {
          type: "select",
          key: "deploymentType",
          message: "Select GitHub deployment type",
          options: [
            { label: "GitHub.com", value: "github.com", hint: "Public" },
            {
              label: "GitHub Enterprise",
              value: "enterprise",
              hint: "Data residency or self-hosted",
            },
          ],
        },
        {
          type: "text",
          key: "enterpriseUrl",
          message: "Enter your GitHub Enterprise URL or domain",
          placeholder: "company.ghe.com or https://company.ghe.com",
          when: { key: "deploymentType", op: "eq", value: "enterprise" },
        },
      ],
    },
  ];
  return {
    provider: "github-copilot",
    listAuthMethods() {
      return methods;
    },
    async authorizeOAuth(methodId, inputs = {}) {
      if (methodId !== "github_copilot") {
        return undefined;
      }
      return authorizeGitHubCopilot(inputs);
    },
  };
}

function createGoogleGeminiAuthHandler(): ProviderAuthHandler {
  const projectPrompt: ProviderAuthPrompt = {
    type: "text",
    key: "projectId",
    message: "Google Cloud project ID",
    placeholder: "Leave empty to use GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID",
  };
  const browserOAuthMethod: ProviderOAuthAuthMethod = {
    id: "gemini_oauth_browser",
    kind: "oauth",
    type: "oauth",
    label: "Sign in with Google",
    detail: "Recommended OAuth",
    prompts: [projectPrompt],
  };
  const cliImportMethod: ProviderOAuthAuthMethod = {
    id: "gemini_cli_import",
    kind: "oauth",
    type: "oauth",
    label: "Import existing Gemini CLI login",
    detail: "Local import",
    prompts: [
      projectPrompt,
      {
        type: "text",
        key: "credentialPath",
        message: "Gemini CLI OAuth credential file",
        placeholder: "Leave empty for ~/.gemini/oauth_creds.json",
      },
    ],
  };
  return {
    provider: GOOGLE_PROVIDER,
    listAuthMethods() {
      return hasGoogleOAuthClientConfig()
        ? [browserOAuthMethod, cliImportMethod]
        : [cliImportMethod];
    },
    async authorizeOAuth(methodId, inputs = {}) {
      if (methodId === "gemini_oauth_browser") {
        return authorizeGoogleBrowser(inputs);
      }
      if (methodId === "gemini_cli_import") {
        return authorizeGoogleGeminiCliImport(inputs);
      }
      return undefined;
    },
  };
}

function createBuiltInProviderAuthHandlers(): ProviderAuthHandler[] {
  return [
    createOpenAIChatGPTAuthHandler(OPENAI_CODEX_PROVIDER),
    createGitHubCopilotAuthHandler(),
    createGoogleGeminiAuthHandler(),
  ];
}

function formatProviderName(provider: string): string {
  return (
    PROVIDER_DISPLAY_NAMES[provider] ??
    provider
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}

function providerRank(provider: string): number {
  const index = POPULAR_PROVIDER_ORDER.indexOf(provider as (typeof POPULAR_PROVIDER_ORDER)[number]);
  return index >= 0 ? index : Number.POSITIVE_INFINITY;
}

function sortProviders(left: ProviderConnection, right: ProviderConnection): number {
  if (left.group !== right.group) {
    return left.group === "popular" ? -1 : 1;
  }
  const leftRank = providerRank(left.id);
  const rightRank = providerRank(right.id);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.name.localeCompare(right.name);
}

function providerConnectionSourceRank(source: ProviderConnectionSource): number {
  switch (source) {
    case "oauth":
      return 5;
    case "vault":
      return 4;
    case "provider_config":
      return 2;
    case "none":
      return 1;
  }
  return 0;
}

function pickProviderConnectionSource(
  providers: readonly ProviderConnection[],
): ProviderConnectionSource {
  return (
    providers.toSorted(
      (left, right) =>
        providerConnectionSourceRank(right.connectionSource) -
        providerConnectionSourceRank(left.connectionSource),
    )[0]?.connectionSource ?? "none"
  );
}

function consolidateOpenAIConnectionProviders(
  providers: readonly ProviderConnection[],
): ProviderConnection[] {
  const openAI = providers.find((provider) => provider.id === OPENAI_PROVIDER);
  const openAICodex = providers.find((provider) => provider.id === OPENAI_CODEX_PROVIDER);
  if (!openAI && !openAICodex) {
    return [...providers];
  }

  const coveredProviders = [openAI, openAICodex].filter(
    (provider): provider is ProviderConnection => provider !== undefined,
  );
  const consolidated: ProviderConnection = {
    id: OPENAI_PROVIDER,
    name: formatProviderName(OPENAI_PROVIDER),
    group: "popular",
    connected: coveredProviders.some((provider) => provider.connected),
    connectionSource: pickProviderConnectionSource(coveredProviders),
    description: PROVIDER_DESCRIPTIONS[OPENAI_PROVIDER],
    modelProviders: coveredProviders.map((provider) => provider.id),
    modelCount: coveredProviders.reduce((sum, provider) => sum + provider.modelCount, 0),
    availableModelCount: coveredProviders.reduce(
      (sum, provider) => sum + provider.availableModelCount,
      0,
    ),
    credentialRef: getProviderCredentialRef(OPENAI_PROVIDER),
  };

  return [
    consolidated,
    ...providers.filter(
      (provider) => provider.id !== OPENAI_PROVIDER && provider.id !== OPENAI_CODEX_PROVIDER,
    ),
  ].toSorted(sortProviders);
}

function consolidateKimiConnectionProviders(
  providers: readonly ProviderConnection[],
): ProviderConnection[] {
  const coveredProviders = KIMI_COVERED_PROVIDERS.map((providerId) =>
    providers.find((provider) => provider.id === providerId),
  ).filter((provider): provider is ProviderConnection => provider !== undefined);

  if (coveredProviders.length === 0) {
    return [...providers];
  }

  const consolidated: ProviderConnection = {
    id: KIMI_PROVIDER,
    name: formatProviderName(KIMI_PROVIDER),
    group: "popular",
    connected: coveredProviders.some((provider) => provider.connected),
    connectionSource: pickProviderConnectionSource(coveredProviders),
    description: PROVIDER_DESCRIPTIONS[KIMI_PROVIDER],
    modelProviders: coveredProviders.map((provider) => provider.id),
    modelCount: coveredProviders.reduce((sum, provider) => sum + provider.modelCount, 0),
    availableModelCount: coveredProviders.reduce(
      (sum, provider) => sum + provider.availableModelCount,
      0,
    ),
    credentialRef: getProviderCredentialRef(KIMI_CODE_PROVIDER),
  };

  const covered = new Set<string>(KIMI_COVERED_PROVIDERS);
  return [consolidated, ...providers.filter((provider) => !covered.has(provider.id))].toSorted(
    sortProviders,
  );
}

function consolidateConnectionProviders(
  providers: readonly ProviderConnection[],
): ProviderConnection[] {
  return consolidateKimiConnectionProviders(consolidateOpenAIConnectionProviders(providers));
}

async function listAvailableModels(
  modelRegistry: ProviderConnectionModelCatalog,
): Promise<readonly BrewvaRegisteredModel[]> {
  const available = modelRegistry.getAvailable?.();
  if (!available) {
    return [];
  }
  return [...(await Promise.resolve(available))] as readonly BrewvaRegisteredModel[];
}

function groupModelsByProvider(
  models: readonly BrewvaRegisteredModel[],
): Map<string, BrewvaRegisteredModel[]> {
  const grouped = new Map<string, BrewvaRegisteredModel[]>();
  for (const model of models) {
    const modelsForProvider = grouped.get(model.provider) ?? [];
    modelsForProvider.push(model);
    grouped.set(model.provider, modelsForProvider);
  }
  return grouped;
}

function hasVaultCredential(vault: CredentialVaultService, provider: string): boolean {
  try {
    return vault.get(getProviderCredentialRef(provider)) !== undefined;
  } catch {
    return false;
  }
}

function resolveConnectionSource(input: {
  vault: CredentialVaultService;
  authStore?: ProviderConnectionAuthStore;
  provider: string;
  connected: boolean;
}): ProviderConnectionSource {
  const credential = input.authStore?.get?.(input.provider);
  if (credential?.type === "oauth") {
    return "oauth";
  }
  if (hasVaultCredential(input.vault, input.provider)) {
    return "vault";
  }
  return input.connected ? "provider_config" : "none";
}

export function createProviderConnectionPort(input: {
  runtime: BrewvaRuntime;
  modelRegistry: ProviderConnectionModelCatalog;
  authStore?: ProviderConnectionAuthStore;
  authHandlers?: readonly ProviderAuthHandler[];
}): ProviderConnectionPort {
  const vault = createVault(input.runtime);
  const authHandlers = [...createBuiltInProviderAuthHandlers(), ...(input.authHandlers ?? [])];

  const kimiApiKeyMethods = (): ProviderApiKeyAuthMethod[] => [
    {
      id: "kimi_code_api_key",
      kind: "api_key",
      type: "api",
      label: "Kimi Code",
      credentialRef: getProviderCredentialRef(KIMI_CODE_PROVIDER),
      credentialProvider: KIMI_CODE_PROVIDER,
      modelProviderFilter: KIMI_CODE_PROVIDER,
    },
    {
      id: "moonshot_cn_api_key",
      kind: "api_key",
      type: "api",
      label: "Moonshot AI Open Platform (moonshot.cn)",
      credentialRef: getProviderCredentialRef(MOONSHOT_CN_PROVIDER),
      credentialProvider: MOONSHOT_CN_PROVIDER,
      modelProviderFilter: MOONSHOT_CN_PROVIDER,
    },
    {
      id: "moonshot_ai_api_key",
      kind: "api_key",
      type: "api",
      label: "Moonshot AI Open Platform (moonshot.ai)",
      credentialRef: getProviderCredentialRef(MOONSHOT_AI_PROVIDER),
      credentialProvider: MOONSHOT_AI_PROVIDER,
      modelProviderFilter: MOONSHOT_AI_PROVIDER,
    },
  ];

  const apiKeyMethodForProvider = (provider: string): ProviderApiKeyAuthMethod | undefined => {
    if (API_KEY_UNSUPPORTED_PROVIDERS.has(provider)) {
      return undefined;
    }
    const label =
      provider === OPENAI_PROVIDER || provider === OPENAI_CODEX_PROVIDER
        ? "Manually enter API Key"
        : TOKEN_PROVIDERS.has(provider)
          ? "Token"
          : "API key";
    const credentialProvider = provider === OPENAI_CODEX_PROVIDER ? OPENAI_PROVIDER : provider;
    return {
      id: "api_key",
      kind: "api_key",
      type: "api",
      label,
      credentialRef: getProviderCredentialRef(credentialProvider),
      credentialProvider,
      modelProviderFilter: credentialProvider,
    };
  };

  const oauthMethodsForProvider = (provider: string): ProviderOAuthAuthMethod[] => {
    if (!input.authStore?.set) {
      return [];
    }
    const authProvider = provider === OPENAI_PROVIDER ? OPENAI_CODEX_PROVIDER : provider;
    const byId = new Map<string, ProviderOAuthAuthMethod>();
    for (const handler of authHandlers) {
      if (handler.provider !== authProvider) {
        continue;
      }
      for (const method of handler.listAuthMethods()) {
        byId.set(method.id, {
          ...method,
          credentialProvider: authProvider,
          modelProviderFilter: authProvider,
        });
      }
    }
    return [...byId.values()];
  };

  const authorizeWithHandler = async (
    provider: string,
    methodId: string,
    inputs: Record<string, string>,
  ): Promise<ProviderOAuthCompletion | undefined> => {
    for (const handler of authHandlers.toReversed()) {
      if (handler.provider !== provider) {
        continue;
      }
      if (!handler.listAuthMethods().some((method) => method.id === methodId)) {
        continue;
      }
      const authorization = await handler.authorizeOAuth(methodId, inputs);
      if (authorization) {
        return authorization;
      }
    }
    return undefined;
  };

  return {
    async listProviders() {
      const allModels = input.modelRegistry.getAll?.() ?? [];
      const availableModels = await listAvailableModels(input.modelRegistry);
      const availableByProvider = groupModelsByProvider(availableModels as BrewvaRegisteredModel[]);
      const providers = [...groupModelsByProvider(allModels as BrewvaRegisteredModel[]).entries()]
        .map(([provider, models]) => {
          const availableModelCount = availableByProvider.get(provider)?.length ?? 0;
          const connected =
            availableModelCount > 0 ||
            models.some((model) => input.modelRegistry.hasConfiguredAuth?.(model));
          return {
            id: provider,
            name: formatProviderName(provider),
            group:
              providerRank(provider) === Number.POSITIVE_INFINITY
                ? ("other" as const)
                : ("popular" as const),
            connected,
            description: PROVIDER_DESCRIPTIONS[provider],
            connectionSource: resolveConnectionSource({
              vault,
              authStore: input.authStore,
              provider,
              connected,
            }),
            modelProviders: [provider],
            modelCount: models.length,
            availableModelCount,
            credentialRef: getProviderCredentialRef(provider),
          };
        })
        .toSorted(sortProviders);
      return consolidateConnectionProviders(providers);
    },

    listAuthMethods(provider) {
      if (provider === KIMI_PROVIDER) {
        return kimiApiKeyMethods();
      }
      const apiKeyMethod = apiKeyMethodForProvider(provider);
      return [...oauthMethodsForProvider(provider), ...(apiKeyMethod ? [apiKeyMethod] : [])];
    },

    async connectApiKey(provider, key) {
      input.authStore?.remove?.(provider);
      vault.put(getProviderCredentialRef(provider), key);
      await this.refresh();
    },

    async authorizeOAuth(provider, methodId, inputs = {}) {
      if (!input.authStore?.set) {
        throw new Error("OAuth credential storage is unavailable for this session.");
      }
      const method = this.listAuthMethods(provider).find((candidate) => candidate.id === methodId);
      const credentialProvider = method?.credentialProvider ?? provider;
      const authorization = await authorizeWithHandler(credentialProvider, methodId, inputs);
      if (!authorization) {
        return undefined;
      }
      const completeAuthorization = (code?: string) => authorization.complete(code);
      const publicAuthorization: ProviderOAuthAuthorization = {
        url: authorization.url,
        method: authorization.method,
        instructions: authorization.instructions,
        copyText: authorization.copyText,
        openBrowser: authorization.openBrowser,
        manualCode: authorization.manualCode,
      };
      pendingOAuthCompletions.set(`${provider}:${methodId}`, {
        complete: completeAuthorization,
        credentialProvider,
      });
      return publicAuthorization;
    },

    async completeOAuth(provider, methodId, code) {
      if (!input.authStore?.set) {
        throw new Error("OAuth credential storage is unavailable for this session.");
      }
      const key = `${provider}:${methodId}`;
      const pending = pendingOAuthCompletions.get(key);
      if (!pending) {
        throw new Error(`No pending OAuth authorization for ${provider}.`);
      }
      try {
        const credential = code
          ? await pending.complete(code)
          : await (pending.completionPromise ??= pending.complete());
        if (!pending.stored) {
          pending.stored = true;
          input.authStore.set(pending.credentialProvider, credential);
          vault.remove(getProviderCredentialRef(pending.credentialProvider));
          await this.refresh();
        }
      } finally {
        pendingOAuthCompletions.delete(key);
      }
    },

    async disconnect(provider) {
      const providers =
        provider === OPENAI_PROVIDER
          ? [OPENAI_PROVIDER, OPENAI_CODEX_PROVIDER]
          : provider === KIMI_PROVIDER
            ? [...KIMI_COVERED_PROVIDERS]
            : [provider];
      for (const targetProvider of providers) {
        vault.remove(getProviderCredentialRef(targetProvider));
        input.authStore?.remove?.(targetProvider);
      }
      await this.refresh();
    },

    async refresh() {
      input.modelRegistry.refresh?.();
    },
  };
}
