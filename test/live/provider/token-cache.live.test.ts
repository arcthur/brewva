import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createGoogleCachedContent,
  deleteGoogleCachedContent,
} from "@brewva/brewva-provider-core/cache";
import { getModel } from "@brewva/brewva-provider-core/catalog";
import type {
  AssistantMessage,
  Context,
  Model,
  ProviderPayloadMetadata,
  StreamOptions,
} from "@brewva/brewva-provider-core/contracts";
import { complete } from "@brewva/brewva-provider-core/stream";
import { resolveBrewvaAgentDir } from "@brewva/brewva-runtime";
import { hasProviderRateLimitText } from "../../helpers/cli.js";
import { runLive } from "../../helpers/live.js";
import { repoRoot } from "../../helpers/workspace.js";

const LIVE_MODEL_ID = process.env.BREWVA_LIVE_CACHE_MODEL || "gpt-5.4";
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
const CACHE_ANCHOR = Array.from(
  { length: 900 },
  (_, index) =>
    `cache-anchor-${String(index).padStart(4, "0")}: Preserve this deterministic prefix for provider prompt-cache live verification.`,
).join("\n");

const MODEL = getModel("openai-codex", LIVE_MODEL_ID as never) as Model<"openai-codex-responses">;
const KIMI_CODE_MODEL = getModel("kimi-coding", "kimi-for-coding");
const MOONSHOT_CN_MODEL = getModel("moonshot-cn", "kimi-k2.6");
const DEEPSEEK_MODEL = getModel("deepseek", "deepseek-v4-flash");
const GOOGLE_CACHE_MODEL_ID = process.env.BREWVA_LIVE_GOOGLE_CACHE_MODEL || "gemini-2.5-pro";
const GOOGLE_CACHE_MODEL = getModel(
  "google",
  GOOGLE_CACHE_MODEL_ID as never,
) as Model<"google-gemini-cli">;

type CodexAuthCredential = {
  type?: unknown;
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  access?: unknown;
  refresh?: unknown;
  expires?: unknown;
};

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

async function refreshCodexAccessToken(
  authPath: string,
  credential: CodexAuthCredential,
): Promise<string | undefined> {
  const refreshToken = readString(credential.refreshToken) ?? readString(credential.refresh);
  if (!refreshToken) {
    return readString(credential.accessToken) ?? readString(credential.access);
  }

  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  const accessToken = readString(payload.access_token);
  if (!accessToken) {
    throw new Error("Token refresh response was missing access_token.");
  }

  const expiresInSeconds = readFiniteNumber(payload.expires_in);
  const nextCredential = {
    ...credential,
    type: "oauth",
    accessToken,
    refreshToken: readString(payload.refresh_token) ?? refreshToken,
    expiresAt:
      typeof expiresInSeconds === "number"
        ? Date.now() + Math.max(0, expiresInSeconds) * 1000
        : undefined,
  };
  const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
  raw["openai-codex"] = {
    ...nextCredential,
    access: nextCredential.accessToken,
    refresh: nextCredential.refreshToken,
    expires: nextCredential.expiresAt,
  };
  writeFileSync(authPath, JSON.stringify(raw, null, 2), "utf8");
  return accessToken;
}

async function readCodexAccessTokenFromAuthFile(authPath: string): Promise<string | undefined> {
  if (!existsSync(authPath)) {
    return undefined;
  }
  const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
  const credential = raw["openai-codex"] as CodexAuthCredential | undefined;
  if (!credential || credential.type !== "oauth") {
    return undefined;
  }
  const accessToken = readString(credential.accessToken) ?? readString(credential.access);
  const expiresAt = readFiniteNumber(credential.expiresAt) ?? readFiniteNumber(credential.expires);
  if (accessToken && (!expiresAt || expiresAt > Date.now() + 60_000)) {
    return accessToken;
  }
  return refreshCodexAccessToken(authPath, credential);
}

