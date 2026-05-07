import { describe, expect, test } from "bun:test";
import {
  BrewvaContext,
  BrewvaEffect,
  BrewvaFiber,
  BrewvaConfig,
  BrewvaConfigService,
  BrewvaLayer,
  BrewvaBoxScope,
  BrewvaProviderRequestScope,
  BrewvaSessionScope,
  BrewvaCancelled,
  BrewvaTimeout,
  BrewvaInterruptedError,
  addScopedFinalizer,
  makeBrewvaRetrySchedule,
  emptyObservabilityLayer,
  fromAbortableBoundaryPromise,
  fromBoundaryPromise,
  fromInterruptiblePromise,
  observabilityLayer,
  retryWithBrewvaPolicy,
  runEdgeOperation,
  runEdgeOperationSync,
  runPromiseAtBoundary,
  scopedResource,
  startManagedInterval,
  startScopedSchedule,
  withBrewvaObservability,
  withAbortSignal,
} from "@brewva/brewva-effect";
import { nodeFileSystemLayer } from "@brewva/brewva-effect/platform-node";
import { createBrewvaRuntimeSpine } from "@brewva/brewva-effect/runtime";
import { BrewvaTestClock, createTestRuntime } from "@brewva/brewva-effect/testing";

describe("brewva-effect foundation helpers", () => {
  test("runs boundary effects through the shared boundary runner", async () => {
    const result = await runPromiseAtBoundary(BrewvaEffect.succeed("ok"));

    expect(result).toBe("ok");
  });

  test("runs public edge operations with an owned scope and observability envelope", async () => {
    const events: string[] = [];

    const result = await runEdgeOperation(
      "brewva.test.edge",
      BrewvaEffect.gen(function* () {
        yield* addScopedFinalizer(() => {
          events.push("closed");
        });
        const span = yield* BrewvaEffect.currentSpan;
        events.push(`span:${span.name}`);
        return "done";
      }),
      {
        fields: {
          edge: "unit",
          omitted: undefined,
        },
      },
    );

    expect(result).toBe("done");
    expect(events).toEqual(["span:brewva.test.edge", "closed"]);
  });

  test("runs synchronous public edge operations through the same edge envelope", () => {
    const result = runEdgeOperationSync(
      "brewva.test.edge.sync",
      BrewvaEffect.gen(function* () {
        const span = yield* BrewvaEffect.currentSpan;
        return span.name;
      }),
    );

    expect(result).toBe("brewva.test.edge.sync");
  });

  test("wraps Promise-returning boundary callbacks in the Effect error channel", async () => {
    const error = await runPromiseAtBoundary(
      fromBoundaryPromise(() => Promise.reject(new Error("boundary failed"))).pipe(
        BrewvaEffect.flip,
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("boundary failed");
  });

  test("runs scoped finalizers when the scope closes", async () => {
    const events: string[] = [];

    await runPromiseAtBoundary(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          yield* addScopedFinalizer(() => {
            events.push("closed");
          });
          events.push("open");
        }),
      ),
    );

    expect(events).toEqual(["open", "closed"]);
  });

  test("releases scoped resources after use", async () => {
    const events: string[] = [];

    const value = await runPromiseAtBoundary(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          const acquired = yield* scopedResource(
            () => {
              events.push("acquire");
              return "resource";
            },
            (released) => {
              events.push(`release:${released}`);
            },
          );
          events.push(`use:${acquired}`);
          return acquired;
        }),
      ),
    );

    expect(value).toBe("resource");
    expect(events).toEqual(["acquire", "use:resource", "release:resource"]);
  });

  test("translates Effect interruption into AbortSignal cancellation", async () => {
    let observedAbort = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const fiber = BrewvaEffect.runFork(
      withAbortSignal((signal) =>
        BrewvaEffect.promise(() => {
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(new BrewvaInterruptedError({ message: "interrupted" }));
              },
              { once: true },
            );
            markStarted();
          });
        }),
      ),
    );

    await started;
    await BrewvaEffect.runPromise(BrewvaFiber.interrupt(fiber));

    expect(observedAbort).toBe(true);
  });

  test("passes an AbortSignal into interruptible Promise bridges", async () => {
    const aborted = await runPromiseAtBoundary(
      fromInterruptiblePromise((signal) => Promise.resolve(signal.aborted)),
    );

    expect(aborted).toBe(false);
  });

  test("links external AbortSignals into abortable boundary Promise bridges", async () => {
    const controller = new AbortController();
    let observedAbort = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const promise = runPromiseAtBoundary(
      fromAbortableBoundaryPromise(
        (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
            markStarted();
          }),
        controller.signal,
      ),
    );

    await started;
    controller.abort();
    await promise;

    expect(observedAbort).toBe(true);
  });

  test("classifies abort-like boundary failures as typed cancellation", async () => {
    const controller = new AbortController();

    const promise = runPromiseAtBoundary(
      fromAbortableBoundaryPromise(
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted", "AbortError")),
              { once: true },
            );
          }),
        controller.signal,
      ).pipe(BrewvaEffect.flip),
    );

    controller.abort();
    const error = await promise;

    expect(error).toBeInstanceOf(BrewvaCancelled);
    expect(error._tag).toBe("BrewvaCancelled");
  });

  test("managed intervals run without overlap and stop through close", async () => {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const handle = startManagedInterval({
      intervalMs: 1,
      run: () =>
        BrewvaEffect.promise(async () => {
          calls += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
        }),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await handle.close();
    const callsAfterClose = calls;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(callsAfterClose).toBeGreaterThan(0);
    expect(calls).toBe(callsAfterClose);
    expect(maxInFlight).toBe(1);
  });

  test("scoped schedules stop their forked fiber when the owner closes", async () => {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const handle = startScopedSchedule({
      intervalMs: 1,
      runImmediately: true,
      run: () =>
        BrewvaEffect.promise(async () => {
          calls += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
        }),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await handle.close();
    const callsAfterClose = calls;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(callsAfterClose).toBeGreaterThan(0);
    expect(calls).toBe(callsAfterClose);
    expect(maxInFlight).toBe(1);
  });

  test("config services generate typed default and override layers", async () => {
    class ExampleConfig extends BrewvaConfigService.Service<ExampleConfig>()(
      "@brewva/test/ExampleConfig",
      {
        mode: BrewvaConfig.string("BREWVA_TEST_EFFECT_MODE").pipe(
          BrewvaConfig.withDefault("default"),
        ),
      },
    ) {}

    const defaultMode = await runPromiseAtBoundary(
      BrewvaEffect.gen(function* () {
        const config = yield* ExampleConfig;
        return config.mode;
      }).pipe(BrewvaEffect.provide(ExampleConfig.defaultLayer)),
    );
    const overrideMode = await runPromiseAtBoundary(
      BrewvaEffect.gen(function* () {
        const config = yield* ExampleConfig;
        return config.mode;
      }).pipe(BrewvaEffect.provide(ExampleConfig.layer({ mode: "override" }))),
    );

    expect(defaultMode).toBe("default");
    expect(overrideMode).toBe("override");
  });

  test("test runtime exposes deterministic clock services", async () => {
    const runtime = createTestRuntime<void, never>();
    let completed = false;
    await runtime.runPromise(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          const fiber = yield* BrewvaEffect.sleep("1 minute").pipe(
            BrewvaEffect.andThen(
              BrewvaEffect.sync(() => {
                completed = true;
              }),
            ),
            BrewvaEffect.forkScoped({ startImmediately: true }),
          );
          yield* BrewvaTestClock.adjust("1 minute");
          yield* BrewvaFiber.await(fiber);
        }),
      ).pipe(BrewvaEffect.provide(runtime.testClockLayer)),
    );

    expect(completed).toBe(true);
  });

  test("named runtime scopes are ordinary Effect services", async () => {
    const result = await runPromiseAtBoundary(
      BrewvaEffect.gen(function* () {
        const session = yield* BrewvaSessionScope;
        const provider = yield* BrewvaProviderRequestScope;
        const box = yield* BrewvaBoxScope;
        return {
          sessionId: session.sessionId,
          provider: provider.provider,
          model: provider.model,
          boxOwner: box.ownerSessionId,
        };
      }).pipe(
        BrewvaEffect.provide(BrewvaSessionScope.layer({ sessionId: "session-1" })),
        BrewvaEffect.provide(
          BrewvaProviderRequestScope.layer({
            provider: "openai",
            model: "gpt-test",
            sessionId: "session-1",
          }),
        ),
        BrewvaEffect.provide(
          BrewvaBoxScope.layer({
            ownerSessionId: "session-1",
            boxId: "box-1",
          }),
        ),
      ),
    );

    expect(result).toEqual({
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-test",
      boxOwner: "session-1",
    });
  });

  test("observability helper opens a current span and accepts log annotations", async () => {
    const spanName = await runPromiseAtBoundary(
      BrewvaEffect.currentSpan.pipe(
        BrewvaEffect.map((span) => span.name),
        withBrewvaObservability("brewva.test.span", {
          sessionId: "session-1",
          omitted: undefined,
        }),
      ),
    );

    expect(spanName).toBe("brewva.test.span");
  });

  test("retry policies use Effect schedules and retry only matching failures", async () => {
    class RetryableFailure extends Error {}
    let attempts = 0;

    const result = await runPromiseAtBoundary(
      retryWithBrewvaPolicy(
        BrewvaEffect.gen(function* () {
          attempts += 1;
          if (attempts < 3) {
            return yield* BrewvaEffect.fail(new RetryableFailure("try again"));
          }
          return "ok";
        }),
        {
          maxRetries: 3,
          baseDelayMs: 1,
          while: (error) => error instanceof RetryableFailure,
        },
      ),
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(makeBrewvaRetrySchedule({ maxRetries: 1, baseDelayMs: 1 })).toBeDefined();
  });

  test("retry policies can preserve service-directed retry delays", async () => {
    class RetryAfterFailure extends Error {
      constructor(readonly retryDelayMs: number) {
        super("retry after");
      }
    }
    let attempts = 0;
    const delays: number[] = [];

    const result = await runPromiseAtBoundary(
      retryWithBrewvaPolicy(
        BrewvaEffect.gen(function* () {
          attempts += 1;
          if (attempts < 3) {
            return yield* BrewvaEffect.fail(new RetryAfterFailure(attempts));
          }
          return "ok";
        }),
        {
          maxRetries: 3,
          baseDelayMs: 100,
          delayFor: (error, attempt) => {
            delays.push(attempt);
            return error.retryDelayMs;
          },
          while: (error) => error instanceof RetryAfterFailure,
        },
      ),
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays).toEqual([0, 1]);
  });

  test("retry policies do not retry non-matching failures", async () => {
    let attempts = 0;

    const error = await runPromiseAtBoundary(
      retryWithBrewvaPolicy(
        BrewvaEffect.gen(function* () {
          attempts += 1;
          return yield* BrewvaEffect.fail(new Error("stop"));
        }),
        {
          maxRetries: 3,
          baseDelayMs: 1,
          while: () => false,
        },
      ).pipe(BrewvaEffect.flip),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("stop");
    expect(attempts).toBe(1);
  });

  test("exposes Effect-owned observability and platform layers", async () => {
    let loadedNodeSdk = false;

    await runPromiseAtBoundary(
      BrewvaEffect.void.pipe(BrewvaEffect.provide(emptyObservabilityLayer)),
    );
    await runPromiseAtBoundary(
      BrewvaEffect.void.pipe(
        BrewvaEffect.provide(observabilityLayer(() => ({ serviceName: "brewva-test" }))),
      ),
    );
    await runPromiseAtBoundary(
      BrewvaEffect.void.pipe(
        BrewvaEffect.provide(
          observabilityLayer(() => ({ enabled: true, serviceName: "brewva-test" }), {
            makeNodeSdkLayer(config) {
              loadedNodeSdk = config.resource?.serviceName === "brewva-test";
              return BrewvaLayer.empty;
            },
          }),
        ),
      ),
    );
    expect(loadedNodeSdk).toBe(true);
    expect(nodeFileSystemLayer).toBeDefined();
  });

  test("common tagged errors flow through the Effect error channel", async () => {
    const error = await runPromiseAtBoundary(
      BrewvaEffect.fail(new BrewvaTimeout({ message: "timed out", timeoutMs: 25 })).pipe(
        BrewvaEffect.flip,
      ),
    );

    expect(error._tag).toBe("BrewvaTimeout");
    expect(error.timeoutMs).toBe(25);
  });

  test("runtime spines memoize layer construction and own layer finalizers", async () => {
    class SpineProbe extends BrewvaContext.Service<SpineProbe, { readonly value: number }>()(
      "@brewva/test/SpineProbe",
    ) {}

    let builds = 0;
    let releases = 0;
    const layer = BrewvaLayer.effect(
      SpineProbe,
      BrewvaEffect.acquireRelease(
        BrewvaEffect.sync(() => SpineProbe.of({ value: ++builds })),
        () =>
          BrewvaEffect.sync(() => {
            releases += 1;
          }),
      ),
    );
    const spine = createBrewvaRuntimeSpine(layer, { name: "test-spine" });

    const first = spine.runSync(
      BrewvaEffect.gen(function* () {
        const probe = yield* SpineProbe;
        return probe.value;
      }),
    );
    const second = await spine.runPromise(
      BrewvaEffect.gen(function* () {
        const probe = yield* SpineProbe;
        return probe.value;
      }),
    );

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(builds).toBe(1);
    expect(releases).toBe(0);

    await spine.dispose();

    expect(releases).toBe(1);
  });

  test("runtime spines use isolated memo maps unless sharing is explicit", async () => {
    class SpineProbe extends BrewvaContext.Service<SpineProbe, { readonly value: number }>()(
      "@brewva/test/IsolatedSpineProbe",
    ) {}

    let builds = 0;
    const layer = BrewvaLayer.effect(
      SpineProbe,
      BrewvaEffect.sync(() => SpineProbe.of({ value: ++builds })),
    );
    const firstSpine = createBrewvaRuntimeSpine(layer, { name: "first-spine" });
    const secondSpine = createBrewvaRuntimeSpine(layer, { name: "second-spine" });

    expect(
      firstSpine.runSync(
        BrewvaEffect.gen(function* () {
          const probe = yield* SpineProbe;
          return probe.value;
        }),
      ),
    ).toBe(1);
    expect(
      secondSpine.runSync(
        BrewvaEffect.gen(function* () {
          const probe = yield* SpineProbe;
          return probe.value;
        }),
      ),
    ).toBe(2);

    await firstSpine.dispose();
    await secondSpine.dispose();
  });
});
