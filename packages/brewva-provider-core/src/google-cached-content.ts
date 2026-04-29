const GOOGLE_VERTEX_API_VERSION = "v1";
const GOOGLE_VERTEX_DEFAULT_LOCATION = "us-central1";
const GOOGLE_VERTEX_BASE_HOST_SUFFIX = "-aiplatform.googleapis.com";
const DEFAULT_GOOGLE_CACHED_CONTENT_TIMEOUT_MS = 30_000;

export interface GoogleGeminiCliCredential {
  token: string;
  projectId: string;
}

export interface GoogleCachedContentEndpointConfig {
  apiVersion: string;
  baseUrl: string;
  location: string;
}

export interface GoogleCachedContentConfigInput {
  model: string;
  displayName?: string;
  ttlSeconds?: number;
  systemInstruction?: unknown;
  tools?: unknown;
  toolConfig?: unknown;
  endpoint?: Partial<GoogleCachedContentEndpointConfig>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type GoogleCachedContentDeleteOptions = Partial<GoogleCachedContentEndpointConfig> & {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface GoogleCachedContentResource {
  name: string;
  expireTime?: string;
}

export class GoogleCachedContentError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "GoogleCachedContentError";
    this.code = code;
    this.status = status;
  }
}

export const GOOGLE_CLOUD_CODE_ASSIST_CREDENTIAL_HINT =
  'Connect Google from /model or store {"token":"...","projectId":"..."} at vault://google/apiKey.';

export function parseGoogleGeminiCliCredential(credential: string): GoogleGeminiCliCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    throw new Error(
      `Invalid Google Cloud Code Assist credentials. ${GOOGLE_CLOUD_CODE_ASSIST_CREDENTIAL_HINT}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { token?: unknown }).token !== "string" ||
    typeof (parsed as { projectId?: unknown }).projectId !== "string"
  ) {
    throw new Error(
      `Missing token or projectId in Google Cloud credentials. ${GOOGLE_CLOUD_CODE_ASSIST_CREDENTIAL_HINT}`,
    );
  }
  return {
    token: (parsed as { token: string }).token,
    projectId: (parsed as { projectId: string }).projectId,
  };
}

export function resolveGoogleCachedContentEndpoint(
  input: Partial<GoogleCachedContentEndpointConfig> = {},
): GoogleCachedContentEndpointConfig {
  const envBaseUrl = process.env["BREWVA_GOOGLE_VERTEX_CACHE_BASE_URL"];
  const normalizedEnvBaseUrl = normalizeBaseUrl(envBaseUrl);
  if (envBaseUrl && !normalizedEnvBaseUrl) {
    throw new Error(
      "BREWVA_GOOGLE_VERTEX_CACHE_BASE_URL must be a region-specific Vertex AI host such as https://us-central1-aiplatform.googleapis.com.",
    );
  }
  const configuredBaseUrl = normalizeBaseUrl(input.baseUrl) ?? normalizedEnvBaseUrl;
  const configuredLocation =
    normalizeNonEmpty(input.location) ??
    inferVertexLocationFromBaseUrl(configuredBaseUrl) ??
    normalizeNonEmpty(process.env["BREWVA_GOOGLE_VERTEX_CACHE_LOCATION"]) ??
    GOOGLE_VERTEX_DEFAULT_LOCATION;
  return {
    apiVersion: normalizeNonEmpty(input.apiVersion) ?? GOOGLE_VERTEX_API_VERSION,
    baseUrl: configuredBaseUrl ?? `https://${configuredLocation}${GOOGLE_VERTEX_BASE_HOST_SUFFIX}`,
    location: configuredLocation,
  };
}

export async function createGoogleCachedContent(
  credential: string,
  input: GoogleCachedContentConfigInput,
): Promise<GoogleCachedContentResource> {
  const parsed = parseGoogleGeminiCliCredential(credential);
  const endpoint = resolveGoogleCachedContentEndpoint(input.endpoint);
  const response = await fetchGoogleCachedContent(
    buildCachedContentCollectionUrl(parsed.projectId, endpoint),
    {
      method: "POST",
      headers: buildGoogleCachedContentHeaders(parsed),
      body: JSON.stringify({
        model: buildVertexModelName(parsed.projectId, input.model, endpoint.location),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.ttlSeconds ? { ttl: `${input.ttlSeconds}s` } : {}),
        ...(input.systemInstruction ? { systemInstruction: input.systemInstruction } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.toolConfig ? { toolConfig: input.toolConfig } : {}),
      }),
    },
    {
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    },
  );
  if (!response.ok) {
    throw await buildGoogleCachedContentError(response);
  }
  const created = (await response.json()) as {
    name?: string;
    expireTime?: string;
    expirationTime?: string;
  };
  return {
    name: created.name ?? "",
    expireTime: created.expireTime ?? created.expirationTime,
  };
}

