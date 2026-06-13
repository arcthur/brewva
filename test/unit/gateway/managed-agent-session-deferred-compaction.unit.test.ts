import { describe, expect, test } from "bun:test";
import { ManagedSessionDeferredCompactionCoordinator } from "../../../packages/brewva-gateway/src/hosted/internal/compaction/deferred.js";
import { ManagedSessionCompactionFlowState } from "../../../packages/brewva-gateway/src/hosted/internal/compaction/flow.js";

describe("managed-agent-session deferred compaction coordinator", () => {
  test("requests immediate compaction and runs preview/build/finalize in order", async () => {
    const calls: string[] = [];
    const flow = new ManagedSessionCompactionFlowState();
    const coordinator = new ManagedSessionDeferredCompactionCoordinator({
      flow,
      isStreaming: () => false,
      preview: async () => {
        calls.push("preview");
        return { id: "prepared" };
      },
      build: (prepared) => {
        calls.push(`build:${prepared.id}`);
        return { id: "built" };
      },
      finalize: async () => {
        calls.push("finalize");
      },
      salvage: async () => false,
      rollback: async () => {
        calls.push("rollback");
      },
    });

    await coordinator.request({});

    expect(calls).toEqual(["preview", "build:prepared", "finalize"]);
    expect(coordinator.isCompacting).toBe(false);
  });

  test("flushes deferred streaming compaction after committed tool result", async () => {
    const flow = new ManagedSessionCompactionFlowState();
    const calls: string[] = [];
    const coordinator = new ManagedSessionDeferredCompactionCoordinator({
      flow,
      isStreaming: () => true,
      preview: async () => {
        calls.push("preview");
        return { id: "prepared" };
      },
      build: () => ({ id: "built" }),
      finalize: async () => {
        calls.push("finalize");
      },
      salvage: async () => false,
      rollback: async () => undefined,
    });

    void coordinator.request({});
    expect(coordinator.consumeToolResultStop()).toBe(true);
    expect(await coordinator.flushAfterCommittedToolResult()).toBe(true);
    expect(calls).toEqual(["preview", "finalize"]);
  });
});
