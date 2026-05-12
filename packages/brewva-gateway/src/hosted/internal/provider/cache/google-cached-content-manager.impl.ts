import {
  GoogleCachedContentError,
  buildRenderBucketKey,
  createGoogleCachedContent,
  deleteGoogleCachedContent,
  parseGoogleGeminiCliCredential,
  resolveGoogleCachedContentEndpoint,
  resolveGoogleGeminiCliCacheRender,
} from "@brewva/brewva-provider-core/cache";
import type { GoogleCachedContentEndpointConfig } from "@brewva/brewva-provider-core/cache";
import type {
  ProviderCachePolicy,
  ProviderCacheRenderResult,
} from "@brewva/brewva-provider-core/contracts";
import {
  redactedStableJsonSha256Hex,
  redactedStableJsonStringify,
  sha256Hex,
} from "@brewva/brewva-std/hash";
import { estimateStructuredTokenCount } from "@brewva/brewva-token-estimation";

const MAX_PENDING_DELETE_ATTEMPTS = 5;
const PENDING_DELETE_BASE_DELAY_MS = 30 * 1000;
const GOOGLE_CACHED_CONTENT_DEFAULT_MINIMUM_TOKENS = 1_024;
const GOOGLE_CACHED_CONTENT_PRO_MINIMUM_TOKENS = 4_096;

interface GoogleCachedContentPayload {
  model: string;
  request: Record<string, unknown>;
}

interface GoogleCachedContentRecord {
  name: string;
  model: string;
  ttlSeconds: number;
  expireAt: number;
  endpoint: GoogleCachedContentEndpointConfig;
  estimatedCachedTokens: number;
  deleteAttempts: number;
  nextDeleteAt: number;
}

interface GoogleCachedContentCapabilityState {
  status: "unknown" | "available" | "unsupported";
  reason?: string;
  zeroReadStreakByCachedContent: Map<string, number>;
  requestPathVerified: boolean;
  authFailureCredentialFingerprint?: string;
}

export interface GoogleCachedContentAdapter {
  create(
    credential: string,
    input: {
      model: string;
      displayName?: string;
      ttlSeconds?: number;
      systemInstruction?: unknown;
      tools?: unknown;
      toolConfig?: unknown;
      endpoint?: Partial<GoogleCachedContentEndpointConfig>;
    },
  ): Promise<{ name: string; expireTime?: string }>;
  delete(
    credential: string,
    name: string,
    endpoint?: Partial<GoogleCachedContentEndpointConfig>,
  ): Promise<void>;
}

export interface GoogleCachedContentApplyResult {
  payload: unknown;
  render?: ProviderCacheRenderResult;
}

export class GoogleCachedContentManager {
  readonly #recordsByWorkspace = new Map<string, Map<string, GoogleCachedContentRecord>>();
  readonly #sessionBindings = new Map<string, Map<string, string>>();
  readonly #pendingDeletesByWorkspace = new Map<string, Map<string, GoogleCachedContentRecord>>();
  readonly #inflightCreatesByWorkspace = new Map<
    string,
    Map<string, Promise<GoogleCachedContentRecord>>
  >();
  readonly #capabilityByWorkspace = new Map<
    string,
    Map<string, GoogleCachedContentCapabilityState>
  >();
  readonly #adapter: GoogleCachedContentAdapter;

  constructor(
    adapter: GoogleCachedContentAdapter = {
      create: createGoogleCachedContent,
      delete: deleteGoogleCachedContent,
    },
  ) {
    this.#adapter = adapter;
  }

