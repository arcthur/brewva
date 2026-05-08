import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaEffect, BrewvaStream, runPromiseAtBoundary } from "@brewva/brewva-effect";
import {
  consumeManagedSessionOutputEffect,
  streamManagedSessionOutput,
  startManagedExec,
  waitForManagedSessionActivityEffect,
} from "../../../packages/brewva-tools/src/families/execution/exec-process-registry/api.js";

describe("managed exec Effect runtime integration", () => {
  test("streams managed host output and completes on process exit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-managed-exec-stream-"));
    const ownerSessionId = "owner-stream";
    const started = startManagedExec({
      ownerSessionId,
      cwd,
      command: "sleep 0.05; printf stream-ready",
    });

    const eventsPromise = runPromiseAtBoundary(
      streamManagedSessionOutput(ownerSessionId, started.session.id).pipe(BrewvaStream.runCollect),
    );

    await started.completion;
    const events = await eventsPromise;

    expect(
      events.some((event) => event.type === "output" && event.chunk.includes("stream-ready")),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "exit",
      sessionId: started.session.id,
      ownerSessionId,
      backend: "host",
    });
  });

  test("waits for managed session activity through an Effect deferred", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-managed-exec-wait-"));
    const ownerSessionId = "owner-wait";
    const started = startManagedExec({
      ownerSessionId,
      cwd,
      command: "sleep 0.05; printf wake",
    });

    const startedAt = Date.now();
    await runPromiseAtBoundary(
      waitForManagedSessionActivityEffect(ownerSessionId, started.session.id, 1_000),
    );
    const elapsedMs = Date.now() - startedAt;
    await started.completion;

    expect(elapsedMs).toBeLessThan(900);
  });

  test("runs managed session output through an Effect sink consumer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-managed-exec-sink-"));
    const ownerSessionId = "owner-sink";
    const started = startManagedExec({
      ownerSessionId,
      cwd,
      command: "sleep 0.05; printf sink-ready",
    });
    const observed: string[] = [];

    await Promise.all([
      runPromiseAtBoundary(
        consumeManagedSessionOutputEffect(ownerSessionId, started.session.id, (event) =>
          event.type === "output"
            ? BrewvaEffect.sync(() => {
                observed.push(event.chunk);
              })
            : undefined,
        ),
      ),
      started.completion,
    ]);

    expect(observed.join("")).toContain("sink-ready");
  });
});
