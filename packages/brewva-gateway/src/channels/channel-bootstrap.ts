import type { Server } from "node:http";
import { TelegramWebhookTransport } from "@brewva/brewva-channels-telegram";
import { createTelegramIngressServer, type TelegramIngressAuth } from "@brewva/brewva-ingress";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  normalizeChannelId,
  type ChannelTurnBridge,
  type TurnEnvelope,
} from "@brewva/brewva-runtime/channels";
import { createRuntimeTelegramChannelBridge } from "../runtime-plugins/index.js";

export interface TelegramChannelModeConfig {
  token?: string;
  apiBaseUrl?: string;
  callbackSecret?: string;
  pollTimeoutSeconds?: number;
  pollLimit?: number;
  pollRetryMs?: number;
  webhook?: TelegramWebhookIngressModeConfig;
}

export interface TelegramWebhookIngressModeConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  path?: string;
  maxBodyBytes?: number;
  authMode?: "hmac" | "bearer" | "both";
  bearerToken?: string;
  hmacSecret?: string;
  hmacMaxSkewMs?: number;
  hmacNonceTtlMs?: number;
}

export interface ChannelModeConfig {
  telegram?: TelegramChannelModeConfig;
}

export const SUPPORTED_CHANNELS = ["telegram"] as const;
export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

export interface ChannelModeLaunchBundle {
  bridge: ChannelTurnBridge;
  onStart?: () => Promise<void>;
  onStop?: () => Promise<void>;
}

interface ChannelModeRecoveryHints {
  initialPollingOffset?: number;
}

export interface ChannelModeLauncherInput {
  runtime: BrewvaRuntime;
  channelConfig?: ChannelModeConfig;
  onInboundTurn: (turn: TurnEnvelope) => Promise<void>;
  onAdapterError?: (error: unknown) => Promise<void> | void;
  resolveIngestedSessionId?: (
    turn: TurnEnvelope,
  ) => Promise<string | undefined> | string | undefined;
}

export type ChannelModeLauncher = (input: ChannelModeLauncherInput) => ChannelModeLaunchBundle;

export interface ResolvedTelegramWebhookIngressConfig {
  host: string;
  port: number;
  path: string;
  maxBodyBytes?: number;
  auth: TelegramIngressAuth;
}

const TELEGRAM_WEBHOOK_ENABLED_ENV = "BREWVA_TELEGRAM_WEBHOOK_ENABLED";
const TELEGRAM_WEBHOOK_HOST_ENV = "BREWVA_TELEGRAM_INGRESS_HOST";
const TELEGRAM_WEBHOOK_PORT_ENV = "BREWVA_TELEGRAM_INGRESS_PORT";
const TELEGRAM_WEBHOOK_PATH_ENV = "BREWVA_TELEGRAM_INGRESS_PATH";
const TELEGRAM_WEBHOOK_MAX_BODY_BYTES_ENV = "BREWVA_TELEGRAM_INGRESS_MAX_BODY_BYTES";
const TELEGRAM_WEBHOOK_AUTH_MODE_ENV = "BREWVA_TELEGRAM_INGRESS_AUTH_MODE";
const TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV = "BREWVA_TELEGRAM_INGRESS_BEARER_TOKEN";
const TELEGRAM_WEBHOOK_HMAC_SECRET_ENV = "BREWVA_TELEGRAM_INGRESS_HMAC_SECRET";
const TELEGRAM_WEBHOOK_HMAC_MAX_SKEW_MS_ENV = "BREWVA_TELEGRAM_INGRESS_HMAC_MAX_SKEW_MS";
const TELEGRAM_WEBHOOK_HMAC_NONCE_TTL_MS_ENV = "BREWVA_TELEGRAM_INGRESS_NONCE_TTL_MS";
const TELEGRAM_WEBHOOK_DEFAULT_HOST = "0.0.0.0";
const TELEGRAM_WEBHOOK_DEFAULT_PORT = 8787;
const TELEGRAM_WEBHOOK_DEFAULT_PATH = "/ingest/telegram";
const TELEGRAM_API_BASE_URL_ENV = "BREWVA_TELEGRAM_API_BASE_URL";

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseOptionalInteger(
  value: number | string | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(
  value: number | string | undefined,
  fieldName: string,
): number | undefined {
  const parsed = parseOptionalInteger(value, fieldName);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) {
    throw new Error(`${fieldName} must be > 0`);
  }
  return parsed;
}

