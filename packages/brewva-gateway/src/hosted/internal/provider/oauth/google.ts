import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { HostedAuthCredential } from "../../session/settings/hosted-auth-store.js";
import {
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_TOKEN_URL,
  hasGoogleOAuthClientConfig,
  loadGeminiCliOAuthCredential,
  parseGoogleOAuthTokenResponse,
  resolveGeminiCliOAuthCredentialPath,
  resolveGoogleOAuthClientConfig,
  resolveGoogleProjectId,
  toGoogleHostedOAuthCredential,
} from "../google-oauth.js";
import { GOOGLE_PROVIDER } from "../shared.js";
import type {
  ProviderAuthHandler,
  ProviderAuthPrompt,
  ProviderOAuthAuthMethod,
  ProviderOAuthCompletion,
} from "../types.js";
import {
  fetchOAuth,
  formatOAuthHttpError,
  generateOAuthState,
  HTML_SUCCESS,
  htmlError,
  listenOAuthServer,
  unrefTimer,
  type OAuthTokenResponse,
} from "./shared.js";

const GOOGLE_OAUTH_CALLBACK_PATH = "/oauth2callback";
const GOOGLE_OAUTH_SUCCESS_PATH = "/success";
const GOOGLE_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

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
  } catch {}
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
  const actualPort = await listenOAuthServer({
    server,
    port: 0,
    host: "127.0.0.1",
    missingPortMessage: "Google browser login callback server did not expose a port.",
  });
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

export function createGoogleGeminiAuthHandler(): ProviderAuthHandler {
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