  async apply(input: {
    workspaceRoot: string;
    sessionId: string;
    cachePolicy: ProviderCachePolicy;
    credential?: string;
    payload: unknown;
    modelBaseUrl?: string;
  }): Promise<GoogleCachedContentApplyResult> {
    const payload = asGoogleCachedContentPayload(input.payload);
    if (!payload) {
      return { payload: input.payload };
    }
    const workspaceKey = normalizeWorkspaceKey(input.workspaceRoot);
    if (input.credential) {
      await this.#flushPendingDeletes(workspaceKey, input.credential);
    }
    const prefixHash = buildPrefixHash(payload);
    const boundPrefix = this.#getSessionBinding(workspaceKey, input.sessionId);

    if (boundPrefix && boundPrefix !== prefixHash) {
      await this.#releaseBinding(workspaceKey, input.sessionId, input.credential);
    }

    if (input.cachePolicy.retention !== "long") {
      await this.#releaseBinding(workspaceKey, input.sessionId, input.credential);
      return {
        payload: input.payload,
        render: resolveGoogleGeminiCliCacheRender({
          sessionId: input.sessionId,
          policy: input.cachePolicy,
        }),
      };
    }

    const estimatedCachedTokens = estimateCachedContentTokens(payload);
    if (estimatedCachedTokens < resolveGoogleCachedContentMinimumTokens(payload.model)) {
      await this.#releaseBinding(workspaceKey, input.sessionId, input.credential);
      return {
        payload: input.payload,
        render: degradedGoogleImplicitPrefixRender({
          sessionId: input.sessionId,
          policy: input.cachePolicy,
          reason: "google_cached_content_below_minimum_tokens",
        }),
      };
    }

    const endpointResolution = tryResolveGoogleCachedContentEndpoint({
      baseUrl: input.modelBaseUrl,
    });
    if (!endpointResolution.ok) {
      await this.#releaseBinding(workspaceKey, input.sessionId, input.credential);
      return {
        payload: input.payload,
        render: unsupportedGoogleCachedContentRender({
          sessionId: input.sessionId,
          policy: input.cachePolicy,
          reason: endpointResolution.reason,
        }),
      };
    }
    const endpoint = endpointResolution.endpoint;
    const capabilityState = input.credential
      ? this.#maybeRecoverCapabilityAfterCredentialChange(workspaceKey, endpoint, input.credential)
      : this.#getCapabilityState(workspaceKey, endpoint);

    if (capabilityState.status === "unsupported") {
      await this.#releaseBinding(workspaceKey, input.sessionId, input.credential);
      return {
        payload: input.payload,
        render: unsupportedGoogleCachedContentRender({
          sessionId: input.sessionId,
          policy: input.cachePolicy,
          reason: capabilityState.reason ?? "google_cached_content_unavailable",
        }),
      };
    }

    const existing = this.#lookup(workspaceKey, prefixHash);
    if (existing) {
      this.#bind(workspaceKey, input.sessionId, prefixHash);
      return {
        payload: withCachedContent(payload, existing.name),
        render: resolveGoogleGeminiCliCacheRender({
          sessionId: input.sessionId,
          policy: input.cachePolicy,
          cachedContentName: existing.name,
          cachedContentTtlSeconds: existing.ttlSeconds,
        }),
      };
    }

    if (input.cachePolicy.writeMode === "readOnly") {
      return {
        payload: input.payload,
        render: resolveGoogleGeminiCliCacheRender({
          sessionId: input.sessionId,
          policy: input.cachePolicy,
        }),
      };
    }

    if (!input.credential) {
      return {
        payload: input.payload,
        render: unsupportedGoogleCachedContentRender({
          sessionId: input.sessionId,
          policy: input.cachePolicy,
          reason: "google_cached_content_missing_credentials",
        }),
      };
    }

    try {
      const record = await this.#getOrCreateRecord({
        workspaceKey,
        prefixHash,
        credential: input.credential,
        payload,
        endpoint,
        estimatedCachedTokens,
      });
      this.#bind(workspaceKey, input.sessionId, prefixHash);
      return {
        payload: withCachedContent(payload, record.name),
        render: resolveGoogleGeminiCliCacheRender({
          sessionId: input.sessionId,
          policy: input.cachePolicy,
          cachedContentName: record.name,
          cachedContentTtlSeconds: record.ttlSeconds,
        }),
      };
    } catch (error) {
      const reason = normalizeErrorReason(error);
      if (shouldMemoizeCapabilityFailure(error)) {
        this.#markCapabilityUnsupported(workspaceKey, endpoint, reason, input.credential);
      }
      return {
        payload: input.payload,
        render: unsupportedGoogleCachedContentRender({
          sessionId: input.sessionId,
          policy: input.cachePolicy,
          reason,
        }),
      };
    }
  }

  observeUsage(input: {
    workspaceRoot: string;
    modelBaseUrl?: string;
    render?: {
      renderedRetention?: ProviderCacheRenderResult["renderedRetention"];
      cachedContentName?: string;
    };
    cacheRead: number;
  }): void {
    if (
      input.render?.renderedRetention !== "long" ||
      typeof input.render.cachedContentName !== "string" ||
      input.render.cachedContentName.length === 0
    ) {
      return;
    }
    const workspaceKey = normalizeWorkspaceKey(input.workspaceRoot);
    const record = this.#lookupByName(workspaceKey, input.render.cachedContentName);
    if (!record) {
      return;
    }
    if (record.estimatedCachedTokens < resolveGoogleCachedContentMinimumTokens(record.model)) {
      return;
    }
    const endpointResolution = tryResolveGoogleCachedContentEndpoint({
      baseUrl: input.modelBaseUrl,
    });
    if (!endpointResolution.ok) {
      return;
    }
    const endpoint = endpointResolution.endpoint;
    const state = this.#getCapabilityState(workspaceKey, endpoint);
    if (input.cacheRead > 0) {
      this.#markCapabilityAvailable(workspaceKey, endpoint, true);
      return;
    }
    if (state.requestPathVerified) {
      return;
    }
    const nextStreak =
      (state.zeroReadStreakByCachedContent.get(input.render.cachedContentName) ?? 0) + 1;
    state.zeroReadStreakByCachedContent.set(input.render.cachedContentName, nextStreak);
    if (nextStreak >= 2) {
      state.status = "unsupported";
      state.reason = "google_cached_content_request_path_ignored";
    }
  }

  markUnsupportedFromStreamError(input: {
    workspaceRoot: string;
    modelBaseUrl?: string;
    reason: string;
  }): void {
    const workspaceKey = normalizeWorkspaceKey(input.workspaceRoot);
    const endpointResolution = tryResolveGoogleCachedContentEndpoint({
      baseUrl: input.modelBaseUrl,
    });
    if (!endpointResolution.ok) {
      return;
    }
    const endpoint = endpointResolution.endpoint;
    this.#markCapabilityUnsupported(workspaceKey, endpoint, normalizeReason(input.reason));
  }

  resetCapability(workspaceRoot: string, modelBaseUrl?: string): void {
    const workspaceKey = normalizeWorkspaceKey(workspaceRoot);
    const endpointResolution = tryResolveGoogleCachedContentEndpoint({ baseUrl: modelBaseUrl });
    if (!endpointResolution.ok) {
      return;
    }
    const endpoint = endpointResolution.endpoint;
    this.#resetCapabilityState(workspaceKey, endpoint);
    this.#maybeDropWorkspace(workspaceKey);
  }

  async releaseSession(
    workspaceRoot: string,
    sessionId: string,
    credential?: string,
  ): Promise<void> {
    const workspaceKey = normalizeWorkspaceKey(workspaceRoot);
    await this.#releaseBinding(workspaceKey, sessionId, credential);
    if (credential) {
      await this.#flushPendingDeletes(workspaceKey, credential);
    }
    this.#maybeDropWorkspace(workspaceKey);
  }

  dropWorkspace(workspaceRoot: string): void {
    const workspaceKey = normalizeWorkspaceKey(workspaceRoot);
    this.#recordsByWorkspace.delete(workspaceKey);
    this.#sessionBindings.delete(workspaceKey);
    this.#pendingDeletesByWorkspace.delete(workspaceKey);
    this.#inflightCreatesByWorkspace.delete(workspaceKey);
    this.#capabilityByWorkspace.delete(workspaceKey);
  }

  #lookup(workspaceKey: string, prefixHash: string): GoogleCachedContentRecord | undefined {
    const record = this.#getWorkspaceRecords(workspaceKey).get(prefixHash);
    if (!record) {
      return undefined;
    }
    if (record.expireAt <= Date.now()) {
      this.#getWorkspaceRecords(workspaceKey).delete(prefixHash);
      this.#maybeDropWorkspace(workspaceKey);
      return undefined;
    }
    return record;
  }

  #lookupByName(workspaceKey: string, name: string): GoogleCachedContentRecord | undefined {
    const records = this.#getWorkspaceRecords(workspaceKey);
    for (const [prefixHash, record] of records.entries()) {
      if (record.name !== name) {
        continue;
      }
      if (record.expireAt <= Date.now()) {
        records.delete(prefixHash);
        this.#maybeDropWorkspace(workspaceKey);
        return undefined;
      }
      return record;
    }
    return undefined;
  }

  #store(workspaceKey: string, prefixHash: string, record: GoogleCachedContentRecord): void {
    this.#getWorkspaceRecords(workspaceKey).set(prefixHash, record);
  }

  #bind(workspaceKey: string, sessionId: string, prefixHash: string): void {
    this.#getBindings(workspaceKey).set(sessionId, prefixHash);
  }

  async #releaseBinding(
    workspaceKey: string,
    sessionId: string,
    credential?: string,
  ): Promise<void> {
    const bindings = this.#getBindings(workspaceKey);
    const prefixHash = bindings.get(sessionId);
    bindings.delete(sessionId);
    if (!prefixHash) {
      this.#maybeDropWorkspace(workspaceKey);
      return;
    }
    const stillReferenced = [...bindings.values()].includes(prefixHash);
    if (stillReferenced) {
      this.#maybeDropWorkspace(workspaceKey);
      return;
    }
    const record = this.#getWorkspaceRecords(workspaceKey).get(prefixHash);
    if (!record) {
      this.#maybeDropWorkspace(workspaceKey);
      return;
    }
    this.#getWorkspaceRecords(workspaceKey).delete(prefixHash);
    if (!credential) {
      this.#schedulePendingDelete(workspaceKey, prefixHash, record);
      return;
    }
    try {
      await this.#adapter.delete(credential, record.name, record.endpoint);
    } catch (error) {
      this.#schedulePendingDelete(workspaceKey, prefixHash, record, error);
    }
  }

  async #flushPendingDeletes(workspaceKey: string, credential: string): Promise<void> {
    const pendingDeletes = this.#getPendingDeletes(workspaceKey);
    const now = Date.now();
    for (const [prefixHash, record] of pendingDeletes.entries()) {
      if (record.nextDeleteAt > now) {
        continue;
      }
      try {
        await this.#adapter.delete(credential, record.name, record.endpoint);
        pendingDeletes.delete(prefixHash);
      } catch (error) {
        if (record.deleteAttempts + 1 >= MAX_PENDING_DELETE_ATTEMPTS) {
          pendingDeletes.delete(prefixHash);
          continue;
        }
        this.#schedulePendingDelete(workspaceKey, prefixHash, record, error);
      }
    }
    this.#maybeDropWorkspace(workspaceKey);
  }

  #schedulePendingDelete(
    workspaceKey: string,
    prefixHash: string,
    record: GoogleCachedContentRecord,
    error?: unknown,
  ): void {
    const nextAttempts = error ? record.deleteAttempts + 1 : record.deleteAttempts;
    const nextDeleteAt = error
      ? Date.now() + PENDING_DELETE_BASE_DELAY_MS * 2 ** Math.max(0, nextAttempts - 1)
      : record.nextDeleteAt;
    this.#getPendingDeletes(workspaceKey).set(prefixHash, {
      ...record,
      deleteAttempts: nextAttempts,
      nextDeleteAt,
    });
  }

  async #getOrCreateRecord(input: {
    workspaceKey: string;
    prefixHash: string;
    credential: string;
    payload: GoogleCachedContentPayload;
    endpoint: GoogleCachedContentEndpointConfig;
    estimatedCachedTokens: number;
  }): Promise<GoogleCachedContentRecord> {
    const inflightCreates = this.#getInflightCreates(input.workspaceKey);
    const existing = inflightCreates.get(input.prefixHash);
    if (existing) {
      return existing;
    }
    const creation = (async () => {
      const ttlSeconds = 60 * 60;
      const created = await this.#adapter.create(input.credential, {
        model: input.payload.model,
        displayName: `brewva-${input.prefixHash.slice(0, 12)}`,
        ttlSeconds,
        systemInstruction: input.payload.request["systemInstruction"],
        tools: input.payload.request["tools"],
        toolConfig: input.payload.request["toolConfig"] ?? input.payload.request["tool_config"],
        endpoint: input.endpoint,
      });
      if (!created.name) {
        throw new Error("Google cached content response missing resource name.");
      }
      const record: GoogleCachedContentRecord = {
        name: created.name,
        model: input.payload.model,
        ttlSeconds,
        expireAt: parseExpireAt(created.expireTime, ttlSeconds),
        endpoint: input.endpoint,
        estimatedCachedTokens: input.estimatedCachedTokens,
        deleteAttempts: 0,
        nextDeleteAt: 0,
      };
      this.#store(input.workspaceKey, input.prefixHash, record);
      this.#markCapabilityAvailable(input.workspaceKey, input.endpoint);
      return record;
    })();
    inflightCreates.set(input.prefixHash, creation);
    try {
      return await creation;
    } finally {
      if (inflightCreates.get(input.prefixHash) === creation) {
        inflightCreates.delete(input.prefixHash);
      }
      this.#maybeDropWorkspace(input.workspaceKey);
    }
  }

  #getWorkspaceRecords(workspaceKey: string): Map<string, GoogleCachedContentRecord> {
    let records = this.#recordsByWorkspace.get(workspaceKey);
    if (!records) {
      records = new Map();
      this.#recordsByWorkspace.set(workspaceKey, records);
    }
    return records;
  }

  #getBindings(workspaceKey: string): Map<string, string> {
    let bindings = this.#sessionBindings.get(workspaceKey);
    if (!bindings) {
      bindings = new Map();
      this.#sessionBindings.set(workspaceKey, bindings);
    }
    return bindings;
  }

  #getPendingDeletes(workspaceKey: string): Map<string, GoogleCachedContentRecord> {
    let pendingDeletes = this.#pendingDeletesByWorkspace.get(workspaceKey);
    if (!pendingDeletes) {
      pendingDeletes = new Map();
      this.#pendingDeletesByWorkspace.set(workspaceKey, pendingDeletes);
    }
    return pendingDeletes;
  }

  #getInflightCreates(workspaceKey: string): Map<string, Promise<GoogleCachedContentRecord>> {
    let inflightCreates = this.#inflightCreatesByWorkspace.get(workspaceKey);
    if (!inflightCreates) {
      inflightCreates = new Map();
      this.#inflightCreatesByWorkspace.set(workspaceKey, inflightCreates);
    }
    return inflightCreates;
  }

  #getCapabilityState(
    workspaceKey: string,
    endpoint: GoogleCachedContentEndpointConfig,
  ): GoogleCachedContentCapabilityState {
    let workspaceStates = this.#capabilityByWorkspace.get(workspaceKey);
    if (!workspaceStates) {
      workspaceStates = new Map();
      this.#capabilityByWorkspace.set(workspaceKey, workspaceStates);
    }
    const key = buildEndpointKey(endpoint);
    let state = workspaceStates.get(key);
    if (!state) {
      state = {
        status: "unknown",
        zeroReadStreakByCachedContent: new Map(),
        requestPathVerified: false,
      };
      workspaceStates.set(key, state);
    }
    return state;
  }

  #markCapabilityAvailable(
    workspaceKey: string,
    endpoint: GoogleCachedContentEndpointConfig,
    requestPathVerified = false,
  ): void {
    const state = this.#getCapabilityState(workspaceKey, endpoint);
    state.status = "available";
    state.reason = undefined;
    state.zeroReadStreakByCachedContent.clear();
    state.requestPathVerified = state.requestPathVerified || requestPathVerified;
    state.authFailureCredentialFingerprint = undefined;
  }

  #markCapabilityUnsupported(
    workspaceKey: string,
    endpoint: GoogleCachedContentEndpointConfig,
    reason: string,
    credential?: string,
  ): void {
    const state = this.#getCapabilityState(workspaceKey, endpoint);
    state.status = "unsupported";
    state.reason = reason;
    state.authFailureCredentialFingerprint = isAuthCapabilityReason(reason)
      ? fingerprintGoogleCredential(credential)
      : undefined;
  }

  #resetCapabilityState(workspaceKey: string, endpoint: GoogleCachedContentEndpointConfig): void {
    const workspaceStates = this.#capabilityByWorkspace.get(workspaceKey);
    if (!workspaceStates) {
      return;
    }
    workspaceStates.delete(buildEndpointKey(endpoint));
    if (workspaceStates.size === 0) {
      this.#capabilityByWorkspace.delete(workspaceKey);
    }
  }

  #maybeRecoverCapabilityAfterCredentialChange(
    workspaceKey: string,
    endpoint: GoogleCachedContentEndpointConfig,
    credential: string,
  ): GoogleCachedContentCapabilityState {
    const state = this.#getCapabilityState(workspaceKey, endpoint);
    if (
      state.status !== "unsupported" ||
      !isAuthCapabilityReason(state.reason) ||
      !state.authFailureCredentialFingerprint
    ) {
      return state;
    }
    const nextCredentialFingerprint = fingerprintGoogleCredential(credential);
    if (
      !nextCredentialFingerprint ||
      nextCredentialFingerprint === state.authFailureCredentialFingerprint
    ) {
      return state;
    }
    this.#resetCapabilityState(workspaceKey, endpoint);
    return this.#getCapabilityState(workspaceKey, endpoint);
  }

  #getSessionBinding(workspaceKey: string, sessionId: string): string | undefined {
    return this.#getBindings(workspaceKey).get(sessionId);
  }

  #maybeDropWorkspace(workspaceKey: string): void {
    const records = this.#recordsByWorkspace.get(workspaceKey);
    const bindings = this.#sessionBindings.get(workspaceKey);
    const pendingDeletes = this.#pendingDeletesByWorkspace.get(workspaceKey);
    const inflightCreates = this.#inflightCreatesByWorkspace.get(workspaceKey);
    if (
      (records?.size ?? 0) > 0 ||
      (bindings?.size ?? 0) > 0 ||
      (pendingDeletes?.size ?? 0) > 0 ||
      (inflightCreates?.size ?? 0) > 0
    ) {
      return;
    }
    this.dropWorkspace(workspaceKey);
  }
}

