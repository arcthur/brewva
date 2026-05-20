import { runPromiseAtBoundary } from "@brewva/brewva-effect";
import { BrewvaEffect, BrewvaStream } from "@brewva/brewva-effect/primitives";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ProviderAssistantMessageStream,
  ProviderEventSink,
} from "@brewva/brewva-provider-core/contracts";
import { ProviderStreamError, providerRuntimeLayer } from "@brewva/brewva-provider-core/contracts";
import type {
  BrewvaAgentProtocolAssistantMessage,
  BrewvaAgentProtocolAssistantMessageEvent,
  BrewvaAgentProtocolAssistantMessageStream,
} from "@brewva/brewva-substrate/agent-protocol";

export function createProviderEventStream(
  events: readonly AssistantMessageEvent[] = [],
): ProviderAssistantMessageStream {
  return events.length > 0
    ? BrewvaStream.make(...events)
    : (BrewvaStream.empty as ProviderAssistantMessageStream);
}

export function createProviderDoneStream(
  message: AssistantMessage,
): ProviderAssistantMessageStream {
  return createProviderEventStream([{ type: "done", reason: "stop", message }]);
}

export function collectProviderEvents(
  stream: ProviderAssistantMessageStream,
): Promise<AssistantMessageEvent[]> {
  return runPromiseAtBoundary(
    stream.pipe(BrewvaStream.runCollect, BrewvaEffect.provide(providerRuntimeLayer)),
  );
}

export interface RecordingProviderEventSink {
  readonly sink: ProviderEventSink;
  readonly events: AssistantMessageEvent[];
}

export type RecordingProviderEventStream = ProviderEventSink & {
  readonly events: AssistantMessageEvent[];
};

export function createRecordingProviderEventSink(): RecordingProviderEventSink {
  const events: AssistantMessageEvent[] = [];
  return {
    events,
    sink: {
      async push(event) {
        events.push(event);
      },
      async end() {
        // Recording sinks are synchronous test probes; Effect stream completion is
        // covered by collectProviderEvents.
      },
    },
  };
}

export function createRecordingProviderEventStream(): RecordingProviderEventStream {
  const recording = createRecordingProviderEventSink();
  return Object.assign(recording.sink, { events: recording.events });
}

export function createTurnEventStream(
  events: readonly BrewvaAgentProtocolAssistantMessageEvent[] = [],
): BrewvaAgentProtocolAssistantMessageStream {
  return events.length > 0
    ? BrewvaStream.make(...events)
    : (BrewvaStream.empty as BrewvaAgentProtocolAssistantMessageStream);
}

export function createTurnDoneStream(
  message: BrewvaAgentProtocolAssistantMessage,
  events: readonly BrewvaAgentProtocolAssistantMessageEvent[] = [],
): BrewvaAgentProtocolAssistantMessageStream {
  const doneReason =
    message.stopReason === "stop" ||
    message.stopReason === "length" ||
    message.stopReason === "toolUse"
      ? message.stopReason
      : "stop";
  return createTurnEventStream([...events, { type: "done", reason: doneReason, message }]);
}

export function createTurnStreamFromPromise(
  produce: () =>
    | BrewvaAgentProtocolAssistantMessageStream
    | Promise<BrewvaAgentProtocolAssistantMessageStream>,
): BrewvaAgentProtocolAssistantMessageStream {
  return BrewvaStream.unwrap(
    BrewvaEffect.tryPromise({
      try: async () => produce(),
      catch: (error) =>
        new ProviderStreamError({
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        }),
    }),
  );
}

export function collectTurnEvents(
  stream: BrewvaAgentProtocolAssistantMessageStream,
): Promise<BrewvaAgentProtocolAssistantMessageEvent[]> {
  return runPromiseAtBoundary(
    stream.pipe(BrewvaStream.runCollect, BrewvaEffect.provide(providerRuntimeLayer)),
  );
}
