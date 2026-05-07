import { describe, expect, test } from "bun:test";
import type { Api, Context, Model } from "@brewva/brewva-provider-core/contracts";
import {
  clearApiProviders,
  registerExternalApiProvider,
  registerTypedApiProvider,
} from "@brewva/brewva-provider-core/registry";
import { complete } from "../../../packages/brewva-provider-core/src/stream/index.js";
import {
  createProviderDoneStream,
  createProviderEventStream,
} from "../../helpers/effect-stream.js";

const doneMessage = { role: "assistant", content: [] } as never;

describe("provider core stream routing", () => {
  test("routes built-in typed APIs through the typed registry seam", async () => {
    clearApiProviders();
    const seenOptions: Array<{ reasoningEffort?: string }> = [];

    registerTypedApiProvider({
      api: "openai-responses",
      stream(_model, _context, options) {
        seenOptions.push({ reasoningEffort: options?.reasoningEffort });
        return createProviderDoneStream(doneMessage);
      },
      streamSimple() {
        return createProviderEventStream();
      },
    });

    await complete({ api: "openai-responses" } as Model<"openai-responses">, {} as Context, {
      reasoningEffort: "high",
    });

    expect(seenOptions).toEqual([{ reasoningEffort: "high" }]);
    clearApiProviders();
  });

  test("keeps external providers on the generic stream options seam", async () => {
    clearApiProviders();
    const seenOptions: Array<{ temperature?: number }> = [];

    registerExternalApiProvider({
      api: "external-stream-provider",
      stream(_model, _context, options) {
        seenOptions.push({ temperature: options?.temperature });
        return createProviderDoneStream(doneMessage);
      },
      streamSimple() {
        return createProviderEventStream();
      },
    });

    await complete({ api: "external-stream-provider" } as Model<Api>, {} as Context, {
      temperature: 0.25,
    });

    expect(seenOptions).toEqual([{ temperature: 0.25 }]);
    clearApiProviders();
  });
});
