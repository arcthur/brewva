import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromiseAtBoundary } from "@brewva/brewva-effect";
import { BrewvaStream } from "@brewva/brewva-effect/primitives";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import {
  createManagedExecProcessRegistryRuntime,
  ManagedExecProcessRegistryService,
  type ManagedExecProcessRegistry,
} from "../../../packages/brewva-tools/src/families/execution/exec-process-registry/api.js";

describe("managed exec Effect runtime integration", () => {
  test("disposes process registry state with the scoped Effect service", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-managed-exec-dispose-"));
    const ownerSessionId = "owner-registry";
    let registry: ManagedExecProcessRegistry | undefined;
    await runPromiseAtBoundary(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          registry = yield* ManagedExecProcessRegistryService;
          const started = yield* registry.startHost({
            ownerSessionId,
            cwd,
            command: "sleep 5",
          });
          yield* registry.markBackgrounded(ownerSessionId, started.session.id);
        }).pipe(BrewvaEffect.provide(ManagedExecProcessRegistryService.layer())),
      ),
    );

    const remaining = registry
      ? await runPromiseAtBoundary(registry.listRunningBackground(ownerSessionId))
      : [];
    expect(remaining).toHaveLength(0);
  });

  test("streams managed host output and completes on process exit", async () => {
    const registry = createManagedExecProcessRegistryRuntime();
    const cwd = mkdtempSync(join(tmpdir(), "brewva-managed-exec-stream-"));
    const ownerSessionId = "owner-stream";
    const started = await registry.startHost({
      ownerSessionId,
      cwd,
      command: "sleep 0.05; printf stream-ready",
    });

    const eventsPromise = registry.runEffect(
      BrewvaEffect.gen(function* () {
        const service = yield* ManagedExecProcessRegistryService;
        return yield* service
          .streamOutput(ownerSessionId, started.session.id)
          .pipe(BrewvaStream.runCollect);
      }),
    );

    await started.completion;
    const events = await eventsPromise;
    await registry.close();

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
    const registry = createManagedExecProcessRegistryRuntime();
    const cwd = mkdtempSync(join(tmpdir(), "brewva-managed-exec-wait-"));
    const ownerSessionId = "owner-wait";
    const started = await registry.startHost({
      ownerSessionId,
      cwd,
      command: "sleep 0.05; printf wake",
    });

    const startedAt = Date.now();
    await registry.waitActivity(ownerSessionId, started.session.id, 5_000);
    const elapsedMs = Date.now() - startedAt;
    await started.completion;
    await registry.close();

    expect(elapsedMs).toBeLessThan(4_000);
  });

  test("runs managed session output through an Effect sink consumer", async () => {
    const registry = createManagedExecProcessRegistryRuntime();
    const cwd = mkdtempSync(join(tmpdir(), "brewva-managed-exec-sink-"));
    const ownerSessionId = "owner-sink";
    const started = await registry.startHost({
      ownerSessionId,
      cwd,
      command: "sleep 0.05; printf sink-ready",
    });
    const observed: string[] = [];

    await Promise.all([
      registry.runEffect(
        BrewvaEffect.gen(function* () {
          const service = yield* ManagedExecProcessRegistryService;
          return yield* service.consumeOutput(ownerSessionId, started.session.id, (event) =>
            event.type === "output"
              ? BrewvaEffect.sync(() => {
                  observed.push(event.chunk);
                })
              : undefined,
          );
        }),
      ),
      started.completion,
    ]);
    await registry.close();

    expect(observed.join("")).toContain("sink-ready");
  });
});