function asGoogleCachedContentPayload(value: unknown): GoogleCachedContentPayload | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const model = (value as { model?: unknown }).model;
  const request = (value as { request?: unknown }).request;
  if (typeof model !== "string" || !request || typeof request !== "object") {
    return undefined;
  }
  return value as GoogleCachedContentPayload;
}

function withCachedContent(
  payload: GoogleCachedContentPayload,
  cachedContentName: string,
): GoogleCachedContentPayload {
  const {
    systemInstruction: _systemInstruction,
    system_instruction: _systemInstructionSnake,
    tools: _tools,
    toolConfig: _toolConfig,
    tool_config: _toolConfigSnake,
    cachedContent: _cachedContent,
    cached_content: _cachedContentSnake,
    ...rest
  } = payload.request;
  return {
    ...payload,
    request: {
      ...rest,
      cachedContent: cachedContentName,
    },
  };
}

function buildPrefixHash(payload: GoogleCachedContentPayload): string {
  // CachedContent identity is the stable prefix only. Generation controls intentionally stay
  // out of this hash so temperature/topP changes do not fragment reusable prefix resources.
  return redactedStableJsonSha256Hex(buildStablePrefixMaterial(payload));
}

function estimateCachedContentTokens(payload: GoogleCachedContentPayload): number {
  return estimateStructuredTokenCount(
    redactedStableJsonStringify(buildStablePrefixMaterial(payload)),
    {
      api: "google-gemini-cli",
      modelId: payload.model,
    },
  );
}

