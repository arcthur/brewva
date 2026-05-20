import { describe, expect, test } from "bun:test";
import { runPromiseAtBoundary } from "@brewva/brewva-effect";
import { BrewvaEffect, BrewvaFiber } from "@brewva/brewva-effect/primitives";
import {
  createChannelSerialQueueRuntime,
  ChannelSerialQueueService,
} from "../../../packages/brewva-gateway/src/channels/effect-serial-queue.js";

describe("ChannelSerialQueueService", () => {
  test("provides the serial queue as a scoped Effect service", async () => {
    let releaseFirst: (() => void) | undefined;
    let resolveFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const observed: string[] = [];

    const queue = await runPromiseAtBoundary(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          const scopedQueue = yield* ChannelSerialQueueService;
          const first = yield* scopedQueue
            .enqueue(() =>
              BrewvaEffect.promise(async () => {
                observed.push("first:start");
                resolveFirstStarted?.();
                await new Promise<void>((resolve) => {
                  releaseFirst = resolve;
                });
                observed.push("first:end");
                return "first";
              }),
            )
            .pipe(BrewvaEffect.forkScoped({ startImmediately: true }));
          const second = yield* scopedQueue
            .enqueue(() =>
              BrewvaEffect.promise(async () => {
                observed.push("second");
                return "second";
              }),
            )
            .pipe(BrewvaEffect.forkScoped({ startImmediately: true }));

          yield* BrewvaEffect.promise(() => firstStarted);
          expect(observed).toEqual(["first:start"]);
          releaseFirst?.();
          expect(yield* BrewvaFiber.join(first)).toBe("first");
          expect(yield* BrewvaFiber.join(second)).toBe("second");
          expect(observed).toEqual(["first:start", "first:end", "second"]);
          return scopedQueue;
        }).pipe(BrewvaEffect.provide(ChannelSerialQueueService.layer({ name: "unit-queue" }))),
      ),
    );

    try {
      await runPromiseAtBoundary(queue.enqueue(() => BrewvaEffect.succeed("closed")));
      expect.unreachable("expected scoped queue to close when the layer scope exits");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).toBe("channel_serial_queue_closed:unit-queue");
    }
  });

  test("keeps the Promise factory adapter available for current gateway callers", async () => {
    const queue = createChannelSerialQueueRuntime({ name: "adapter-queue" });
    expect(queue.name).toBe("adapter-queue");
    expect(await queue.isIdle()).toBe(true);
    expect(await queue.enqueue(async () => "ok")).toBe("ok");
    expect(await queue.isIdle()).toBe(true);
    await queue.close();
  });

  test("does not close an adapter with a synchronously reserved submission", async () => {
    const queue = createChannelSerialQueueRuntime({ name: "adapter-race-queue" });
    let releaseSecond: (() => void) | undefined;
    let resolveSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve;
    });

    expect(await queue.isIdle()).toBe(true);
    const second = queue.enqueue(async () => {
      resolveSecondStarted?.();
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      return "second";
    });

    expect(await queue.closeIfIdle()).toBe(false);
    await secondStarted;
    releaseSecond?.();
    expect(await second).toBe("second");
    expect(await queue.closeIfIdle()).toBe(true);
  });
});
