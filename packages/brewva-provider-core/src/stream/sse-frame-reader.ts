import { createParser, type EventSourceMessage, type ParseError } from "eventsource-parser";

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

export interface SseFrameReaderOptions {
  signal?: AbortSignal;
  ignoreParseErrors?: boolean;
}

function resolveEventName(message: EventSourceMessage): string | undefined {
  if ("event" in message && typeof message.event === "string" && message.event.length > 0) {
    return message.event;
  }
  if ("name" in message && typeof message.name === "string" && message.name.length > 0) {
    return message.name;
  }
  return undefined;
}

export async function* readSseFrames(
  source: Response | ReadableStream<Uint8Array>,
  options: SseFrameReaderOptions = {},
): AsyncGenerator<SseFrame> {
  const body = source instanceof Response ? source.body : source;
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const pendingFrames: SseFrame[] = [];
  let pendingError: ParseError | null = null;
  const abortHandler = () => {
    void reader.cancel().catch(() => {});
  };
  options.signal?.addEventListener("abort", abortHandler);
  const parser = createParser({
    onEvent(event) {
      pendingFrames.push({
        id: event.id || undefined,
        event: resolveEventName(event),
        data: event.data,
      });
    },
    onError(error) {
      if (!options.ignoreParseErrors) {
        pendingError = error;
      }
    },
  });

  try {
    while (true) {
      if (options.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) {
        parser.feed(decoder.decode());
        parser.feed("\n\n");
      } else {
        parser.feed(decoder.decode(value, { stream: true }));
      }
      if (pendingError) {
        throw pendingError;
      }
      while (pendingFrames.length > 0) {
        yield pendingFrames.shift()!;
      }
      if (done) {
        return;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abortHandler);
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}