function resolveTelegramWebhookAuth(input: {
  config: TelegramWebhookIngressModeConfig | undefined;
  env: NodeJS.ProcessEnv;
}): TelegramIngressAuth {
  const authModeRaw = normalizeOptionalText(
    input.config?.authMode ?? input.env[TELEGRAM_WEBHOOK_AUTH_MODE_ENV],
  );
  const authMode = authModeRaw?.toLowerCase();
  const bearerToken = normalizeOptionalText(
    input.config?.bearerToken ?? input.env[TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV],
  );
  const hmacSecret = normalizeOptionalText(
    input.config?.hmacSecret ?? input.env[TELEGRAM_WEBHOOK_HMAC_SECRET_ENV],
  );
  const hmacMaxSkewMs = parseOptionalPositiveInteger(
    input.config?.hmacMaxSkewMs ?? input.env[TELEGRAM_WEBHOOK_HMAC_MAX_SKEW_MS_ENV],
    "telegram webhook hmac max skew",
  );
  const hmacNonceTtlMs = parseOptionalPositiveInteger(
    input.config?.hmacNonceTtlMs ?? input.env[TELEGRAM_WEBHOOK_HMAC_NONCE_TTL_MS_ENV],
    "telegram webhook hmac nonce ttl",
  );
  const hmacConfig = {
    secret: hmacSecret ?? "",
    ...(hmacMaxSkewMs !== undefined ? { maxSkewMs: hmacMaxSkewMs } : {}),
    ...(hmacNonceTtlMs !== undefined ? { nonceTtlMs: hmacNonceTtlMs } : {}),
  };
  const bearerConfig = {
    token: bearerToken ?? "",
  };

  const inferredMode =
    authMode ??
    (() => {
      if (bearerToken && hmacSecret) return "both";
      if (hmacSecret) return "hmac";
      if (bearerToken) return "bearer";
      return "";
    })();

  if (inferredMode === "hmac") {
    if (!hmacSecret) {
      throw new Error(`${TELEGRAM_WEBHOOK_HMAC_SECRET_ENV} is required for webhook hmac mode`);
    }
    return {
      mode: "hmac",
      hmac: hmacConfig,
    };
  }
  if (inferredMode === "bearer") {
    if (!bearerToken) {
      throw new Error(`${TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV} is required for webhook bearer mode`);
    }
    return {
      mode: "bearer",
      bearer: bearerConfig,
    };
  }
  if (inferredMode === "both") {
    if (!bearerToken || !hmacSecret) {
      throw new Error(
        `${TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV} and ${TELEGRAM_WEBHOOK_HMAC_SECRET_ENV} are required for webhook both mode`,
      );
    }
    return {
      mode: "both",
      bearer: bearerConfig,
      hmac: hmacConfig,
    };
  }

  throw new Error(
    `telegram webhook auth is not configured; set ${TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV} and/or ${TELEGRAM_WEBHOOK_HMAC_SECRET_ENV}`,
  );
}

