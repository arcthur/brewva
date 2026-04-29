import { createDecipheriv, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const GOOGLE_OAUTH_PROVIDER = "google";
export const GOOGLE_OAUTH_CLIENT_ID_ENV = "BREWVA_GOOGLE_OAUTH_CLIENT_ID";
export const GOOGLE_OAUTH_CLIENT_SECRET_ENV = "BREWVA_GOOGLE_OAUTH_CLIENT_SECRET";
export const GOOGLE_OAUTH_CLIENT_ID = "";
export const GOOGLE_OAUTH_CLIENT_SECRET = "";
export const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_GEMINI_CLI_OAUTH_FILE = "oauth_creds.json";
export const GOOGLE_GEMINI_CLI_DIR = ".gemini";
export const GOOGLE_GEMINI_CLI_MAIN_ACCOUNT_KEY = "main-account";
export const GOOGLE_GEMINI_CLI_FILE_KEYCHAIN_FILE = "gemini-credentials.json";
export const GOOGLE_GEMINI_CLI_KEYCHAIN_SERVICE = "gemini-cli-oauth";
export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

export interface GoogleOAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

export interface GoogleHostedOAuthCredential {
  type: "oauth";
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  access?: string;
  refresh?: string;
  expires?: number;
  projectId?: string;
  tokenType?: string;
  scope?: string;
}

export interface ImportedGoogleGeminiCliCredential {
  credential: GoogleHostedOAuthCredential;
  sourcePath: string;
}

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
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

export function resolveGoogleOAuthClientConfig(
  env: Record<string, string | undefined> = process.env,
): GoogleOAuthClientConfig {
  const clientId = readString(env[GOOGLE_OAUTH_CLIENT_ID_ENV]) ?? GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret =
    readString(env[GOOGLE_OAUTH_CLIENT_SECRET_ENV]) ?? GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      `Google OAuth browser flow requires ${GOOGLE_OAUTH_CLIENT_ID_ENV} and ${GOOGLE_OAUTH_CLIENT_SECRET_ENV}.`,
    );
  }
  return { clientId, clientSecret };
}

function resolvePathLike(pathText: string, baseDir = process.cwd()): string {
  const trimmed = pathText.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseDir, trimmed);
}

export function resolveGeminiCliHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = readString(env.GEMINI_CLI_HOME);
  return configured ? resolvePathLike(configured) : homedir();
}

export function resolveGeminiCliOAuthCredentialPath(input?: {
  credentialPath?: string;
  env?: Record<string, string | undefined>;
}): string {
  const credentialPath = readString(input?.credentialPath);
  if (credentialPath) {
    return resolvePathLike(credentialPath);
  }
  return join(
    resolveGeminiCliHome(input?.env),
    GOOGLE_GEMINI_CLI_DIR,
    GOOGLE_GEMINI_CLI_OAUTH_FILE,
  );
}

export function resolveGeminiCliFileKeychainPath(input?: {
  env?: Record<string, string | undefined>;
}): string {
  return join(
    resolveGeminiCliHome(input?.env),
    GOOGLE_GEMINI_CLI_DIR,
    GOOGLE_GEMINI_CLI_FILE_KEYCHAIN_FILE,
  );
}

export function resolveGoogleProjectId(input?: {
  projectId?: string;
  env?: Record<string, string | undefined>;
  credential?: Record<string, unknown>;
}): string | undefined {
  return (
    readString(input?.projectId) ??
    readString(input?.env?.GOOGLE_CLOUD_PROJECT) ??
    readString(input?.env?.GOOGLE_CLOUD_PROJECT_ID) ??
    readString(input?.credential?.quota_project_id) ??
    readString(input?.credential?.project_id)
  );
}

export function toGoogleHostedOAuthCredential(input: {
  tokens: GoogleOAuthTokenResponse;
  projectId: string;
}): GoogleHostedOAuthCredential {
  const expiresAt =
    typeof input.tokens.expiresIn === "number"
      ? Date.now() + Math.max(0, input.tokens.expiresIn) * 1000
      : undefined;
  return {
    type: "oauth",
    accessToken: input.tokens.accessToken,
    refreshToken: input.tokens.refreshToken,
    expiresAt,
    access: input.tokens.accessToken,
    refresh: input.tokens.refreshToken,
    expires: expiresAt,
    projectId: input.projectId,
    tokenType: input.tokens.tokenType,
    scope: input.tokens.scope,
  };
}

export function parseGoogleOAuthTokenResponse(
  payload: Record<string, unknown>,
): GoogleOAuthTokenResponse {
  const accessToken = readString(payload.access_token) ?? readString(payload.accessToken);
  if (!accessToken) {
    throw new Error("Google OAuth token response was missing access_token.");
  }
  return {
    accessToken,
    refreshToken: readString(payload.refresh_token) ?? readString(payload.refreshToken),
    expiresIn: readFiniteNumber(payload.expires_in) ?? readFiniteNumber(payload.expiresIn),
    tokenType: readString(payload.token_type) ?? readString(payload.tokenType),
    scope: readString(payload.scope),
  };
}

