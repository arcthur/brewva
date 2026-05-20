import { describe, expect, test } from "bun:test";
import { runPromiseAtBoundary } from "@brewva/brewva-effect";
import { BrewvaFiber, BrewvaLayer, BrewvaStream } from "@brewva/brewva-effect/primitives";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type { Model } from "@brewva/brewva-provider-core/contracts";
import type { ProviderAssistantMessageStream } from "@brewva/brewva-provider-core/contracts";
import { ProviderRuntime, providerRuntimeLayer } from "@brewva/brewva-provider-core/contracts";
import { runProviderStream } from "../../../packages/brewva-provider-core/src/stream/run-provider-stream.js";
import { sleep } from "../../helpers/process.js";

const model: Model<"openai-responses"> = {
  id: "gpt-4o",
  name: "GPT-4o",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 4096,
};

async function collectEvents(stream: ProviderAssistantMessageStream) {
  return runPromiseAtBoundary(
    stream.pipe(BrewvaStream.runCollect, BrewvaEffect.provide(providerRuntimeLayer)),
  );
}

describe("provider stream runner", () => {
  test("finishes composer-owned text and tool call blocks before done", async () => {
    const stream = runProviderStream(model, (session) =>
      BrewvaEffect.gen(function* () {
        yield* session.composer.blocks.appendText("hello");
        yield* session.composer.toolCalls.begin("call", {
          id: "call_1",
          name: "search",
          arguments: {},
        });
        yield* session.composer.toolCalls.appendArgumentsDelta("call", '{"query":"needle"}');
        session.output.stopReason = "toolUse";
      }),
    );

    const events = await collectEvents(stream);
    expect("result" in stream).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
      "text_end",
      "toolcall_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "toolUse",
    });
  });

  test("links Effect stream interruption to the provider session signal", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedAbort = false;

    const stream = runProviderStream(model, (session) =>
      BrewvaEffect.gen(function* () {
        yield* session.ensureStarted();
        markStarted();
        yield* BrewvaEffect.tryPromise({
          try: () =>
            new Promise<void>((_resolve, reject) => {
              session.signal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
      }),
    );

    const fiber = BrewvaEffect.runFork(
      stream.pipe(BrewvaStream.runDrain, BrewvaEffect.provide(providerRuntimeLayer)),
    );

    await started;
    await BrewvaEffect.runPromise(BrewvaFiber.interrupt(fiber));

    expect(observedAbort).toBe(true);
  });

  test("awaits Effect stream queue backpressure before provider drivers continue", async () => {
    const runtimeLayer = BrewvaLayer.succeed(ProviderRuntime)({ streamBufferSize: 1 });
    let releaseFirstConsumer!: () => void;
    const firstConsumerBlocked = new Promise<void>((resolve) => {
      releaseFirstConsumer = resolve;
    });
    let markThirdPushStarted!: () => void;
    const thirdPushStarted = new Promise<void>((resolve) => {
      markThirdPushStarted = resolve;
    });
    const order: string[] = [];

    const stream = runProviderStream(
      model,
      (session) =>
        BrewvaEffect.gen(function* () {
          yield* session.ensureStarted();
          order.push("pushed:start");
          yield* session.stream.push({
            type: "text_start",
            contentIndex: 0,
            partial: session.output,
          });
          order.push("pushed:first");
          markThirdPushStarted();
          yield* session.stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "hello",
            partial: session.output,
          });
          order.push("pushed:second");
        }),
      { startMode: "lazy" },
    );

    const drain = runPromiseAtBoundary(
      stream.pipe(
        BrewvaStream.runForEach((event) =>
          BrewvaEffect.promise(async () => {
            order.push(`consumed:${event.type}`);
            if (event.type === "start") {
              await firstConsumerBlocked;
            }
          }),
        ),
        BrewvaEffect.provide(runtimeLayer),
      ),
    );

    await thirdPushStarted;
    await sleep(0);

    expect(order).toContain("pushed:start");
    expect(order).toContain("pushed:first");
    expect(order).not.toContain("pushed:second");

    releaseFirstConsumer();
    await drain;

    expect(order).toContain("pushed:second");
  });
});