export function resolveTelegramWebhookIngressConfig(
  telegram: TelegramChannelModeConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTelegramWebhookIngressConfig | null {
  const webhook = telegram?.webhook;
  const envEnabled = isTruthyFlag(env[TELEGRAM_WEBHOOK_ENABLED_ENV]);
  const configEnabled = webhook?.enabled === true;
  const explicitPort = parseOptionalPositiveInteger(
    webhook?.port ?? env[TELEGRAM_WEBHOOK_PORT_ENV],
    "telegram webhook ingress port",
  );
  const enabled = configEnabled || envEnabled || explicitPort !== undefined;
  if (!enabled) {
    return null;
  }

  const host =
    normalizeOptionalText(webhook?.host ?? env[TELEGRAM_WEBHOOK_HOST_ENV]) ??
    TELEGRAM_WEBHOOK_DEFAULT_HOST;
  const port = explicitPort ?? TELEGRAM_WEBHOOK_DEFAULT_PORT;
  if (port > 65535) {
    throw new Error("telegram webhook ingress port must be <= 65535");
  }
  const path =
    normalizeOptionalText(webhook?.path ?? env[TELEGRAM_WEBHOOK_PATH_ENV]) ??
    TELEGRAM_WEBHOOK_DEFAULT_PATH;
  const maxBodyBytes = parseOptionalPositiveInteger(
    webhook?.maxBodyBytes ?? env[TELEGRAM_WEBHOOK_MAX_BODY_BYTES_ENV],
    "telegram webhook max body bytes",
  );

  return {
    host,
    port,
    path,
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    auth: resolveTelegramWebhookAuth({
      config: webhook,
      env,
    }),
  };
}

function listenServer(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function resolveSupportedChannel(raw: string): SupportedChannel | null {
  const normalized = normalizeChannelId(raw);
  return (SUPPORTED_CHANNELS as readonly string[]).includes(normalized)
    ? (normalized as SupportedChannel)
    : null;
}

export function formatSupportedChannels(): string {
  return SUPPORTED_CHANNELS.join(", ");
}

export const DEFAULT_CHANNEL_LAUNCHERS: Record<SupportedChannel, ChannelModeLauncher> = {
  telegram: (input) => {
    const recovery = (
      input as ChannelModeLauncherInput & {
        recovery?: ChannelModeRecoveryHints;
      }
    ).recovery;
    const telegram = input.channelConfig?.telegram;
    const telegramToken = normalizeText(telegram?.token);
    if (!telegramToken) {
      throw new Error("--telegram-token is required when --channel telegram is set.");
    }
    const apiBaseUrl = normalizeOptionalText(
      telegram?.apiBaseUrl ?? process.env[TELEGRAM_API_BASE_URL_ENV],
    );
    const callbackSecret = normalizeText(telegram?.callbackSecret) || undefined;
    const webhookIngress = resolveTelegramWebhookIngressConfig(telegram);
    if (!webhookIngress) {
      return createRuntimeTelegramChannelBridge({
        runtime: input.runtime,
        token: telegramToken,
        adapter: {
          inbound: {
            callbackSecret,
          },
          outbound: {
            callbackSecret,
          },
        },
        transport: {
          ...(apiBaseUrl ? { apiBaseUrl } : {}),
          ...(recovery?.initialPollingOffset !== undefined
            ? { initialOffset: recovery.initialPollingOffset }
            : {}),
          poll: {
            timeoutSeconds: telegram?.pollTimeoutSeconds,
            limit: telegram?.pollLimit,
            retryDelayMs: telegram?.pollRetryMs,
          },
        },
        resolveIngestedSessionId: input.resolveIngestedSessionId,
        onInboundTurn: input.onInboundTurn,
        onAdapterError: input.onAdapterError,
      });
    }

    const webhookTransport = new TelegramWebhookTransport({
      token: telegramToken,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      onError: input.onAdapterError,
    });
    const bridgeBundle = createRuntimeTelegramChannelBridge({
      runtime: input.runtime,
      transportInstance: webhookTransport,
      adapter: {
        inbound: {
          callbackSecret,
        },
        outbound: {
          callbackSecret,
        },
      },
      resolveIngestedSessionId: input.resolveIngestedSessionId,
      onInboundTurn: input.onInboundTurn,
      onAdapterError: input.onAdapterError,
    });

    const ingressServer = createTelegramIngressServer({
      auth: webhookIngress.auth,
      path: webhookIngress.path,
      maxBodyBytes: webhookIngress.maxBodyBytes,
      onUpdate: async (update) => {
        const accepted = await webhookTransport.ingest(update);
        if (!accepted.accepted) {
          throw new Error("telegram webhook transport is not running");
        }
      },
      onError: input.onAdapterError,
    });

    let ingressStarted = false;
    return {
      ...bridgeBundle,
      onStart: async () => {
        if (ingressStarted) return;
        await listenServer(ingressServer, webhookIngress.host, webhookIngress.port);
        ingressStarted = true;
        input.runtime.events.record({
          sessionId: "channel:system",
          type: "channel_ingress_started",
          payload: {
            channel: "telegram",
            host: webhookIngress.host,
            port: webhookIngress.port,
            path: webhookIngress.path,
            authMode: webhookIngress.auth.mode,
          },
          skipTapeCheckpoint: true,
        });
      },
      onStop: async () => {
        if (!ingressStarted) return;
        await closeServer(ingressServer);
        ingressStarted = false;
        input.runtime.events.record({
          sessionId: "channel:system",
          type: "channel_ingress_stopped",
          payload: {
            channel: "telegram",
          },
          skipTapeCheckpoint: true,
        });
      },
    };
  },
};