async function resolveCodexAccessToken(): Promise<string | undefined> {
  const explicit = process.env.OPENAI_CODEX_ACCESS_TOKEN || process.env.BREWVA_OPENAI_CODEX_TOKEN;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  for (const agentDir of [resolveBrewvaAgentDir(), join(repoRoot, ".brewva", "agent")]) {
    const token = await readCodexAccessTokenFromAuthFile(join(agentDir, "auth.json"));
    if (token) {
      return token;
    }
  }
  return undefined;
}

async function resolveGoogleCacheCredential(): Promise<string | undefined> {
  const explicit = process.env.BREWVA_GOOGLE_GEMINI_CREDENTIAL;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  for (const agentDir of [resolveBrewvaAgentDir(), join(repoRoot, ".brewva", "agent")]) {
    const credential = readGoogleCredentialFromAuthFile(join(agentDir, "auth.json"));
    if (credential) {
      return credential;
    }
  }
  return undefined;
}

function readGoogleCredentialFromAuthFile(authPath: string): string | undefined {
  if (!existsSync(authPath)) {
    return undefined;
  }
  const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
  for (const key of ["google", "google-gemini-cli"] as const) {
    const credential = raw[key];
    const resolved = resolveGoogleCredentialRecord(credential);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function resolveGoogleCredentialRecord(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "api_key" && typeof record.key === "string" && record.key.trim().length > 0) {
    return record.key.trim();
  }
  const token =
    readString(record.token) ?? readString(record.accessToken) ?? readString(record.access);
  const projectId = readString(record.projectId) ?? readString(record.project);
  if (token && projectId) {
    return JSON.stringify({ token, projectId });
  }
  return undefined;
}

function formatProviderSkip(label: string, error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (
    hasProviderRateLimitText(message) ||
    /no api key|token refresh failed|failed to extract accountid|unauthorized|forbidden|usage limit/i.test(
      message,
    ) ||
    /authentication_error|invalid api key|api key appears to be invalid/i.test(message)
  ) {
    return `[${label}] skipped because provider auth/quota is unavailable: ${message}`;
  }
  return undefined;
}

function userMessage(text: string): Context["messages"][number] {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function messageText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function runCodexTurn(input: {
  apiKey: string;
  context: Context;
  sessionId: string;
  transport: "sse" | "websocket";
  previousResponseId?: string;
}): Promise<AssistantMessage> {
  const options: StreamOptions & {
    previousResponseId?: string;
    textVerbosity?: "low" | "medium" | "high";
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
    reasoningSummary?: "auto" | "detailed" | "concise" | null;
  } = {
    apiKey: input.apiKey,
    sessionId: input.sessionId,
    transport: input.transport,
    previousResponseId: input.previousResponseId,
    textVerbosity: "low",
    reasoningEffort: "low",
    reasoningSummary: "auto",
    cachePolicy: {
      retention: "short",
      writeMode: "readWrite",
      scope: "session",
      reason: "live_test",
    },
  };
  const message = await complete(MODEL, input.context, options);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || `Provider ended with ${message.stopReason}`);
  }
  return message;
}

function hasExplicitProviderCacheField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasExplicitProviderCacheField(item));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if ("cache_control" in record || "prompt_cache_key" in record || "cachePoint" in record) {
    return true;
  }
  return Object.values(record).some((item) => hasExplicitProviderCacheField(item));
}

async function runOpenAICompatTurn(input: {
  apiKey: string;
  model: Model<"openai-completions">;
  marker: string;
  systemPrompt?: string;
}): Promise<{
  message: AssistantMessage;
  payload: unknown;
  metadata: ProviderPayloadMetadata | undefined;
}> {
  let capturedPayload: unknown;
  let capturedMetadata: ProviderPayloadMetadata | undefined;
  const message = await complete(
    input.model,
    {
      systemPrompt:
        input.systemPrompt ??
        "Reply with the exact marker requested by the user and no extra text.",
      messages: [userMessage(`Reply exactly: ${input.marker}`)],
    },
    {
      apiKey: input.apiKey,
      maxTokens: 64,
      cachePolicy: {
        retention: "short",
        writeMode: "readWrite",
        scope: "session",
        reason: "live_test",
      },
      onPayload(payload, _model, metadata) {
        capturedPayload = structuredClone(payload);
        capturedMetadata = metadata;
        return payload;
      },
    },
  );
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || `Provider ended with ${message.stopReason}`);
  }
  return { message, payload: capturedPayload, metadata: capturedMetadata };
}

