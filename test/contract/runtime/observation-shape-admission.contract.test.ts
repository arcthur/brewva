import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainShadowDivergenceEvidence } from "@brewva/brewva-gateway/hosted";
import { createBrewvaRuntime, type BrewvaRuntime } from "@brewva/brewva-runtime";
import { OBSERVATION_SHAPE_SHADOW_INTERCEPTOR_ID } from "@brewva/brewva-runtime/security";
import { RUNTIME_OPS_SHADOW_DIVERGENCE_RECORDED_KIND } from "@brewva/brewva-vocabulary/events";

function tempCwd(label: string): string {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

function createRuntime(label: string): BrewvaRuntime {
  return createBrewvaRuntime({
    cwd: tempCwd(label),
    physics: { mode: "noop" },
  });
}

describe("observation-shape shadow admission (RFC R4 Phase 0)", () => {
  test("real decision is untouched while the shadow would-allow diverges", async () => {
    const runtime = createRuntime("observation-shape-divergence");

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "shape-session",
      toolCallId: "call-get-title",
      toolName: "browser_get",
      args: { field: "title" },
    });

    // Real policy still defers browser calls to an ask — zero outcome change.
    expect(decision.kind).toBe("defer");

    const evidence = runtime.kernel.intercept.evidence.list({
      sessionId: "shape-session",
      interceptorId: OBSERVATION_SHAPE_SHADOW_INTERCEPTOR_ID,
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      toolName: "browser_get",
      real: { kind: "defer" },
      shadow: { kind: "allow" },
    });
  });

  test("artifact-writing browser calls never diverge (workspace_write stays effectful)", async () => {
    const runtime = createRuntime("observation-shape-snapshot-agreement");

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "shape-session",
      toolCallId: "call-snapshot",
      toolName: "browser_snapshot",
      args: {},
    });
    expect(decision.kind).toBe("defer");

    const evidence = runtime.kernel.intercept.evidence.list({
      sessionId: "shape-session",
      interceptorId: OBSERVATION_SHAPE_SHADOW_INTERCEPTOR_ID,
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      real: { kind: "defer" },
      shadow: { kind: "defer" },
    });
  });

  test("mutating call shapes never diverge", async () => {
    const runtime = createRuntime("observation-shape-agreement");

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "shape-session",
      toolCallId: "call-click",
      toolName: "browser_click",
      args: { selector: "#submit" },
    });
    expect(decision.kind).toBe("defer");

    const evidence = runtime.kernel.intercept.evidence.list({
      sessionId: "shape-session",
      interceptorId: OBSERVATION_SHAPE_SHADOW_INTERCEPTOR_ID,
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      real: { kind: "defer" },
      shadow: { kind: "defer" },
    });
  });

  test("the drain persists only divergences to the tape and is idempotent", async () => {
    const runtime = createRuntime("observation-shape-drain");

    await runtime.kernel.beginToolCall({
      sessionId: "drain-session",
      toolCallId: "call-get-title",
      toolName: "browser_get",
      args: { field: "title" },
    });
    await runtime.kernel.beginToolCall({
      sessionId: "drain-session",
      toolCallId: "call-read",
      toolName: "read",
      args: { path: "README.md" },
    });

    expect(drainShadowDivergenceEvidence(runtime, "drain-session")).toBe(1);
    // Re-draining without new evidence emits nothing.
    expect(drainShadowDivergenceEvidence(runtime, "drain-session")).toBe(0);

    const divergenceEvents = runtime.tape
      .list("drain-session")
      .filter(
        (event) =>
          event.type === "custom" &&
          (event.payload as { kind?: unknown }).kind ===
            RUNTIME_OPS_SHADOW_DIVERGENCE_RECORDED_KIND,
      );
    expect(divergenceEvents).toHaveLength(1);
    const divergencePayload = divergenceEvents[0]?.payload as { payload?: unknown } | undefined;
    expect(divergencePayload?.payload).toMatchObject({
      interceptorId: OBSERVATION_SHAPE_SHADOW_INTERCEPTOR_ID,
      toolName: "browser_get",
      toolCallId: "call-get-title",
      real: { kind: "defer" },
      shadow: { kind: "allow" },
    });

    // New evidence after a drain is picked up by the next drain.
    await runtime.kernel.beginToolCall({
      sessionId: "drain-session",
      toolCallId: "call-get-title-2",
      toolName: "browser_get",
      args: { field: "url" },
    });
    expect(drainShadowDivergenceEvidence(runtime, "drain-session")).toBe(1);
  });

  test("interleaved sessions drain independently without loss or duplication", async () => {
    const runtime = createRuntime("observation-shape-interleave");

    await runtime.kernel.beginToolCall({
      sessionId: "session-a",
      toolCallId: "a-1",
      toolName: "browser_get",
      args: { field: "title" },
    });
    await runtime.kernel.beginToolCall({
      sessionId: "session-b",
      toolCallId: "b-1",
      toolName: "browser_get",
      args: { field: "url" },
    });
    await runtime.kernel.beginToolCall({
      sessionId: "session-a",
      toolCallId: "a-2",
      toolName: "browser_get",
      args: { field: "title" },
    });

    expect(drainShadowDivergenceEvidence(runtime, "session-a")).toBe(2);
    expect(drainShadowDivergenceEvidence(runtime, "session-b")).toBe(1);
    expect(drainShadowDivergenceEvidence(runtime, "session-a")).toBe(0);
    expect(drainShadowDivergenceEvidence(runtime, "session-b")).toBe(0);
  });

  test("shadow resolver errors are skipped by the drain, not persisted as divergence", async () => {
    const runtime = createRuntime("observation-shape-error-skip");
    runtime.kernel.intercept.shadowToolAuthority({
      id: "always-throws",
      shadowPhysics: {
        resolveToolAuthority() {
          throw new Error("shadow_resolver_failed");
        },
      },
    });

    await runtime.kernel.beginToolCall({
      sessionId: "error-session",
      toolCallId: "call-read",
      toolName: "read",
      args: { path: "README.md" },
    });

    // Both interceptors produced entries; neither is a divergence (one agrees,
    // one errored), so nothing is persisted.
    expect(drainShadowDivergenceEvidence(runtime, "error-session")).toBe(0);
  });
});
