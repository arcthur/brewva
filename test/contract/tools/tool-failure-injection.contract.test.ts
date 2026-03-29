import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { setStaticContextInjectionBudget } from "../../fixtures/config.js";
import { requireDefined } from "../../helpers/assertions.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("Tool failure context injection", () => {
  test("injects recent failure details for self-correction", async () => {
    const workspace = createTestWorkspace("tool-failures-inject");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-failures-inject-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: test suite failed with 3 failures",
      channelSuccess: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text).toContain("[RuntimeStatus]");
    expect(injection.text).toContain("recent_failures=1");
    expect(injection.text).toContain("tool=exec");
    expect(injection.text).toContain("bun test");
    expect(injection.text).toContain("3 failures");
  });

  test("respects maxEntries and maxOutputChars from config", async () => {
    const workspace = createTestWorkspace("tool-failures-limits");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.toolFailureInjection.maxEntries = 2;
    config.infrastructure.toolFailureInjection.maxOutputChars = 24;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-failures-limits-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_1",
      args: { value: 1 },
      outputText: "error-one",
      channelSuccess: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_2",
      args: { value: 2 },
      outputText: "error-two with extra detail",
      channelSuccess: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_3",
      args: { value: 3 },
      outputText: "error-three with even longer details",
      channelSuccess: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text).toContain("[RuntimeStatus]");
    expect(injection.text).not.toContain("tool=tool_1");
    expect(injection.text).toContain("tool=tool_2");
    expect(injection.text).toContain("tool=tool_3");
    expect(injection.text).toContain("error-three with even");
    expect(injection.text).toContain("...");
  });

  test("skips failure injection when disabled", async () => {
    const workspace = createTestWorkspace("tool-failures-disabled");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.toolFailureInjection.enabled = false;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-failures-disabled-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: fail",
      channelSuccess: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text).not.toContain("[RuntimeStatus]");
    expect(injection.text).not.toContain("[RecentToolOutputsDistilled]");
  });

  test("injects recent distilled tool outputs for compressed execution context", async () => {
    const workspace = createTestWorkspace("tool-output-distilled-inject");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.toolOutputDistillationInjection.enabled = true;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-output-distilled-inject-1";

    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "exec",
        strategy: "exec_heuristic",
        summaryText: "[ExecDistilled]\nstatus: failed\n- Error: test suite failed",
        rawTokens: 160,
        summaryTokens: 32,
        compressionRatio: 0.2,
        artifactRef: ".orchestrator/tool-output-artifacts/sess/tc-exec-distill.txt",
        isError: true,
      },
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text).toContain("[RecentToolOutputsDistilled]");
    expect(injection.text).toContain("tool=exec");
    expect(injection.text).toContain("strategy=exec_heuristic");
    expect(injection.text).toContain("raw_tokens=160");
    expect(injection.text).toContain("summary_tokens=32");
    expect(injection.text).toContain("compression=0.200");
    expect(injection.text).toContain(
      "artifact=.orchestrator/tool-output-artifacts/sess/tc-exec-distill.txt",
    );
    expect(injection.text).toContain("summary: [ExecDistilled] status: failed");
  });

  test("uses explicit verdicts when rendering distilled output status", async () => {
    const workspace = createTestWorkspace("tool-output-distilled-verdict");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.toolOutputDistillationInjection.enabled = true;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-output-distilled-verdict-1";

    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "exec",
        strategy: "exec_heuristic",
        summaryText: "[ExecDistilled]\nstatus: failed\n- FAIL src/foo.test.ts",
        rawTokens: 120,
        summaryTokens: 24,
        compressionRatio: 0.2,
        artifactRef: ".orchestrator/tool-output-artifacts/sess/tc-exec-verdict.txt",
        isError: false,
        verdict: "fail",
      },
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text).toContain("tool=exec status=fail channel=ok");
    expect(injection.text).toContain("summary: [ExecDistilled] status: failed");
  });

  test("respects distilled output maxEntries and maxOutputChars from config", async () => {
    const workspace = createTestWorkspace("tool-output-distilled-limits");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.toolOutputDistillationInjection.enabled = true;
    config.infrastructure.toolOutputDistillationInjection.maxEntries = 1;
    config.infrastructure.toolOutputDistillationInjection.maxOutputChars = 36;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-output-distilled-limits-1";

    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "exec",
        strategy: "exec_heuristic",
        summaryText:
          "[ExecDistilled]\nstatus: failed\n- first summary should be dropped by maxEntries",
        rawTokens: 120,
        summaryTokens: 30,
        compressionRatio: 0.25,
        artifactRef: ".orchestrator/tool-output-artifacts/sess/tc-1.txt",
        isError: true,
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "lsp_diagnostics",
        strategy: "lsp_heuristic",
        summaryText:
          "[LspDistilled] errors=2 warnings=1\n- src/main.ts:12:3 very long summary detail that should be truncated",
        rawTokens: 90,
        summaryTokens: 18,
        compressionRatio: 0.2,
        artifactRef: ".orchestrator/tool-output-artifacts/sess/tc-2.txt",
        isError: false,
      },
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text).toContain("[RecentToolOutputsDistilled]");
    expect(injection.text).not.toContain("tool=exec");
    expect(injection.text).toContain("tool=lsp_diagnostics");
    expect(injection.text).toContain("artifact=.orchestrator/tool-output-artifacts/sess/tc-2.txt");
    expect(injection.text).toContain("summary: [LspDistilled] errors=2 warning");
    expect(injection.text).toContain("...");
  });

  test("persists structured failure context metadata on failed tool results", async () => {
    const workspace = createTestWorkspace("tool-failures-metadata");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-failures-metadata-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test", retries: 1 },
      outputText: "Error: failing test run",
      channelSuccess: false,
    });

    const row = runtime.ledger.listRows(sessionId).at(-1);
    const metadata = row?.metadata as
      | {
          brewvaToolFailureContext?: {
            schema?: string;
            args?: Record<string, unknown>;
            outputText?: string;
            failureClass?: string;
          };
        }
      | undefined;
    expect(metadata?.brewvaToolFailureContext?.schema).toBe("brewva.tool_failure_context.v1");
    expect(metadata?.brewvaToolFailureContext?.args?.command).toBe("bun test");
    expect(metadata?.brewvaToolFailureContext?.outputText).toContain("failing test run");
    expect(metadata?.brewvaToolFailureContext?.failureClass).toBe("execution");
  });

  test("reads persisted failure context output beyond ledger outputSummary cap", async () => {
    const workspace = createTestWorkspace("tool-failures-long-output");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    setStaticContextInjectionBudget(config, 4000);
    config.infrastructure.toolFailureInjection.maxOutputChars = 900;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-failures-long-output-1";
    const outputText = `${"x".repeat(560)}TAIL_MARKER_FROM_PERSISTED_CONTEXT`;

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText,
      channelSuccess: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text).toContain("[RuntimeStatus]");
    expect(injection.text).toContain("TAIL_MARKER_FROM_PERSISTED_CONTEXT");
  });

  test("keeps user failures with brewva_ prefix but skips internal runtime tools", async () => {
    const workspace = createTestWorkspace("tool-failures-prefix-filter");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-failures-prefix-filter-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "brewva_custom_exec",
      args: { command: "custom-runner" },
      outputText: "Error: user tool failed",
      channelSuccess: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "brewva_verify",
      args: { check: "typecheck" },
      outputText: "Error: verifier failed",
      channelSuccess: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text).toContain("[RuntimeStatus]");
    expect(injection.text).toContain("tool=brewva_custom_exec");
    expect(injection.text).not.toContain("tool=brewva_verify");
  });

  test("caps persisted failure args metadata size", async () => {
    const workspace = createTestWorkspace("tool-failures-large-args");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-failures-large-args-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: {
        command: "bun test",
        payload: "x".repeat(30_000),
        nested: {
          values: Array.from({ length: 400 }, (_, i) => `value-${i}`),
        },
      },
      outputText: "Error: large args payload",
      channelSuccess: false,
    });

    const row = runtime.ledger.listRows(sessionId).at(-1);
    const metadata = row?.metadata as
      | {
          brewvaToolFailureContext?: {
            args?: Record<string, unknown>;
          };
        }
      | undefined;

    const persistedArgs = metadata?.brewvaToolFailureContext?.args;
    requireDefined(persistedArgs, "expected failure context args to persist");
    expect(JSON.stringify(persistedArgs).length).toBeLessThanOrEqual(1400);
  });

  test("does not summarize recent failures into ContextTruncated under practical defaults", async () => {
    const workspace = createTestWorkspace("tool-failures-budget");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    setStaticContextInjectionBudget(config, 2400);
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-failures-budget-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_1",
      args: { command: "one", retries: 1 },
      outputText: `${"x".repeat(240)}TAIL_MARKER_1`,
      channelSuccess: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_2",
      args: { command: "two", retries: 2 },
      outputText: `${"y".repeat(240)}TAIL_MARKER_2`,
      channelSuccess: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_3",
      args: { command: "three", retries: 3 },
      outputText: `${"z".repeat(240)}TAIL_MARKER_3`,
      channelSuccess: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text).toContain("[RuntimeStatus]");
    expect(injection.text).not.toContain("source=brewva.tool-failures");
    expect(injection.text).toContain("TAIL_MARKER_3");
  });
});