async function runGoogleCachedContentTurn(input: {
  apiKey: string;
  cachedContent: string;
  marker: string;
}): Promise<AssistantMessage> {
  const message = await complete(
    GOOGLE_CACHE_MODEL,
    {
      messages: [userMessage(`Reply exactly: ${input.marker}`)],
    },
    {
      apiKey: input.apiKey,
      maxTokens: 64,
      cachePolicy: {
        retention: "long",
        writeMode: "readWrite",
        scope: "session",
        reason: "live_test",
      },
      onPayload(payload) {
        const basePayload = payload as Record<string, unknown>;
        const request = (payload as { request?: Record<string, unknown> }).request;
        if (!request) {
          return payload;
        }
        const {
          systemInstruction: _systemInstruction,
          tools: _tools,
          toolConfig: _toolConfig,
          ...rest
        } = request;
        return {
          ...basePayload,
          request: {
            ...rest,
            cachedContent: input.cachedContent,
          },
        };
      },
    },
  );
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || `Provider ended with ${message.stopReason}`);
  }
  return message;
}

describe("live: provider token cache", () => {
  runLive(
    "gpt-5.4 reports prompt cache reads after a stable Codex prefix is warmed",
    async () => {
      let apiKey: string | undefined;
      try {
        apiKey = await resolveCodexAccessToken();
      } catch (error) {
        const skipMessage = formatProviderSkip("token-cache.live auth", error);
        if (skipMessage) {
          console.warn(skipMessage);
          return;
        }
        throw error;
      }
      if (!apiKey) {
        console.warn("[token-cache.live] skipped because openai-codex auth is unavailable");
        return;
      }

      const sessionId = `cache-live-${randomUUID()}`;
      const systemPrompt = [
        "You are a cache verification responder.",
        "Follow the user's exact reply instruction and do not add extra text.",
        CACHE_ANCHOR,
      ].join("\n");

      let first: AssistantMessage;
      try {
        first = await runCodexTurn({
          apiKey,
          sessionId,
          transport: "sse",
          context: {
            systemPrompt,
            messages: [userMessage("Reply exactly: CACHE-LIVE-WARMED")],
          },
        });
      } catch (error) {
        const skipMessage = formatProviderSkip("token-cache.live warmup", error);
        if (skipMessage) {
          console.warn(skipMessage);
          return;
        }
        throw error;
      }
      expect(messageText(first)).toContain("CACHE-LIVE-WARMED");

      const cacheReadAttempts: AssistantMessage[] = [];
      for (const marker of ["CACHE-LIVE-HIT-1", "CACHE-LIVE-HIT-2"] as const) {
        try {
          const message = await runCodexTurn({
            apiKey,
            sessionId,
            transport: "sse",
            context: {
              systemPrompt,
              messages: [userMessage(`Reply exactly: ${marker}`)],
            },
          });
          cacheReadAttempts.push(message);
          if (message.usage.cacheRead > 0) {
            break;
          }
        } catch (error) {
          const skipMessage = formatProviderSkip(`token-cache.live ${marker}`, error);
          if (skipMessage) {
            console.warn(skipMessage);
            return;
          }
          throw error;
        }
      }

      expect(cacheReadAttempts.length).toBeGreaterThan(0);
      expect(
        Math.max(...cacheReadAttempts.map((message) => message.usage.cacheRead)),
      ).toBeGreaterThan(0);
    },
    180_000,
  );

  runLive(
    "gpt-5.4 accepts Codex websocket continuation with previous_response_id",
    async () => {
      let apiKey: string | undefined;
      try {
        apiKey = await resolveCodexAccessToken();
      } catch (error) {
        const skipMessage = formatProviderSkip("token-cache.live auth", error);
        if (skipMessage) {
          console.warn(skipMessage);
          return;
        }
        throw error;
      }
      if (!apiKey) {
        console.warn("[token-cache.live] skipped because openai-codex auth is unavailable");
        return;
      }

      const sessionId = `continuation-live-${randomUUID()}`;
      const systemPrompt = [
        "You are a Codex continuation verification responder.",
        "Reply with the exact marker requested by the latest user message.",
        CACHE_ANCHOR,
      ].join("\n");
      const firstUser = userMessage("Reply exactly: CONTINUATION-LIVE-ONE");

      let first: AssistantMessage;
      try {
        first = await runCodexTurn({
          apiKey,
          sessionId,
          transport: "websocket",
          context: {
            systemPrompt,
            messages: [firstUser],
          },
        });
      } catch (error) {
        const skipMessage = formatProviderSkip("token-cache.live websocket first turn", error);
        if (skipMessage) {
          console.warn(skipMessage);
          return;
        }
        throw error;
      }
      expect(first.responseId).toEqual(expect.any(String));
      expect(messageText(first)).toContain("CONTINUATION-LIVE-ONE");

      let second: AssistantMessage;
      try {
        second = await runCodexTurn({
          apiKey,
          sessionId,
          transport: "websocket",
          previousResponseId: first.responseId,
          context: {
            systemPrompt,
            messages: [firstUser, first, userMessage("Reply exactly: CONTINUATION-LIVE-TWO")],
          },
        });
      } catch (error) {
        const skipMessage = formatProviderSkip("token-cache.live websocket continuation", error);
        if (skipMessage) {
          console.warn(skipMessage);
          return;
        }
        throw error;
      }

      expect(second.responseId).toEqual(expect.any(String));
      expect(second.responseId).not.toBe(first.responseId);
      expect(messageText(second)).toContain("CONTINUATION-LIVE-TWO");
    },
    180_000,
  );

  runLive(
    "DeepSeek V4 Flash reports context cache reads after a stable prefix is warmed",
    async () => {
      const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
      if (!apiKey) {
        console.warn("[token-cache.live] skipped because DEEPSEEK_API_KEY is unavailable");
        return;
      }

      const systemPrompt = [
        "You are a DeepSeek context cache verification responder.",
        "Follow the user's exact reply instruction and do not add extra text.",
        CACHE_ANCHOR,
      ].join("\n");

      let warmup: AssistantMessage;
      try {
        warmup = (
          await runOpenAICompatTurn({
            apiKey,
            model: DEEPSEEK_MODEL,
            marker: "DEEPSEEK-CACHE-WARMED",
            systemPrompt,
          })
        ).message;
      } catch (error) {
        const skipMessage = formatProviderSkip("token-cache.live DeepSeek warmup", error);
        if (skipMessage) {
          console.warn(skipMessage);
          return;
        }
        throw error;
      }
      expect(messageText(warmup)).toContain("DEEPSEEK-CACHE-WARMED");

      const attempts: AssistantMessage[] = [];
      for (const marker of [
        "DEEPSEEK-CACHE-HIT-1",
        "DEEPSEEK-CACHE-HIT-2",
        "DEEPSEEK-CACHE-HIT-3",
      ]) {
        try {
          const result = await runOpenAICompatTurn({
            apiKey,
            model: DEEPSEEK_MODEL,
            marker,
            systemPrompt,
          });
          attempts.push(result.message);
          expect(hasExplicitProviderCacheField(result.payload)).toBe(false);
          expect(result.metadata?.cacheRender).toMatchObject({
            status: "rendered",
            renderedRetention: "short",
            reason: "rendered_openai_completions_implicit_prefix_cache",
          });
          expect(result.metadata?.cacheCapability?.reason).toBe("deepseek_context_disk_cache");
          if (result.message.usage.cacheRead > 0) {
            break;
          }
        } catch (error) {
          const skipMessage = formatProviderSkip(`token-cache.live ${marker}`, error);
          if (skipMessage) {
            console.warn(skipMessage);
            return;
          }
          throw error;
        }
      }

      expect(attempts.length).toBeGreaterThan(0);
      expect(Math.max(...attempts.map((message) => message.usage.cacheRead))).toBeGreaterThan(0);
    },
    180_000,
  );

  runLive(
    "Kimi Code accepts safe-degraded cache posture without inherited cache fields",
    async () => {
      const apiKey = process.env.KIMI_API_KEY?.trim();
      if (!apiKey) {
        console.warn("[token-cache.live] skipped because KIMI_API_KEY is unavailable");
        return;
      }

      let result: Awaited<ReturnType<typeof runOpenAICompatTurn>>;
      try {
        result = await runOpenAICompatTurn({
          apiKey,
          model: KIMI_CODE_MODEL,
          marker: "KIMI-CODE-LIVE",
        });
      } catch (error) {
        const skipMessage = formatProviderSkip("token-cache.live Kimi Code", error);
        if (skipMessage) {
          console.warn(skipMessage);
          return;
        }
        throw error;
      }

      expect(messageText(result.message)).toContain("KIMI-CODE-LIVE");
      expect(hasExplicitProviderCacheField(result.payload)).toBe(false);
      expect(result.metadata?.cacheCapability?.reason).toBe(
        "kimi_code_cache_contract_not_verified",
      );
    },
    120_000,
  );

  runLive(
    "Moonshot CN accepts OpenAI-compatible payload without inherited cache fields",
    async () => {
      const apiKey = process.env.MOONSHOT_CN_API_KEY?.trim();
      if (!apiKey) {
        console.warn("[token-cache.live] skipped because MOONSHOT_CN_API_KEY is unavailable");
        return;
      }

      let result: Awaited<ReturnType<typeof runOpenAICompatTurn>>;
      try {
        result = await runOpenAICompatTurn({
          apiKey,
          model: MOONSHOT_CN_MODEL,
          marker: "MOONSHOT-CN-LIVE",
        });
      } catch (error) {
        const skipMessage = formatProviderSkip("token-cache.live Moonshot CN", error);
        if (skipMessage) {
          console.warn(skipMessage);
          return;
        }
        throw error;
      }

      expect(messageText(result.message)).toContain("MOONSHOT-CN-LIVE");
      expect(hasExplicitProviderCacheField(result.payload)).toBe(false);
      expect(result.metadata?.cacheCapability?.reason).toBe(
        "openai_compatible_implicit_prefix_cache",
      );
    },
    120_000,
  );

  runLive(
    "google cachedContent smoke shows cache reads when Cloud Code Assist consumes explicit cached content",
    async () => {
      const credential = await resolveGoogleCacheCredential();
      if (!credential) {
        console.warn(
          "[token-cache.live] skipped because BREWVA_GOOGLE_GEMINI_CREDENTIAL is unavailable",
        );
        return;
      }

      let cached: Awaited<ReturnType<typeof createGoogleCachedContent>>;
      try {
        cached = await createGoogleCachedContent(credential, {
          model: GOOGLE_CACHE_MODEL.id,
          ttlSeconds: 3600,
          systemInstruction: {
            parts: [{ text: CACHE_ANCHOR }],
          },
        });
      } catch (error) {
        const skipMessage = formatProviderSkip(
          "token-cache.live Google cachedContent create",
          error,
        );
        if (skipMessage) {
          console.warn(skipMessage);
          return;
        }
        throw error;
      }

      try {
        const attempts: AssistantMessage[] = [];
        for (const marker of ["GOOGLE-CACHE-HIT-1", "GOOGLE-CACHE-HIT-2"] as const) {
          let message: AssistantMessage;
          try {
            message = await runGoogleCachedContentTurn({
              apiKey: credential,
              cachedContent: cached.name,
              marker,
            });
          } catch (error) {
            const skipMessage = formatProviderSkip(`token-cache.live ${marker}`, error);
            if (skipMessage) {
              console.warn(skipMessage);
              return;
            }
            throw error;
          }
          attempts.push(message);
          if (message.usage.cacheRead > 0) {
            break;
          }
        }

        expect(attempts.length).toBeGreaterThan(0);
        expect(Math.max(...attempts.map((message) => message.usage.cacheRead))).toBeGreaterThan(0);
      } finally {
        await deleteGoogleCachedContent(credential, cached.name).catch(() => undefined);
      }
    },
    180_000,
  );
});
