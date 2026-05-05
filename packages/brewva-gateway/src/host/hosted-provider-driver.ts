import type { Api, Model } from "@brewva/brewva-provider-core/contracts";
import { completeSimple } from "@brewva/brewva-provider-core/stream";
import {
  type BrewvaProviderCompletionDriver,
  type BrewvaProviderCompletionResponse,
  UnsupportedBrewvaProviderApiError,
} from "@brewva/brewva-substrate/provider";

function isProviderUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("No API provider registered for api:") ||
      error.message.startsWith("No external API provider registered for api:") ||
      error.message.startsWith("No typed API provider registered for api:"))
  );
}

class HostedProviderCoreCompletionDriver implements BrewvaProviderCompletionDriver {
  async complete(input: Parameters<BrewvaProviderCompletionDriver["complete"]>[0]) {
    try {
      const message = await completeSimple(
        input.model as Model<Api>,
        {
          systemPrompt: input.systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: input.userText }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: input.auth.apiKey,
          headers: input.auth.headers,
        },
      );
      return {
        role: message.role,
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        timestamp: message.timestamp,
        usage: message.usage,
        content: message.content,
      } satisfies BrewvaProviderCompletionResponse;
    } catch (error) {
      if (isProviderUnavailableError(error)) {
        throw new UnsupportedBrewvaProviderApiError(input.model.api);
      }
      throw error;
    }
  }
}

const DEFAULT_HOSTED_PROVIDER_DRIVER = new HostedProviderCoreCompletionDriver();

export function createHostedProviderDriver(): BrewvaProviderCompletionDriver {
  return DEFAULT_HOSTED_PROVIDER_DRIVER;
}
