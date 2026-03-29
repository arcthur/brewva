import { describe, expect, test } from "bun:test";
import { createExecTool } from "@brewva/brewva-tools";
import {
  requireDefined,
  requireNonEmptyString,
  requireNumber,
  requireRecord,
} from "../../helpers/assertions.js";
import {
  createRuntimeForExecTests,
  extractTextContent,
  fakeContext,
} from "./tools-exec-process.helpers.js";

type RecordedEvent = { type?: string; payload?: Record<string, unknown> };

function requireEvent(events: RecordedEvent[], type: string): RecordedEvent {
  return requireDefined(
    events.find((event) => event.type === type),
    `Expected ${type} event.`,
  );
}

function eventTypes(events: RecordedEvent[]): string[] {
  return events.flatMap((event) => (typeof event.type === "string" ? [event.type] : []));
}

describe("exec sandbox routing", () => {
  test("standard mode falls back to host when sandbox backend is unavailable", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:2",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-fallback-host";

    const result = await execTool.execute(
      "tc-exec-fallback-host",
      {
        command: "echo Authorization: Bearer super-secret-token && echo fallback-ok",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result)).toContain("fallback-ok");
    expect((result.details as { backend?: string }).backend).toBe("host");
    expect(eventTypes(events)).toContain("exec_routed");
    expect(eventTypes(events)).toContain("exec_sandbox_error");
    expect(eventTypes(events)).toContain("exec_fallback_host");
    const routedPayload = requireRecord(
      requireEvent(events, "exec_routed").payload,
      "Expected exec_routed payload.",
    );
    expect(routedPayload.routingPolicy).toBe("best_available");
    expect(routedPayload.command).toBeUndefined();
    expect(requireNonEmptyString(routedPayload.commandHash, "Expected commandHash.")).toHaveLength(
      64,
    );
    const commandRedacted = requireNonEmptyString(
      routedPayload.commandRedacted,
      "Expected commandRedacted.",
    );
    expect(commandRedacted).toContain("<redacted>");
    expect(commandRedacted).not.toContain("super-secret-token");
  });

  test("standard mode with backend=best_available falls back to host even when fallbackToHost is false", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "best_available",
      fallbackToHost: false,
      serverUrl: "http://127.0.0.1:4",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-best-available-implicit-fallback";

    const result = await execTool.execute(
      "tc-exec-best-available-implicit-fallback",
      {
        command: "echo best-available-implicit-fallback",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(result)).toContain("best-available-implicit-fallback");
    expect((result.details as { backend?: string }).backend).toBe("host");
    const routed = events.find((event) => event.type === "exec_routed");
    expect(routed?.payload?.configuredBackend).toBe("best_available");
    expect(routed?.payload?.resolvedBackend).toBe("sandbox");
    expect(routed?.payload?.routingPolicy).toBe("best_available");
    expect(eventTypes(events)).toContain("exec_fallback_host");
  });

  test("standard mode with backend=best_available falls back to host when fallbackToHost is true", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "best_available",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:3",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-best-available-fallback-enabled";

    const result = await execTool.execute(
      "tc-exec-best-available-fallback-enabled",
      {
        command: "echo best-available-fallback-enabled",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result)).toContain("best-available-fallback-enabled");
    expect((result.details as { backend?: string }).backend).toBe("host");
    const routed = events.find((event) => event.type === "exec_routed");
    expect(routed?.payload?.configuredBackend).toBe("best_available");
    expect(routed?.payload?.resolvedBackend).toBe("sandbox");
    expect(routed?.payload?.fallbackToHost).toBe(true);
    expect(routed?.payload?.routingPolicy).toBe("best_available");
    expect(eventTypes(events)).toContain("exec_fallback_host");
  });

  test("standard mode caches sandbox failures and skips immediate sandbox retries", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:1",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-fallback-cached";

    const first = await execTool.execute(
      "tc-exec-fallback-cached-1",
      {
        command: "echo first-fallback",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(first)).toContain("first-fallback");

    const second = await execTool.execute(
      "tc-exec-fallback-cached-2",
      {
        command: "echo second-fallback",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(second)).toContain("second-fallback");

    const sandboxErrors = events.filter((event) => event.type === "exec_sandbox_error");
    expect(sandboxErrors).toHaveLength(1);
    const fallbackEvents = events.filter((event) => event.type === "exec_fallback_host");
    expect(fallbackEvents).toHaveLength(2);
    expect(fallbackEvents[1]?.payload?.reason).toBe("sandbox_unavailable_cached");
    expect(events.filter((event) => event.type === "exec_routed")).toHaveLength(1);
  });

  test("standard mode pins session after repeated sandbox failures and bypasses sandbox retries", async () => {
    const firstAttempt = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:11",
    });
    const secondAttempt = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:12",
    });
    const thirdAttempt = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:13",
    });

    const sessionId = "s13-exec-session-pinned";
    const firstExec = createExecTool({ runtime: firstAttempt.runtime });
    const secondExec = createExecTool({ runtime: secondAttempt.runtime });
    const thirdExec = createExecTool({ runtime: thirdAttempt.runtime });

    const first = await firstExec.execute(
      "tc-exec-session-pinned-1",
      {
        command: "echo first-session-pin",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(first)).toContain("first-session-pin");

    const second = await secondExec.execute(
      "tc-exec-session-pinned-2",
      {
        command: "echo second-session-pin",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(second)).toContain("second-session-pin");

    const secondFallback = secondAttempt.events.find(
      (event) => event.type === "exec_fallback_host",
    );
    expect(secondFallback?.payload?.reason).toBe("sandbox_execution_error");
    requireNumber(
      secondFallback?.payload?.sessionPinnedUntil,
      "Expected numeric sessionPinnedUntil.",
    );
    expect(
      requireNumber(secondFallback?.payload?.sessionPinTtlMs, "Expected numeric sessionPinTtlMs."),
    ).toBeGreaterThan(0);

    const third = await thirdExec.execute(
      "tc-exec-session-pinned-3",
      {
        command: "echo third-session-pin",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(third)).toContain("third-session-pin");
    expect(eventTypes(thirdAttempt.events)).not.toContain("exec_sandbox_error");

    const thirdFallback = thirdAttempt.events.find((event) => event.type === "exec_fallback_host");
    expect(thirdFallback?.payload?.reason).toBe("sandbox_unavailable_session_pinned");
    expect(
      requireNumber(
        thirdFallback?.payload?.sessionPinMsRemaining,
        "Expected numeric sessionPinMsRemaining.",
      ),
    ).toBeGreaterThan(0);
  });

  test("strict mode fails closed when sandbox backend is unavailable", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "strict",
      backend: "best_available",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:1",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-strict-fail-closed";

    expect(
      execTool.execute(
        "tc-exec-strict-fail-closed",
        {
          command: "echo blocked",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    expect(eventTypes(events)).toContain("exec_routed");
    expect(eventTypes(events)).toContain("exec_sandbox_error");
    expect(eventTypes(events)).toContain("exec_blocked_isolation");
    expect(eventTypes(events)).not.toContain("exec_fallback_host");
  });

  test("standard sandbox mode fails closed when fallbackToHost is false", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: false,
      serverUrl: "http://127.0.0.1:1",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-sandbox-fail-closed";

    expect(
      execTool.execute(
        "tc-exec-sandbox-fail-closed",
        {
          command: "echo should-block",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    const routed = events.find((event) => event.type === "exec_routed");
    expect(routed?.payload?.routingPolicy).toBe("fail_closed");
    expect(eventTypes(events)).not.toContain("exec_fallback_host");
    expect(eventTypes(events)).toContain("exec_blocked_isolation");
  });

  test("enforce isolation overrides permissive host routing and fails closed", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
      enforceIsolation: true,
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:1",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-enforce-isolation";

    expect(
      execTool.execute(
        "tc-exec-enforce-isolation",
        {
          command: "echo must-block-when-sandbox-down",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    const routed = requireEvent(events, "exec_routed");
    expect(routed.payload?.configuredBackend).toBe("host");
    expect(routed.payload?.resolvedBackend).toBe("sandbox");
    expect(routed.payload?.routingPolicy).toBe("fail_closed");
    expect(routed.payload?.fallbackToHost).toBe(false);
    expect(routed.payload?.enforceIsolation).toBe(true);
    expect(eventTypes(events)).toContain("exec_sandbox_error");
    expect(eventTypes(events)).toContain("exec_blocked_isolation");
    expect(eventTypes(events)).not.toContain("exec_fallback_host");
  });
});
