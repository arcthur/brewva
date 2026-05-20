import { describe, expect, test } from "bun:test";
import { runPromiseAtBoundary } from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import {
  ChannelEffectSerialQueueService,
  type ChannelEffectSerialQueue,
} from "../../../packages/brewva-gateway/src/channels/effect-serial-queue.js";

describe("ChannelEffectSerialQueueService", () => {
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
          const scopedQueue = yield* ChannelEffectSerialQueueService;
          const first = scopedQueue.enqueue(async () => {
            observed.push("first:start");
            resolveFirstStarted?.();
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
            observed.push("first:end");
            return "first";
          });
          const second = scopedQueue.enqueue(async () => {
            observed.push("second");
            return "second";
          });

          yield* BrewvaEffect.promise(() => firstStarted);
          expect(observed).toEqual(["first:start"]);
          releaseFirst?.();
          expect(yield* BrewvaEffect.promise(() => Promise.all([first, second]))).toEqual([
            "first",
            "second",
          ]);
          expect(observed).toEqual(["first:start", "first:end", "second"]);
          return scopedQueue;
        }).pipe(
          BrewvaEffect.provide(ChannelEffectSerialQueueService.layer({ name: "unit-queue" })),
        ),
      ),
    );

    try {
      await queue.enqueue(async () => "closed");
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
    const queue = await runPromiseAtBoundary(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          const scopedQueue: ChannelEffectSerialQueue = yield* ChannelEffectSerialQueueService;
          return scopedQueue;
        }).pipe(
          BrewvaEffect.provide(ChannelEffectSerialQueueService.layer({ name: "adapter-queue" })),
        ),
      ),
    );

    expect(queue.name).toBe("adapter-queue");
  });
});
