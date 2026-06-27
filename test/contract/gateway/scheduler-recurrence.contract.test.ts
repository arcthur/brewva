import { describe, expect, test } from "bun:test";
import { createSchedulerService } from "@brewva/brewva-gateway/daemon";
import { sleep, waitUntil } from "../../helpers/process.js";

interface IntentSnapshot {
  readonly intentId: string;
  readonly status?: string;
  readonly runCount?: number;
  readonly nextRunAt?: number;
}

function findIntent(
  scheduler: ReturnType<typeof createSchedulerService>,
  intentId: string,
): IntentSnapshot | undefined {
  const intents = (scheduler.snapshot() as { intents?: IntentSnapshot[] }).intents ?? [];
  return intents.find((intent) => intent.intentId === intentId);
}

describe("scheduler cron recurrence wiring", () => {
  test("arms a daily cron intent at a real cron slot, not a +60s placeholder", () => {
    const scheduler = createSchedulerService({});
    try {
      const before = Date.now();
      scheduler.createIntent({
        intentId: "cron-arm",
        parentSessionId: "s1",
        reason: "daily report",
        cron: "0 9 * * *",
        timeZone: "UTC",
        maxRuns: 100,
      });

      const intent = findIntent(scheduler, "cron-arm");
      expect(typeof intent?.nextRunAt).toBe("number");
      if (typeof intent?.nextRunAt === "number") {
        // The regression: the old placeholder armed `now + 60_000`. A real cron slot
        // lands at 09:00 UTC (plus <=15min jitter), never one minute out.
        const slot = new Date(intent.nextRunAt);
        expect(slot.getUTCHours()).toBe(9);
        expect(slot.getUTCMinutes()).toBeLessThanOrEqual(15);
        expect(intent.nextRunAt).toBeGreaterThan(before);
      }
      expect(scheduler.getStats().timersArmed).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  test("re-arms a recurring cron intent at the next slot after it fires", async () => {
    let fireCount = 0;
    const scheduler = createSchedulerService({
      executeIntent: () => {
        fireCount += 1;
      },
    });
    try {
      scheduler.createIntent({
        intentId: "cron-rearm",
        parentSessionId: "s1",
        reason: "recurring",
        cron: "0 9 * * *",
        timeZone: "UTC",
        runAt: Date.now() + 5, // first run fires almost immediately
        maxRuns: 5,
      });

      await waitUntil(
        () => {
          const intent = findIntent(scheduler, "cron-rearm");
          return intent?.runCount === 1 && intent.status === "active";
        },
        2000,
        "recurring intent did not fire and re-arm",
      );

      const intent = findIntent(scheduler, "cron-rearm");
      expect(fireCount).toBe(1);
      expect(intent?.status).toBe("active");
      expect(intent?.runCount).toBe(1);
      expect(typeof intent?.nextRunAt).toBe("number");
      if (typeof intent?.nextRunAt === "number") {
        // re-armed at the cron slot (09:00 UTC), not the past fire time or +60s.
        expect(new Date(intent.nextRunAt).getUTCHours()).toBe(9);
      }
      // The regression guard: a fired intent used to leave zero timers armed.
      expect(scheduler.getStats().timersArmed).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  test("a failed run still advances recurrence and re-arms (it does not go silent)", async () => {
    let attempts = 0;
    const scheduler = createSchedulerService({
      executeIntent: () => {
        attempts += 1;
        throw new Error("boom");
      },
    });
    try {
      scheduler.createIntent({
        intentId: "cron-fail",
        parentSessionId: "s1",
        reason: "flaky",
        cron: "0 9 * * *",
        timeZone: "UTC",
        runAt: Date.now() + 5, // first run fires almost immediately, then throws
        maxRuns: 5,
      });

      await waitUntil(
        () => {
          const intent = findIntent(scheduler, "cron-fail");
          return (intent?.runCount ?? 0) >= 1 && intent?.status === "active";
        },
        2000,
        "failed intent did not advance and re-arm",
      );

      const intent = findIntent(scheduler, "cron-fail");
      expect(attempts).toBe(1);
      expect(intent?.status).toBe("active"); // still recurring, not silently dead
      expect(intent?.runCount).toBe(1); // counted once -- the failed catch must not double-count
      expect(typeof intent?.nextRunAt).toBe("number");
      if (typeof intent?.nextRunAt === "number") {
        expect(new Date(intent.nextRunAt).getUTCHours()).toBe(9); // advanced to the next slot
      }
      expect(scheduler.getStats().timersArmed).toBe(1); // re-armed despite the failure
    } finally {
      scheduler.stop();
    }
  });

  test("chunks a far-future delay instead of overflowing setTimeout and firing early", async () => {
    let fireCount = 0;
    const scheduler = createSchedulerService({
      executeIntent: () => {
        fireCount += 1;
      },
    });
    try {
      // ~200 days exceeds the signed 32-bit millisecond ceiling; an unchunked
      // setTimeout would overflow and fire immediately (the yearly-cron regression).
      const farFuture = Date.now() + 200 * 24 * 60 * 60 * 1000;
      scheduler.createIntent({
        intentId: "far-future",
        parentSessionId: "s1",
        reason: "yearly",
        runAt: farFuture,
        maxRuns: 1,
      });
      expect(scheduler.getStats().timersArmed).toBe(1);
      await sleep(20);
      expect(fireCount).toBe(0); // did not overflow-fire immediately
      expect(scheduler.getStats().timersArmed).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  test("converges a one-shot intent after a single run without re-arming", async () => {
    const scheduler = createSchedulerService({
      executeIntent: () => {},
    });
    try {
      scheduler.createIntent({
        intentId: "one-shot",
        parentSessionId: "s1",
        reason: "once",
        runAt: Date.now() + 5,
        maxRuns: 1,
      });

      await waitUntil(
        () => findIntent(scheduler, "one-shot")?.status === "converged",
        2000,
        "one-shot intent did not converge",
      );

      const intent = findIntent(scheduler, "one-shot");
      expect(intent?.status).toBe("converged");
      expect(intent?.runCount).toBe(1);
      expect(scheduler.getStats().timersArmed).toBe(0); // no recurrence -> no re-arm
    } finally {
      scheduler.stop();
    }
  });
});
