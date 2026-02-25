import type { TelegramChannelTransport } from "./adapter.js";
import { TelegramHttpTransport, type TelegramFetchLike } from "./http-transport.js";
import type { TelegramOutboundRequest, TelegramUpdate } from "./types.js";

export interface TelegramWebhookTransportOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: TelegramFetchLike;
  onError?: (error: unknown) => Promise<void> | void;
}

export interface TelegramWebhookIngestResult {
  accepted: boolean;
  reason?: "transport_not_running";
}

export class TelegramWebhookTransport implements TelegramChannelTransport {
  private running = false;
  private onUpdate: ((update: TelegramUpdate) => Promise<void>) | null = null;
  private readonly onError: ((error: unknown) => Promise<void> | void) | undefined;
  private readonly outbound: TelegramHttpTransport;

  constructor(options: TelegramWebhookTransportOptions) {
    this.onError = options.onError;
    this.outbound = new TelegramHttpTransport({
      token: options.token,
      apiBaseUrl: options.apiBaseUrl,
      fetchImpl: options.fetchImpl,
    });
  }

  async start(params: { onUpdate: (update: TelegramUpdate) => Promise<void> }): Promise<void> {
    this.running = true;
    this.onUpdate = params.onUpdate;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.onUpdate = null;
  }

  async send(request: TelegramOutboundRequest): Promise<{ providerMessageId?: string | number }> {
    return await this.outbound.send(request);
  }

  async ingest(update: TelegramUpdate): Promise<TelegramWebhookIngestResult> {
    const handler = this.onUpdate;
    if (!this.running || !handler) {
      return { accepted: false, reason: "transport_not_running" };
    }

    try {
      await handler(update);
      return { accepted: true };
    } catch (error) {
      await this.onError?.(error);
      throw error;
    }
  }
}
