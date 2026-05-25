import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("four-port runtime entrypoint surface", () => {
  test("runtime package exports the four-port runtime and canonical event vocabulary", async () => {
    const runtimeModule = await import("@brewva/brewva-runtime");

    expect("createBrewvaRuntime" in runtimeModule).toBe(true);
    expect("CANONICAL_EVENT_TYPES" in runtimeModule).toBe(true);
    expect("RUNTIME_RECOVERY_CAUSES" in runtimeModule).toBe(true);

    for (const removedRuntimeSurface of [
      "BrewvaRuntimeRoot",
      "BrewvaHostedRuntimePort",
      "BrewvaToolRuntimePort",
      "BrewvaOperatorRuntimePort",
      "HostedRuntimeAdapterPort",
      "HostedRuntimeAdapterPort",
      "ToolRuntimeAdapterPort",
      "HostedRuntimeAdapterPort",
    ]) {
      expect(removedRuntimeSurface in runtimeModule).toBe(false);
    }
    expect("selectOperatorRuntimePort" in runtimeModule).toBe(false);
    expect("BREWVA_REGISTERED_EVENT_TYPES" in runtimeModule).toBe(false);
  });

  test("legacy runtime is not a public package subpath", async () => {
    const publicLegacyEntrypoint = "@brewva/brewva-runtime/legacy-runtime" as string;
    let rejected = false;
    try {
      await import(publicLegacyEntrypoint);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    const runtimeFixtures = await import("../../helpers/runtime.js");
    expect(typeof runtimeFixtures.createRuntimeInstanceFixture).toBe("function");
  });

  test("runtime factory returns one frozen four-port runtime object", async () => {
    const runtimeModule = await import("@brewva/brewva-runtime");
    const runtime = runtimeModule.createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-four-port-runtime-")),
      physics: { mode: "noop" },
    });

    expect(Object.keys(runtime)).toEqual([
      "identity",
      "config",
      "tape",
      "kernel",
      "model",
      "start",
      "turn",
      "close",
    ]);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.tape)).toBe(true);
    expect(Object.isFrozen(runtime.kernel)).toBe(true);
    expect(Object.isFrozen(runtime.model)).toBe(true);
    expect(Object.getOwnPropertySymbols(runtime)).toEqual([]);

    expect("root" in runtime).toBe(false);
    expect("hosted" in runtime).toBe(false);
    expect("tool" in runtime).toBe(false);
    expect("operator" in runtime).toBe(false);
    expect("authority" in runtime).toBe(false);
    expect("inspect" in runtime).toBe(false);
  });

  test("canonical event and recovery vocabularies stay compressed", async () => {
    const runtimeModule = await import("@brewva/brewva-runtime");

    expect(runtimeModule.CANONICAL_EVENT_TYPES).toEqual([
      "turn.started",
      "turn.ended",
      "msg.committed",
      "reason.committed",
      "tool.proposed",
      "tool.committed",
      "tool.aborted",
      "checkpoint.committed",
      "anchor.committed",
      "approval.requested",
      "approval.decided",
      "cost.observed",
      "runtime.suspended",
      "custom",
    ]);
    expect(runtimeModule.RUNTIME_RECOVERY_CAUSES).toEqual([
      "approval_pending",
      "compaction_required",
      "provider_retry",
      "interrupt",
      "terminal_commit",
    ]);
  });
});
