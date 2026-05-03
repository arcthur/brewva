import type { Api, AssistantMessage, Model, Tool } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { createAssistantMessage, resetAssistantMessage } from "./assistant-message.js";
import { ProviderStreamingComposer } from "./stream-composer.js";
import type { StreamingParseRegistry } from "./streaming-parse-types.js";
import { createStreamingParseRegistry, EMPTY_PARSE_REGISTRY } from "./typebox-partialize.js";

export interface ProviderStreamSession<TApi extends Api> {
  stream: AssistantMessageEventStream;
  output: AssistantMessage;
  composer: ProviderStreamingComposer;
  ensureStarted(): void;
  resetOutput(): void;
}

interface RunProviderStreamOptions {
  signal?: AbortSignal;
  startMode?: "eager" | "lazy";
  /** Tool definitions for streaming parse schema derivation. */
  tools?: Tool[];
}

export function runProviderStream<TApi extends Api>(
  model: Model<TApi>,
  run: (session: ProviderStreamSession<TApi>) => Promise<void>,
  options: RunProviderStreamOptions = {},
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const output = createAssistantMessage(model);
  let started = false;
  const ensureStarted = () => {
    if (started) {
      return;
    }
    started = true;
    stream.push({ type: "start", partial: output });
  };

  const parseRegistry: StreamingParseRegistry =
    options.tools && options.tools.length > 0
      ? createStreamingParseRegistry(options.tools)
      : EMPTY_PARSE_REGISTRY;

  let composer = new ProviderStreamingComposer(output, stream, ensureStarted, parseRegistry);
  const resetOutput = () => {
    resetAssistantMessage(output);
    started = false;
    composer = new ProviderStreamingComposer(output, stream, ensureStarted, parseRegistry);
  };
  const session: ProviderStreamSession<TApi> = {
    stream,
    output,
    get composer() {
      return composer;
    },
    ensureStarted,
    resetOutput,
  };

  void (async () => {
    try {
      if (options.startMode !== "lazy") {
        ensureStarted();
      }
      await run(session);
      if (options.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      session.composer.finishAll();
      ensureStarted();
      const reason = output.stopReason;
      if (reason === "aborted" || reason === "error") {
        throw new Error(output.errorMessage || `Provider returned ${reason} stop reason`);
      }
      stream.push({
        type: "done",
        reason,
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}
