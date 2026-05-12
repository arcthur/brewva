import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { HostedAuthCredential } from "../../session/settings/hosted-auth-store.js";
import type {
  ProviderAuthHandler,
  ProviderOAuthAuthMethod,
  ProviderOAuthCompletion,
} from "../types.js";
import {
  closeOAuthServer,
  fetchOAuth,
  formatOAuthHttpError,
  generateOAuthState,
  HTML_SUCCESS,
  htmlError,
  isAddressInUseError,
  listenOAuthServer,
  OAUTH_DEVICE_FLOW_TIMEOUT_MS,
  OAUTH_POLLING_SAFETY_MARGIN_MS,
  readFiniteNumber,
  readString,
  unrefTimer,
  type OAuthTokenResponse,
} from "./shared.js";

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
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
  const challenge = base64UrlEncode(Buffer.from(sha256Hex(verifier), "hex"));
  return { verifier, challenge };
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
  } catch {}
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
      const actualPort = await listenOAuthServer({
        server,
        port,
        host: OPENAI_CODEX_OAUTH_BIND_HOST,
        missingPortMessage: "OpenAI browser login callback server did not expose a port.",
      });
      const binding = { port: actualPort, redirectUri: openAICodexOAuthRedirectUri(actualPort) };
      openAICodexOAuthServer = server;
      openAICodexOAuthServerBinding = binding;
      openAICodexOAuthCallbackCompleted = false;
      return binding;
    } catch (error) {
      closeOAuthServer(server);
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

export function createOpenAIChatGPTAuthHandler(provider: string): ProviderAuthHandler {
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
