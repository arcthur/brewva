import { describe, expect, test } from "bun:test";
import {
  AsyncBridgeAbortedError,
  AsyncBridgeClosedError,
  createConcurrencyLimiter,
  createAsyncBridge,
  createDeferred,
  createNonOverlappingTaskRunner,
  createSingleFlight,
  linkAbortSignal,
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

  test("createSingleFlight shares one in-flight promise per key", async () => {
    const flight = createSingleFlight<string, number>();
    let calls = 0;
    const release = createDeferred<void>();
    const factory = () => {
      calls += 1;
      return release.promise.then(() => calls);
    };

    const first = flight.run("k", factory);
    const second = flight.run("k", factory);
    expect(first).toBe(second); // same promise object → coalesced
    expect(flight.size).toBe(1);

    release.resolve();
    expect(await first).toBe(1);
    expect(calls).toBe(1); // factory ran once for the coalesced key
  });

  test("createSingleFlight runs distinct keys independently and re-runs after settle", async () => {
    const flight = createSingleFlight<string, string>();

    expect(await flight.run("k", async () => "v1")).toBe("v1");
    expect(flight.size).toBe(0); // slot cleared after settle
    // Not memoized: a later call for the same key re-invokes the factory.
    expect(await flight.run("k", async () => "v2")).toBe("v2");
  });

  test("createSingleFlight clears the slot after a rejection", async () => {
    const flight = createSingleFlight<string, string>();

    await flight
      .run("k", async () => Promise.reject(new Error("boom")))
      .then(
        () => expect.unreachable("expected rejection"),
        (error) => expect((error as Error).message).toBe("boom"),
      );
    expect(flight.size).toBe(0);
    expect(await flight.run("k", async () => "recovered")).toBe("recovered");
  });

  test("createSingleFlight clear stops new calls from joining prior in-flight work", async () => {
    const flight = createSingleFlight<string, number>();
    let calls = 0;
    const release = createDeferred<void>();
    const factory = () => {
      calls += 1;
      return release.promise.then(() => calls);
    };

    const first = flight.run("k", factory);
    expect(flight.size).toBe(1);
    flight.clear();
    expect(flight.size).toBe(0);

    const second = flight.run("k", factory); // fresh, does not join `first`
    expect(second).not.toBe(first);
    release.resolve();
    await first;
    await second;
    expect(calls).toBe(2);
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
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("The operation was aborted.");
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

  test("createAsyncBridge applies backpressure when full", async () => {
    const bridge = createAsyncBridge<string>({ capacity: 1 });
    await bridge.write("first");

    let secondResolved = false;
    const second = bridge.write("second").then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    const iterator = bridge[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: "first" });
    await second;
    expect(secondResolved).toBe(true);
    expect(await iterator.next()).toEqual({ done: false, value: "second" });
    bridge.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  test("createAsyncBridge close drains queued items and rejects new writes", async () => {
    const bridge = createAsyncBridge<number>({ capacity: 2 });
    await bridge.write(1);
    await bridge.write(2);
    bridge.close();

    const values: number[] = [];
    for await (const value of bridge) {
      values.push(value);
    }
    expect(values).toEqual([1, 2]);

    try {
      await bridge.write(3);
      expect.unreachable("expected closed bridge writes to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AsyncBridgeClosedError);
    }
  });

  test("createAsyncBridge fail wakes pending readers and writers", async () => {
    const bridge = createAsyncBridge<string>({ capacity: 1 });
    await bridge.write("first");
    const pendingWrite = bridge.write("second");
    const failure = new Error("bridge failed");
    bridge.fail(failure);

    await pendingWrite.then(
      () => expect.unreachable("expected pending write to fail"),
      (error) => expect(error).toBe(failure),
    );
    await bridge[Symbol.asyncIterator]()
      .next()
      .then(
        () => expect.unreachable("expected pending read to fail"),
        (error) => expect(error).toBe(failure),
      );
  });

  test("createAsyncBridge abort rejects pending and future writes", async () => {
    const bridge = createAsyncBridge<string>({ capacity: 1 });
    await bridge.write("first");
    const pendingWrite = bridge.write("second");
    bridge.abort("stopped");

    await pendingWrite.then(
      () => expect.unreachable("expected pending write to abort"),
      (error) => expect(error).toBeInstanceOf(AsyncBridgeAbortedError),
    );
    await bridge.write("third").then(
      () => expect.unreachable("expected future write to abort"),
      (error) => expect(error).toBeInstanceOf(AsyncBridgeAbortedError),
    );
  });

  test("createAsyncBridge iterator return calls onCancel", async () => {
    let cancelled = false;
    const bridge = createAsyncBridge<string>({
      onCancel() {
        cancelled = true;
      },
    });
    await bridge.write("first");

    for await (const value of bridge) {
      expect(value).toBe("first");
      break;
    }

    expect(cancelled).toBe(true);
    await bridge.write("second").then(
      () => expect.unreachable("expected closed bridge write to fail"),
      (error) => expect(error).toBeInstanceOf(AsyncBridgeClosedError),
    );
  });

  test("linkAbortSignal propagates abort and unregisters cleanup", () => {
    const source = new AbortController();
    const target = new AbortController();
    const unlink = linkAbortSignal(source.signal, target);

    source.abort("cancelled");
    expect(target.signal.aborted).toBe(true);
    expect(target.signal.reason).toBe("cancelled");

    const secondSource = new AbortController();
    const secondTarget = new AbortController();
    const secondUnlink = linkAbortSignal(secondSource.signal, secondTarget);
    secondUnlink();
    secondSource.abort("ignored");
    expect(secondTarget.signal.aborted).toBe(false);

    unlink();
  });
});