export async function deleteGoogleCachedContent(
  credential: string,
  name: string,
  endpointInput?: GoogleCachedContentDeleteOptions,
): Promise<void> {
  if (!name) {
    return;
  }
  const parsed = parseGoogleGeminiCliCredential(credential);
  const endpoint = resolveGoogleCachedContentEndpoint(endpointInput);
  const response = await fetchGoogleCachedContent(
    buildCachedContentItemUrl(parsed.projectId, name, endpoint),
    {
      method: "DELETE",
      headers: buildGoogleCachedContentHeaders(parsed),
    },
    endpointInput,
  );
  if (!response.ok) {
    throw await buildGoogleCachedContentError(response);
  }
}

async function fetchGoogleCachedContent(
  input: RequestInfo | URL,
  init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const upstreamSignal = options.signal ?? init.signal ?? undefined;
  if (!upstreamSignal && timeoutMs <= 0) {
    return await fetch(input, init);
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  if (timeout) {
    unrefTimer(timeout);
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new GoogleCachedContentError(
        "vertex_request_timeout",
        `Google cached content request timed out after ${timeoutMs}ms.`,
      );
    }
    if (upstreamSignal?.aborted && isAbortError(error)) {
      throw new GoogleCachedContentError(
        "vertex_request_aborted",
        "Google cached content request was aborted.",
      );
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_GOOGLE_CACHED_CONTENT_TIMEOUT_MS;
  }
  return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_GOOGLE_CACHED_CONTENT_TIMEOUT_MS;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

function buildGoogleCachedContentHeaders(
  credential: GoogleGeminiCliCredential,
): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.token}`,
    "Content-Type": "application/json",
    "x-goog-user-project": credential.projectId,
  };
}

function buildCachedContentCollectionUrl(
  projectId: string,
  endpoint: GoogleCachedContentEndpointConfig,
): string {
  return [
    endpoint.baseUrl,
    endpoint.apiVersion,
    "projects",
    projectId,
    "locations",
    endpoint.location,
    "cachedContents",
  ].join("/");
}

function buildCachedContentItemUrl(
  projectId: string,
  name: string,
  endpoint: GoogleCachedContentEndpointConfig,
): string {
  const normalizedName = name.startsWith("projects/")
    ? name
    : `projects/${projectId}/locations/${endpoint.location}/${name.replace(/^\/+/, "")}`;
  return `${endpoint.baseUrl}/${endpoint.apiVersion}/${normalizedName}`;
}

function buildVertexModelName(projectId: string, model: string, location: string): string {
  if (model.startsWith("projects/")) {
    return model;
  }
  if (model.startsWith("publishers/")) {
    return `projects/${projectId}/locations/${location}/${model}`;
  }
  const normalizedModel =
    model.startsWith("models/") || model.startsWith("tunedModels/") ? model : `models/${model}`;
  return `projects/${projectId}/locations/${location}/publishers/google/${normalizedModel}`;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes(GOOGLE_VERTEX_BASE_HOST_SUFFIX)) {
    return trimmed;
  }
  return undefined;
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function inferVertexLocationFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    if (!host.endsWith(GOOGLE_VERTEX_BASE_HOST_SUFFIX)) {
      return undefined;
    }
    return host.slice(0, -GOOGLE_VERTEX_BASE_HOST_SUFFIX.length) || undefined;
  } catch {
    return undefined;
  }
}

async function buildGoogleCachedContentError(
  response: Response,
): Promise<GoogleCachedContentError> {
  const text = await response.text();
  const serverMessage = extractGoogleCachedContentErrorMessage(text);
  if (response.status === 401) {
    return new GoogleCachedContentError(
      "vertex_unauthorized",
      serverMessage ||
        "Google cached content creation was unauthorized. The Cloud Code Assist token may be missing Vertex AI cloud-platform scope.",
      response.status,
    );
  }
  if (response.status === 403) {
    return new GoogleCachedContentError(
      "vertex_forbidden",
      serverMessage ||
        "Google cached content creation was forbidden. Check Vertex AI access and project billing for the resolved region.",
      response.status,
    );
  }
  if (response.status === 404) {
    return new GoogleCachedContentError(
      "vertex_endpoint_not_found",
      serverMessage ||
        "Google cached content endpoint was not found. Check the configured Vertex AI cached-content region and base URL.",
      response.status,
    );
  }
  if (response.status === 400) {
    return new GoogleCachedContentError(
      "vertex_invalid_request",
      serverMessage ||
        "Google cached content request was invalid. Check the Vertex region and cached-content model resource alignment.",
      response.status,
    );
  }
  return new GoogleCachedContentError(
    "vertex_request_failed",
    serverMessage || `Google cached content request failed with ${response.status}.`,
    response.status,
  );
}

function extractGoogleCachedContentErrorMessage(text: string): string {
  if (!text) {
    return "";
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Fall through to the raw text when the server does not return JSON.
  }
  return text;
}