export function parseGeminiCliOAuthCredential(input: {
  raw: string;
  projectId?: string;
  env?: Record<string, string | undefined>;
}): GoogleHostedOAuthCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch (error) {
    throw new Error("Gemini CLI OAuth credential file is not valid JSON.", { cause: error });
  }
  const record = asRecord(parsed);
  const nestedToken = asRecord(record?.token);
  const accessToken =
    readString(record?.access_token) ??
    readString(record?.accessToken) ??
    readString(nestedToken?.accessToken);
  if (!accessToken) {
    throw new Error("Gemini CLI OAuth credential file is missing an access token.");
  }
  const projectId = resolveGoogleProjectId({
    projectId: input.projectId,
    env: input.env,
    credential: record,
  });
  if (!projectId) {
    throw new Error(
      "Google Cloud project ID is required. Enter it in /model or set GOOGLE_CLOUD_PROJECT.",
    );
  }
  const refreshToken =
    readString(record?.refresh_token) ??
    readString(record?.refreshToken) ??
    readString(nestedToken?.refreshToken);
  const expiresAt =
    readFiniteNumber(record?.expiry_date) ??
    readFiniteNumber(record?.expiresAt) ??
    readFiniteNumber(nestedToken?.expiresAt);
  return {
    type: "oauth",
    accessToken,
    refreshToken,
    expiresAt,
    access: accessToken,
    refresh: refreshToken,
    expires: expiresAt,
    projectId,
    tokenType:
      readString(record?.token_type) ??
      readString(record?.tokenType) ??
      readString(nestedToken?.tokenType),
    scope: readString(record?.scope) ?? readString(nestedToken?.scope),
  };
}

function decryptGeminiCliFileKeychain(raw: string): Record<string, Record<string, string>> {
  const parts = raw.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid Gemini CLI encrypted credential file format.");
  }
  const [ivHex, authTagHex, encryptedHex] = parts as [string, string, string];
  const key = scryptSync("gemini-cli-oauth", `${hostname()}-${userInfo().username}-gemini-cli`, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = `${decipher.update(encryptedHex, "hex", "utf8")}${decipher.final("utf8")}`;
  return JSON.parse(decrypted) as Record<string, Record<string, string>>;
}

function parseGeminiCliFileKeychainCredential(input: {
  raw: string;
  projectId?: string;
  env?: Record<string, string | undefined>;
}): GoogleHostedOAuthCredential {
  const decrypted = decryptGeminiCliFileKeychain(input.raw);
  const service = asRecord(decrypted[GOOGLE_GEMINI_CLI_KEYCHAIN_SERVICE]);
  const password = readString(service?.[GOOGLE_GEMINI_CLI_MAIN_ACCOUNT_KEY]);
  if (!password) {
    throw new Error("Gemini CLI encrypted credential file does not contain main-account tokens.");
  }
  let stored: unknown;
  try {
    stored = JSON.parse(password);
  } catch (error) {
    throw new Error("Gemini CLI encrypted main-account credential is not valid JSON.", {
      cause: error,
    });
  }
  const token = asRecord(asRecord(stored)?.token);
  if (!token) {
    throw new Error("Gemini CLI encrypted main-account credential is missing token data.");
  }
  return parseGeminiCliOAuthCredential({
    raw: JSON.stringify({
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      tokenType: token.tokenType,
      scope: token.scope,
    }),
    projectId: input.projectId,
    env: input.env,
  });
}

export function loadGeminiCliOAuthCredential(input: {
  credentialPath?: string;
  projectId?: string;
  env?: Record<string, string | undefined>;
}): ImportedGoogleGeminiCliCredential {
  const sourcePath = resolveGeminiCliOAuthCredentialPath({
    credentialPath: input.credentialPath,
    env: input.env,
  });
  if (!existsSync(sourcePath) && !readString(input.credentialPath)) {
    const keychainPath = resolveGeminiCliFileKeychainPath({ env: input.env });
    if (existsSync(keychainPath)) {
      return {
        sourcePath: keychainPath,
        credential: parseGeminiCliFileKeychainCredential({
          raw: readFileSync(keychainPath, "utf8"),
          projectId: input.projectId,
          env: input.env,
        }),
      };
    }
  }
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Gemini CLI OAuth credential file was not found at ${sourcePath}. Run Gemini CLI login first or use Google browser OAuth.`,
    );
  }
  const raw = readFileSync(sourcePath, "utf8");
  if (sourcePath.endsWith(GOOGLE_GEMINI_CLI_FILE_KEYCHAIN_FILE)) {
    return {
      sourcePath,
      credential: parseGeminiCliFileKeychainCredential({
        raw,
        projectId: input.projectId,
        env: input.env,
      }),
    };
  }
  return {
    sourcePath,
    credential: parseGeminiCliOAuthCredential({
      raw,
      projectId: input.projectId,
      env: input.env,
    }),
  };
}

export function renderGoogleCloudCodeAssistCredential(
  credential: GoogleHostedOAuthCredential,
): string | undefined {
  const accessToken = readString(credential.accessToken) ?? readString(credential.access);
  const projectId = readString(credential.projectId);
  if (!accessToken || !projectId) {
    return undefined;
  }
  return JSON.stringify({ token: accessToken, projectId });
}

export async function refreshGoogleOAuthAccessToken(
  refreshToken: string,
): Promise<Required<Pick<GoogleOAuthTokenResponse, "accessToken">> & GoogleOAuthTokenResponse> {
  const oauthClient = resolveGoogleOAuthClientConfig();
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: oauthClient.clientId,
      client_secret: oauthClient.clientSecret,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Google OAuth token refresh failed: ${response.status}`);
  }
  return parseGoogleOAuthTokenResponse((await response.json()) as Record<string, unknown>);
}
