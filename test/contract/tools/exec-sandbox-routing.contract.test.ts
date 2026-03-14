import { describe, expect, test } from "bun:test";
import { createExecTool } from "@brewva/brewva-tools";
import {
  createRuntimeForExecTests,
  extractTextContent,
  fakeContext,
} from "./tools-exec-process.helpers.js";

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
    expect(events.some((event) => event.type === "exec_routed")).toBe(true);
    expect(events.some((event) => event.type === "exec_sandbox_error")).toBe(true);
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(true);
    const routedPayload = events.find((event) => event.type === "exec_routed")?.payload ?? {};
    expect(routedPayload.routingPolicy).toBe("best_available");
    expect(routedPayload.command).toBeUndefined();
    expect(typeof routedPayload.commandHash).toBe("string");
    expect((routedPayload.commandHash as string).length).toBe(64);
    expect(typeof routedPayload.commandRedacted).toBe("string");
    expect(routedPayload.commandRedacted as string).toContain("<redacted>");
    expect(routedPayload.commandRedacted as string).not.toContain("super-secret-token");
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
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(true);
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
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(true);
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
    expect(typeof secondFallback?.payload?.sessionPinnedUntil).toBe("number");
    expect(typeof secondFallback?.payload?.sessionPinTtlMs).toBe("number");
    expect((secondFallback?.payload?.sessionPinTtlMs as number) > 0).toBe(true);

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
    expect(thirdAttempt.events.some((event) => event.type === "exec_sandbox_error")).toBe(false);

    const thirdFallback = thirdAttempt.events.find((event) => event.type === "exec_fallback_host");
    expect(thirdFallback?.payload?.reason).toBe("sandbox_unavailable_session_pinned");
    expect(typeof thirdFallback?.payload?.sessionPinMsRemaining).toBe("number");
    expect((thirdFallback?.payload?.sessionPinMsRemaining as number) > 0).toBe(true);
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

    expect(events.some((event) => event.type === "exec_routed")).toBe(true);
    expect(events.some((event) => event.type === "exec_sandbox_error")).toBe(true);
    expect(events.some((event) => event.type === "exec_blocked_isolation")).toBe(true);
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(false);
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
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(false);
    expect(events.some((event) => event.type === "exec_blocked_isolation")).toBe(true);
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

    const routed = events.find((event) => event.type === "exec_routed");
    expect(routed).toBeDefined();
    expect(routed?.payload?.configuredBackend).toBe("host");
    expect(routed?.payload?.resolvedBackend).toBe("sandbox");
    expect(routed?.payload?.routingPolicy).toBe("fail_closed");
    expect(routed?.payload?.fallbackToHost).toBe(false);
    expect(routed?.payload?.enforceIsolation).toBe(true);
    expect(events.some((event) => event.type === "exec_sandbox_error")).toBe(true);
    expect(events.some((event) => event.type === "exec_blocked_isolation")).toBe(true);
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(false);
  });
});
