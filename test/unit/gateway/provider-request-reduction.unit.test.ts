import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import type { SessionLifecycleSnapshot } from "@brewva/brewva-vocabulary/session";
import { CLEARED_TOOL_RESULT_PLACEHOLDER } from "../../../packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction-walker.js";
import {
  PROVIDER_REQUEST_REDUCTION_TEST_ONLY,
  registerProviderRequestReduction,
} from "../../../packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.js";
import type { HostedRuntimeAdapterPort } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import { createRuntimeConfig, createRuntimeInstanceFixture } from "../../helpers/runtime.js";

const { resolveReductionPostureBlockReason } = PROVIDER_REQUEST_REDUCTION_TEST_ONLY;

function baseSnapshot(sessionId: string): SessionLifecycleSnapshot {
  return {
    sessionId,
    hydration: "fresh",
    execution: { kind: "idle" },
    integrity: "ok",
    recovery: {
      mode: "idle",
      latestReason: null,
      latestStatus: null,
      pendingFamily: null,
      degradedReason: null,
      duplicateSideEffectSuppressionCount: 0,
      latestSourceEventId: null,
      latestSourceEventType: null,
      recentTransitions: [],
    },
    approval: {
      status: "idle",
      pendingCount: 0,
      requestId: null,
      toolCallId: null,
      toolName: null,
      subject: null,
    },
    tooling: { openToolCalls: [] },
    summary: { kind: "idle", reason: null, detail: null },
  } as SessionLifecycleSnapshot;
}

/**
 * The recovery posture the four-port lifecycle producer surfaces while a turn is
 * suspended mid-recovery (its latest event is a `runtime.suspended` commit): the
 * recovery family is pending and its transition has been entered.
 */
function recoveryPostureSnapshot(sessionId: string): SessionLifecycleSnapshot {
  const snapshot = baseSnapshot(sessionId);
  return {
    ...snapshot,
    execution: { kind: "running", detail: "runtime_turn_active" },
    recovery: {
      ...snapshot.recovery,
      mode: "observed",
      latestReason: "compaction_required",
      latestStatus: "entered",
      pendingFamily: "recovery",
      latestSourceEventType: "runtime.suspended",
      recentTransitions: ["compaction_required"],
    },
    summary: { kind: "running", reason: "compaction_required", detail: "runtime.suspended" },
  } as SessionLifecycleSnapshot;
}

/** Minimal runtime whose lifecycle snapshot is the only surface the gate reads. */
function lifecycleRuntime(snapshot: SessionLifecycleSnapshot): HostedRuntimeAdapterPort {
  return {
    ops: { lifecycle: { getSnapshot: () => snapshot } },
  } as unknown as HostedRuntimeAdapterPort;
}

type BeforeProviderRequestHandler = (
  event: {
    type: "before_provider_request";
    payload: unknown;
    provider: string;
    api: string;
    modelId: string;
  },
  ctx: { sessionManager: { getSessionId(): string } },
) => unknown;

function captureBeforeProviderRequestHandler(
  runtime: ReturnType<typeof createRuntimeInstanceFixture>,
): BeforeProviderRequestHandler {
  const handlers: BeforeProviderRequestHandler[] = [];
  const api = {
    on(event: string, handler: BeforeProviderRequestHandler) {
      if (event === "before_provider_request") {
        handlers.push(handler);
      }
    },
  } as unknown as InternalHostPluginApi;

  registerProviderRequestReduction(api, runtime);
  const handler = handlers[0];
  if (!handler) {
    throw new Error("before_provider_request handler not registered");
  }
  return handler;
}

describe("registerProviderRequestReduction", () => {
  test("uses the current provider payload size instead of stale runtime usage", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-provider-request-reduction-")),
      config: createRuntimeConfig(),
    });
    const sessionId = "payload-size-session";
    runtime.ops.context.usage.observe(sessionId, {
      tokens: 10_000,
      contextWindow: 100_000,
      percent: 10,
    });
    const handler = captureBeforeProviderRequestHandler(runtime);
    const payload = {
      input: [
        { type: "function_call", call_id: "call-1", name: "grep" },
        { type: "function_call_output", call_id: "call-1", output: "x".repeat(88_000) },
      ],
    };

    const reduced = handler(
      {
        type: "before_provider_request",
        payload,
        provider: "openai-codex",
        api: "openai-codex-responses",
        modelId: "gpt-5.5",
      },
      { sessionManager: { getSessionId: () => sessionId } },
    ) as typeof payload | undefined;

    expect(reduced).toEqual({
      input: [
        { type: "function_call", call_id: "call-1", name: "grep" },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: CLEARED_TOOL_RESULT_PLACEHOLDER,
        },
      ],
    });
    expect(payload.input[1]?.output).not.toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
  });

  test("recovery posture on the lifecycle snapshot blocks reduction (previously a permanent no-op)", () => {
    // Before the producer fix the snapshot never carried a pending recovery family,
    // so this resolver could only ever return null and the recovery/degraded gate
    // was dead. A suspended-recovery snapshot must now surface a block reason, which
    // suppresses the discretionary reduction paths in the eligibility decision.
    expect(
      resolveReductionPostureBlockReason(lifecycleRuntime(recoveryPostureSnapshot("s1")), "s1"),
    ).toBe("recovery posture is active");
  });

  test("an entered recovery transition (without a pending family) still blocks", () => {
    const snapshot = baseSnapshot("s1");
    const enteredTransition = {
      ...snapshot,
      recovery: { ...snapshot.recovery, latestStatus: "entered" },
    } as SessionLifecycleSnapshot;
    expect(resolveReductionPostureBlockReason(lifecycleRuntime(enteredTransition), "s1")).toBe(
      "recovery posture is active",
    );
  });

  test("an idle session does not block reduction", () => {
    expect(
      resolveReductionPostureBlockReason(lifecycleRuntime(baseSnapshot("s1")), "s1"),
    ).toBeNull();
  });
});