function buildStablePrefixMaterial(payload: GoogleCachedContentPayload): Record<string, unknown> {
  return {
    model: payload.model,
    systemInstruction:
      payload.request["systemInstruction"] ?? payload.request["system_instruction"] ?? null,
    tools: payload.request["tools"] ?? null,
    toolConfig: payload.request["toolConfig"] ?? payload.request["tool_config"] ?? null,
  };
}

function resolveGoogleCachedContentMinimumTokens(model: string): number {
  return model.toLowerCase().includes("pro")
    ? GOOGLE_CACHED_CONTENT_PRO_MINIMUM_TOKENS
    : GOOGLE_CACHED_CONTENT_DEFAULT_MINIMUM_TOKENS;
}

function buildEndpointKey(endpoint: GoogleCachedContentEndpointConfig): string {
  return `${endpoint.baseUrl}|${endpoint.location}|${endpoint.apiVersion}`;
}

function parseExpireAt(expireTime: string | undefined, ttlSeconds: number): number {
  if (expireTime) {
    const parsed = Date.parse(expireTime);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now() + ttlSeconds * 1000;
}

function normalizeWorkspaceKey(workspaceRoot: string): string {
  return workspaceRoot.trim() || ".";
}

function normalizeErrorReason(error: unknown): string {
  if (error instanceof GoogleCachedContentError) {
    if (error.code.trim().length > 0) {
      return `google_cached_content_${error.code}`;
    }
  }
  if (error instanceof Error) {
    if (error.message.trim().length > 0) {
      return normalizeReason(error.message);
    }
  }
  return "google_cached_content_unknown_error";
}

function tryResolveGoogleCachedContentEndpoint(
  input: Partial<GoogleCachedContentEndpointConfig>,
):
  | { ok: true; endpoint: GoogleCachedContentEndpointConfig }
  | { ok: false; reason: "google_cached_content_invalid_endpoint_config" } {
  try {
    return { ok: true, endpoint: resolveGoogleCachedContentEndpoint(input) };
  } catch {
    return { ok: false, reason: "google_cached_content_invalid_endpoint_config" };
  }
}

function normalizeReason(reason: string): string {
  return reason.trim().replace(/\s+/g, "_").toLowerCase();
}

function shouldMemoizeCapabilityFailure(error: unknown): boolean {
  if (!(error instanceof GoogleCachedContentError)) {
    return false;
  }
  const code = error.code;
  return (
    code === "vertex_unauthorized" ||
    code === "vertex_forbidden" ||
    code === "vertex_endpoint_not_found" ||
    code === "vertex_invalid_request"
  );
}

function isAuthCapabilityReason(reason: string | undefined): boolean {
  return (
    reason === "google_cached_content_vertex_unauthorized" ||
    reason === "google_cached_content_vertex_forbidden"
  );
}

function fingerprintGoogleCredential(credential: string | undefined): string | undefined {
  if (typeof credential !== "string") {
    return undefined;
  }
  try {
    const parsed = parseGoogleGeminiCliCredential(credential);
    return redactedStableJsonSha256Hex({
      token: parsed.token,
      projectId: parsed.projectId,
    });
  } catch {
    const normalized = credential.trim();
    return normalized.length > 0 ? sha256Hex(normalized) : undefined;
  }
}

function unsupportedGoogleCachedContentRender(input: {
  sessionId: string;
  policy: ProviderCachePolicy;
  reason: string;
}): ProviderCacheRenderResult {
  return {
    ...resolveGoogleGeminiCliCacheRender({
      sessionId: input.sessionId,
      policy: input.policy,
    }),
    status: "unsupported",
    reason: input.reason,
    renderedRetention: "none",
    bucketKey: buildRenderBucketKey({
      api: "google-gemini-cli",
      sessionId: input.sessionId,
      retention: "none",
      writeMode: input.policy.writeMode,
    }),
  };
}

function degradedGoogleImplicitPrefixRender(input: {
  sessionId: string;
  policy: ProviderCachePolicy;
  reason: string;
}): ProviderCacheRenderResult {
  return {
    ...resolveGoogleGeminiCliCacheRender({
      sessionId: input.sessionId,
      policy: {
        ...input.policy,
        retention: "short",
        reason: "provider_fallback",
      },
    }),
    status: "degraded",
    reason: input.reason,
  };
}
