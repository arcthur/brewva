import type { Server } from "node:http";
import { TelegramWebhookTransport } from "@brewva/brewva-channels-telegram";
import { BrewvaBoundaryFailure, BrewvaEffect, runPromiseAtBoundary } from "@brewva/brewva-effect";
import { createTelegramIngressServer } from "@brewva/brewva-ingress";
import type {
  ChannelModeLaunchBundle,
  ChannelModeLauncher,
  ChannelModeLauncherInput,
} from "../../launcher.js";
import { createRuntimeTelegramChannelBridge } from "./bridge.js";
import { resolveTelegramWebhookIngressConfig } from "./webhook-config.js";

interface ChannelModeRecoveryHints {
  initialPollingOffset?: number;
}

const TELEGRAM_API_BASE_URL_ENV = "BREWVA_TELEGRAM_API_BASE_URL";

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function toChannelBootstrapFailure(error: unknown, fallbackMessage: string): BrewvaBoundaryFailure {
  if (error instanceof BrewvaBoundaryFailure) return error;
  return new BrewvaBoundaryFailure({
    message: error instanceof Error ? error.message : fallbackMessage,
    cause: error,
  });
}

function listenServerEffect(
  server: Server,
  host: string,
  port: number,
): BrewvaEffect.Effect<void, BrewvaBoundaryFailure> {
  return BrewvaEffect.callback<void, BrewvaBoundaryFailure>((resume) => {
    let settled = false;
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const complete = (effect: BrewvaEffect.Effect<void, BrewvaBoundaryFailure>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };
    const onError = (error: unknown) =>
      complete(
        BrewvaEffect.fail(
          toChannelBootstrapFailure(error, "Telegram webhook ingress server failed to listen"),
        ),
      );
    const onListening = () => complete(BrewvaEffect.void);
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      complete(
        BrewvaEffect.fail(
          toChannelBootstrapFailure(error, "Telegram webhook ingress server failed to listen"),
        ),
      );
    }
    return BrewvaEffect.sync(() => {
      cleanup();
      if (!settled && server.listening) {
        server.close();
      }
    });
  });
}

function closeServerEffect(server: Server): BrewvaEffect.Effect<void, BrewvaBoundaryFailure> {
  if (!server.listening) {
    return BrewvaEffect.void;
  }
  return BrewvaEffect.callback<void, BrewvaBoundaryFailure>((resume) => {
    server.close((error) => {
      if (error) {
        resume(
          BrewvaEffect.fail(
            toChannelBootstrapFailure(error, "Telegram webhook ingress server failed to close"),
          ),
        );
        return;
      }
      resume(BrewvaEffect.void);
    });
  });
}

export const telegramChannelLauncher: ChannelModeLauncher = (
  input: ChannelModeLauncherInput,
): ChannelModeLaunchBundle => {
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
      await runPromiseAtBoundary(
        listenServerEffect(ingressServer, webhookIngress.host, webhookIngress.port),
      );
      ingressStarted = true;
      input.runtime.extensions.hosted.events.record({
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
      await runPromiseAtBoundary(closeServerEffect(ingressServer));
      ingressStarted = false;
      input.runtime.extensions.hosted.events.record({
        sessionId: "channel:system",
        type: "channel_ingress_stopped",
        payload: {
          channel: "telegram",
        },
        skipTapeCheckpoint: true,
      });
    },
  };
};
