import { describe, expect, test } from "bun:test";
import {
  createConcurrencyLimiter,
  createDeferred,
  createNonOverlappingTaskRunner,
  mapConcurrent,
} from "@brewva/brewva-std/async";

describe("std async utilities", () => {
  test("createDeferred settles once and exposes settled state", async () => {
    const deferred = createDeferred<string>();

    expect(deferred.settled()).toBe(false);
    deferred.resolve("first");
    deferred.resolve("second");

    expect(deferred.settled()).toBe(true);
    expect(await deferred.promise).toBe("first");
  });

  test("createNonOverlappingTaskRunner skips overlapping runs and releases after completion", async () => {
    const releaseFirstRun = createDeferred<void>();
    let starts = 0;

    const runner = createNonOverlappingTaskRunner(async () => {
      starts += 1;
      if (starts === 1) {
        await releaseFirstRun.promise;
      }
    });

    const firstRun = runner.run();
    const secondRun = runner.run();

    expect(starts).toBe(1);
    expect(await secondRun).toBe(false);

    releaseFirstRun.resolve();
    expect(await firstRun).toBe(true);
    expect(await runner.run()).toBe(true);
    expect(starts).toBe(2);
    await runner.whenIdle();
  });

  test("createNonOverlappingTaskRunner releases after failure", async () => {
    const release = createDeferred<void>();
    let attempts = 0;
    const runner = createNonOverlappingTaskRunner(async () => {
      attempts += 1;
      if (attempts === 1) {
        await release.promise;
        throw new Error("maintenance failed");
      }
    });

    const firstRun = runner.run();
    const firstRunFailure = firstRun.then(
      () => expect.unreachable("expected the first run to fail"),
      (error) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("maintenance failed");
      },
    );
    const idle = runner.whenIdle();
    release.resolve();

    await idle;
    await firstRunFailure;
    expect(await runner.run()).toBe(true);
    expect(attempts).toBe(2);
  });

  test("mapConcurrent preserves input order and limits active work", async () => {
    let active = 0;
    let maxActive = 0;

    const result = await mapConcurrent([3, 2, 1, 0], { concurrency: 2 }, async (value, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return `${index}:${value}`;
    });

    expect(result).toEqual(["0:3", "1:2", "2:1", "3:0"]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("mapConcurrent rejects invalid concurrency", async () => {
    try {
      await mapConcurrent([1], { concurrency: 0 }, async (value) => value);
      expect.unreachable("expected invalid concurrency to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toContain("concurrency");
    }
  });

  test("mapConcurrent propagates mapper failures", async () => {
    try {
      await mapConcurrent([1, 2, 3], { concurrency: 2 }, async (value) => {
        if (value === 2) {
          throw new Error("mapper failed");
        }
        return value;
      });
      expect.unreachable("expected mapper failure to reject the batch");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("mapper failed");
    }
  });

  test("createConcurrencyLimiter exposes active and pending counts", async () => {
    const release = createDeferred<void>();
    const limiter = createConcurrencyLimiter({ concurrency: 1, rejectOnClear: true });

    const first = limiter.run(async () => {
      await release.promise;
      return "first";
    });
    const second = limiter.run(async () => "second");

    expect(limiter.activeCount()).toBe(1);
    expect(limiter.pendingCount()).toBe(1);

    release.resolve();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(limiter.activeCount()).toBe(0);
    expect(limiter.pendingCount()).toBe(0);
  });

  test("createConcurrencyLimiter rejects queued tasks when clearing with rejectOnClear", async () => {
    const release = createDeferred<void>();
    const limiter = createConcurrencyLimiter({ concurrency: 1, rejectOnClear: true });

    const first = limiter.run(async () => {
      await release.promise;
      return "first";
    });
    const second = limiter.run(async () => "second");
    const secondFailure = second.then(
      () => expect.unreachable("expected queued task to be rejected"),
      (error) => {
        expect(error).toBeDefined();
      },
    );

    expect(limiter.activeCount()).toBe(1);
    expect(limiter.pendingCount()).toBe(1);

    limiter.clearQueue();
    expect(limiter.pendingCount()).toBe(0);
    release.resolve();

    expect(await first).toBe("first");
    await secondFailure;
    expect(limiter.activeCount()).toBe(0);
    expect(limiter.pendingCount()).toBe(0);
  });
});
