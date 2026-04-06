import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEventStream, registerLedgerWriter } from "@brewva/brewva-gateway/runtime-plugins";
import { BrewvaRuntime, VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  createObsQueryTool,
  createObsSloAssertTool,
  createOutputSearchTool,
  defineBrewvaTool,
} from "@brewva/brewva-tools";
import { createMockRuntimePluginApi, invokeHandlers } from "../../helpers/runtime-plugin.js";
import { createBundledToolRuntime } from "../../helpers/runtime.js";

describe("Runtime plugin integration: observability ledger", () => {
  test("records invocation-resolved execution traits into hosted tool lifecycle events", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-execution-traits-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-execution-traits-1";
    const { api, handlers } = createMockRuntimePluginApi();
    const baseTool = createOutputSearchTool({ runtime: createBundledToolRuntime(runtime) });

    const customTool = defineBrewvaTool(baseTool, {
      executionTraits: ({ args }) => {
        const command =
          args &&
          typeof args === "object" &&
          typeof (args as { query?: unknown }).query === "string"
            ? (args as { query: string }).query
            : "";
        return {
          concurrencySafe: !/\b(rm|mv|sed -i)\b/u.test(command),
          interruptBehavior: "cancel",
          streamingEligible: true,
          contextModifying: /\b(rm|mv|sed -i)\b/u.test(command),
        };
      },
    });

    registerEventStream(api, runtime, undefined, {
      toolDefinitionsByName: new Map([[customTool.name, customTool]]),
    });

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-1",
        trigger: "user",
        promptText: "test prompt",
      },
    });

    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-custom-read",
        toolName: customTool.name,
        input: { query: "ls src" },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "tc-custom-write",
        toolName: customTool.name,
        args: { query: "rm -rf tmp" },
      },
      ctx,
    );

    const toolCallPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_call",
      last: 1,
    })[0]?.payload as
      | {
          attempt?: number | null;
          executionTraits?: {
            concurrencySafe?: boolean;
            interruptBehavior?: string;
            streamingEligible?: boolean;
            contextModifying?: boolean;
          } | null;
        }
      | undefined;
    expect(toolCallPayload?.attempt).toBe(1);
    expect(toolCallPayload?.executionTraits).toEqual({
      concurrencySafe: true,
      interruptBehavior: "cancel",
      streamingEligible: true,
      contextModifying: false,
    });

    const toolStartPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_execution_start",
      last: 1,
    })[0]?.payload as
      | {
          attempt?: number | null;
          executionTraits?: {
            concurrencySafe?: boolean;
            interruptBehavior?: string;
            streamingEligible?: boolean;
            contextModifying?: boolean;
          } | null;
        }
      | undefined;
    expect(toolStartPayload?.attempt).toBe(1);
    expect(toolStartPayload?.executionTraits).toEqual({
      concurrencySafe: false,
      interruptBehavior: "cancel",
      streamingEligible: true,
      contextModifying: true,
    });
  });

  test("records authoritative attempt ids on tool lifecycle events after retry supersession", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-tool-attempts-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-tool-attempts-1";
    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-1",
        trigger: "user",
        promptText: "test prompt",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "session_turn_transition",
      payload: {
        reason: "output_budget_escalation",
        status: "entered",
        sequence: 1,
        family: "output_budget",
        attempt: 1,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: null,
      },
    });

    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-attempt-2",
        toolName: "exec",
        input: { command: "pwd" },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "tc-attempt-2",
        toolName: "exec",
        args: { command: "pwd" },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_execution_end",
      {
        toolCallId: "tc-attempt-2",
        toolName: "exec",
        result: { text: "done" },
        isError: false,
      },
      ctx,
    );

    const toolCallPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_call",
      last: 1,
    })[0]?.payload as { attempt?: number | null } | undefined;
    const toolStartPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_execution_start",
      last: 1,
    })[0]?.payload as { attempt?: number | null } | undefined;
    const toolEndPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_execution_end",
      last: 1,
    })[0]?.payload as { attempt?: number | null } | undefined;

    expect(toolCallPayload?.attempt).toBe(2);
    expect(toolStartPayload?.attempt).toBe(2);
    expect(toolEndPayload?.attempt).toBe(2);
  });

  test("records a verification-boundary reasoning checkpoint from durable verification outcomes", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-reasoning-verification-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-reasoning-verification-1";
    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);

    invokeHandlers(
      handlers,
      "turn_start",
      {
        turnIndex: 1,
        timestamp: 1,
      },
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
          getLeafId: () => "leaf-verification-1",
        },
      },
    );

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      payload: {
        schema: "brewva.verification.outcome.v1",
        level: "standard",
        outcome: "pass",
      },
    });

    const state = runtime.inspect.reasoning.getActiveState(sessionId);
    expect(state.checkpoints).toEqual([
      expect.objectContaining({
        checkpointId: "reasoning-checkpoint-1",
        boundary: "turn_start",
        leafEntryId: "leaf-verification-1",
      }),
      expect.objectContaining({
        checkpointId: "reasoning-checkpoint-2",
        boundary: "verification_boundary",
        leafEntryId: "leaf-verification-1",
      }),
    ]);
    expect(state.activeCheckpointId).toBe("reasoning-checkpoint-2");
    expect(state.activeLineageCheckpointIds).toEqual([
      "reasoning-checkpoint-1",
      "reasoning-checkpoint-2",
    ]);
  });

  test("does not auto-record tool-boundary reasoning checkpoints on every tool completion", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-reasoning-tool-boundary-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-reasoning-tool-boundary-1";
    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
        getLeafId: () => "leaf-tool-1",
      },
    };

    invokeHandlers(
      handlers,
      "turn_start",
      {
        turnIndex: 1,
        timestamp: 1,
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_execution_end",
      {
        toolCallId: "tool-call-1",
        toolName: "read",
        isError: false,
      },
      ctx,
    );

    const state = runtime.inspect.reasoning.getActiveState(sessionId);
    expect(state.checkpoints).toEqual([
      expect.objectContaining({
        checkpointId: "reasoning-checkpoint-1",
        boundary: "turn_start",
      }),
    ]);
    expect(state.activeCheckpointId).toBe("reasoning-checkpoint-1");
  });

  test("given high-volume exec tool output with explicit fail verdict, when ledger writer handles tool_result, then verdict propagates into observed and distilled telemetry", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-distill-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-distill-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    const noisyOutput = Array.from({ length: 180 }, (_value, index) =>
      index % 17 === 0
        ? `error at step ${index}: timeout while waiting for response`
        : `line ${index}: working`,
    ).join("\n");

    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-exec-distill",
        toolName: "exec",
        input: { command: "echo test" },
        isError: false,
        content: [{ type: "text", text: noisyOutput }],
        details: { durationMs: 12, verdict: "fail" },
      },
      ctx,
    );

    const observed = runtime.inspect.events.query(sessionId, {
      type: "tool_output_observed",
      last: 1,
    })[0];
    expect(
      (observed?.payload as { isError?: boolean; verdict?: string } | undefined)?.isError,
    ).toBe(false);
    expect(
      (observed?.payload as { isError?: boolean; verdict?: string } | undefined)?.verdict,
    ).toBe("fail");

    const distilled = runtime.inspect.events.query(sessionId, {
      type: "tool_output_distilled",
      last: 1,
    })[0];
    const distilledPayload = distilled?.payload as
      | {
          strategy?: string;
          rawTokens?: number;
          summaryTokens?: number;
          compressionRatio?: number;
          summaryText?: string;
          artifactRef?: string | null;
          verdict?: string;
        }
      | undefined;
    expect(distilledPayload?.strategy).toBe("exec_heuristic");
    expect(distilledPayload?.verdict).toBe("fail");
    expect((distilledPayload?.rawTokens ?? 0) > (distilledPayload?.summaryTokens ?? 0)).toBe(true);
    expect((distilledPayload?.compressionRatio ?? 1) < 1).toBe(true);
    expect(distilledPayload?.summaryText ?? "").toContain("status: failed");
    expect(distilledPayload?.summaryText ?? "").toContain("[ExecDistilled]");
    expect(typeof distilledPayload?.artifactRef).toBe("string");

    const artifactRef =
      (
        runtime.inspect.events.query(sessionId, {
          type: "tool_output_artifact_persisted",
          last: 1,
        })[0]?.payload as { artifactRef?: string } | undefined
      )?.artifactRef ?? "";
    const artifactPath = join(workspace, artifactRef);
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toContain("error at step");

    const recordedPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_result_recorded",
      last: 1,
    })[0]?.payload as
      | {
          outputArtifact?: {
            artifactRef?: string;
          } | null;
          outputDistillation?: {
            strategy?: string;
            rawTokens?: number;
            summaryTokens?: number;
            artifactRef?: string | null;
          } | null;
        }
      | undefined;
    expect(recordedPayload?.outputDistillation?.strategy).toBe("exec_heuristic");
    expect(typeof recordedPayload?.outputDistillation?.artifactRef).toBe("string");
    expect(typeof recordedPayload?.outputArtifact?.artifactRef).toBe("string");
    expect(
      (recordedPayload?.outputDistillation?.rawTokens ?? 0) >
        (recordedPayload?.outputDistillation?.summaryTokens ?? 0),
    ).toBe(true);
  });

  test("given process explicit inconclusive verdict, when tool_result is recorded, then verdict is inconclusive", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-running-inconclusive-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-running-inconclusive-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);

    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-process-running",
        toolName: "process",
        input: { action: "poll", sessionId: "exec-1" },
        isError: false,
        content: [{ type: "text", text: "Process still running." }],
        details: { verdict: "inconclusive", sessionId: "exec-1" },
      },
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    const recordedPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_result_recorded",
      last: 1,
    })[0]?.payload as
      | {
          verdict?: string;
          channelSuccess?: boolean;
        }
      | undefined;
    expect(recordedPayload?.verdict).toBe("inconclusive");
    expect(recordedPayload?.channelSuccess).toBe(true);
    expect(runtime.inspect.ledger.listRows(sessionId)).toHaveLength(1);
    expect(runtime.inspect.ledger.listRows(sessionId)[0]?.verdict).toBe("inconclusive");
  });

  test("given compaction interrupts live tool lifecycle after tool_result, when session_before_compact fires, then event stream closes tool_execution_end before compaction", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-compact-lifecycle-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-compact-lifecycle-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(handlers, "session_start", {}, ctx);
    invokeHandlers(handlers, "turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "tc-compact",
        toolName: "session_compact",
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-compact",
        toolName: "session_compact",
        input: { reason: "critical context pressure" },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-compact",
        toolName: "session_compact",
        input: { reason: "critical context pressure" },
        isError: false,
        content: [
          {
            type: "text",
            text: "Session compaction requested; the gateway will resume the interrupted turn after compaction.",
          },
        ],
        details: { ok: true },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "session_before_compact",
      {
        branchEntries: [{}, {}],
      },
      ctx,
    );

    const events = runtime.inspect.events.query(sessionId);
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.filter((type) => type === "tool_execution_end")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "session_before_compact")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "tool_result_recorded")).toHaveLength(1);
    expect(eventTypes.indexOf("tool_result_recorded")).toBeLessThan(
      eventTypes.indexOf("tool_execution_end"),
    );
    expect(eventTypes.indexOf("tool_execution_end")).toBeLessThan(
      eventTypes.indexOf("session_before_compact"),
    );
  });

  test("records terminal reasons for direct, fallback, and interrupt-driven hosted tool endings", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-terminal-reasons-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-terminal-reasons-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "tc-direct",
        toolName: "exec",
        args: { command: "pwd" },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_execution_end",
      {
        toolCallId: "tc-direct",
        toolName: "exec",
        result: { text: "done" },
        isError: false,
      },
      ctx,
    );

    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "tc-fallback",
        toolName: "exec",
        args: { command: "pwd" },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-fallback",
        toolName: "exec",
        input: { command: "pwd" },
        isError: false,
        content: [{ type: "text", text: "done" }],
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "session_before_compact",
      {
        branchEntries: [],
      },
      ctx,
    );

    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "tc-interrupt",
        toolName: "exec",
        args: { command: "sleep 10" },
      },
      ctx,
    );
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "user_submit_interrupt",
        status: "completed",
        sequence: 1,
        family: "interrupt",
        attempt: null,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: null,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const payloads = runtime.inspect.events
      .query(sessionId, { type: "tool_execution_end" })
      .map((event) => {
        return event.payload as
          | {
              toolCallId?: string;
              terminalReason?: string;
              isError?: boolean;
            }
          | undefined;
      });

    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "tc-direct",
          terminalReason: "completed",
          isError: false,
        }),
        expect.objectContaining({
          toolCallId: "tc-fallback",
          terminalReason: "completed_after_tool_result",
          isError: false,
        }),
        expect.objectContaining({
          toolCallId: "tc-interrupt",
          terminalReason: "cancelled_by_interrupt",
          isError: true,
        }),
      ]),
    );
  });

  test("given obs_query result override, when ledger writer records the tool result, then output_search can reuse the raw artifact", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-obs-query-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-obs-query-1";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 780,
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 820,
      },
    });

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);
    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    const tool = createObsQueryTool({ runtime: createBundledToolRuntime(runtime) });
    const toolResult = await tool.execute(
      "tc-obs-query",
      {
        types: ["startup_sample"],
        where: { service: "api" },
        metric: "startupMs",
        aggregation: "p95",
      },
      undefined,
      undefined,
      ctx as never,
    );

    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-obs-query",
        toolName: "obs_query",
        input: {
          types: ["startup_sample"],
          where: { service: "api" },
          metric: "startupMs",
          aggregation: "p95",
        },
        isError: false,
        content: toolResult.content,
        details: toolResult.details as Record<string, unknown> | undefined,
      },
      ctx,
    );

    const artifactRef =
      (
        runtime.inspect.events.query(sessionId, {
          type: "tool_output_artifact_persisted",
          last: 1,
        })[0]?.payload as { artifactRef?: string } | undefined
      )?.artifactRef ?? "";
    expect(artifactRef.length).toBeGreaterThan(0);
    expect(readFileSync(join(workspace, artifactRef), "utf8")).toContain('"toolName": "obs_query"');

    const outputSearchTool = createOutputSearchTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const outputSearchResult = await outputSearchTool.execute(
      "tc-output-search",
      { query: "startupMs" },
      undefined,
      undefined,
      ctx as never,
    );
    const outputSearchText = outputSearchResult.content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("\n");
    expect(outputSearchText).toContain(artifactRef);

    const recordedPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_result_recorded",
      last: 1,
    })[0]?.payload as
      | {
          outputArtifact?: {
            artifactRef?: string;
          } | null;
        }
      | undefined;
    expect(recordedPayload?.outputArtifact?.artifactRef).toBe(artifactRef);
  });

  test("given obs_slo_assert explicit verdicts, when ledger writer records the tool result, then ledger verdicts and truth sync follow the declared verdict", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-obs-assert-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-obs-assert-1";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 910,
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 930,
      },
    });

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);
    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };
    const tool = createObsSloAssertTool({ runtime: createBundledToolRuntime(runtime) });

    const failResult = await tool.execute(
      "tc-obs-assert-fail",
      {
        types: ["startup_sample"],
        where: { service: "api" },
        metric: "startupMs",
        aggregation: "p95",
        operator: "<=",
        threshold: 800,
        minSamples: 2,
      },
      undefined,
      undefined,
      ctx as never,
    );
    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-obs-assert-fail",
        toolName: "obs_slo_assert",
        input: {
          types: ["startup_sample"],
          where: { service: "api" },
          metric: "startupMs",
          aggregation: "p95",
          operator: "<=",
          threshold: 800,
          minSamples: 2,
        },
        isError: false,
        content: failResult.content,
        details: failResult.details as Record<string, unknown> | undefined,
      },
      ctx,
    );

    expect(runtime.inspect.ledger.listRows(sessionId).at(-1)?.verdict).toBe("fail");
    expect(
      runtime.inspect.truth
        .getState(sessionId)
        .facts.some(
          (fact) => fact.kind === "observability_slo_violation" && fact.status === "active",
        ),
    ).toBe(true);

    const inconclusiveResult = await tool.execute(
      "tc-obs-assert-inconclusive",
      {
        types: ["startup_sample"],
        where: { service: "api" },
        metric: "startupMs",
        aggregation: "p95",
        operator: "<=",
        threshold: 800,
        minSamples: 3,
      },
      undefined,
      undefined,
      ctx as never,
    );
    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-obs-assert-inconclusive",
        toolName: "obs_slo_assert",
        input: {
          types: ["startup_sample"],
          where: { service: "api" },
          metric: "startupMs",
          aggregation: "p95",
          operator: "<=",
          threshold: 800,
          minSamples: 3,
        },
        isError: false,
        content: inconclusiveResult.content,
        details: inconclusiveResult.details as Record<string, unknown> | undefined,
      },
      ctx,
    );

    expect(runtime.inspect.ledger.listRows(sessionId).at(-1)?.verdict).toBe("inconclusive");
  });

  test("given failed tool_execution_end without tool_result, when observability handlers run, then fallback output and ledger events are persisted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-fallback-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-fallback-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    registerLedgerWriter(api, runtime);
    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(handlers, "session_start", {}, ctx);
    invokeHandlers(handlers, "turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "tc-fallback-lsp",
        toolName: "lsp_symbols",
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "tool_execution_end",
      {
        toolCallId: "tc-fallback-lsp",
        toolName: "lsp_symbols",
        isError: true,
      },
      ctx,
    );

    const observedPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_output_observed",
      last: 1,
    })[0]?.payload as
      | {
          toolCallId?: string;
          toolName?: string;
        }
      | undefined;
    expect(observedPayload?.toolCallId).toBe("tc-fallback-lsp");
    expect(observedPayload?.toolName).toBe("lsp_symbols");

    const recordedPayload = runtime.inspect.events.query(sessionId, {
      type: "tool_result_recorded",
      last: 1,
    })[0]?.payload as
      | {
          verdict?: string;
        }
      | undefined;
    expect(recordedPayload?.verdict).toBe("fail");
    expect(runtime.inspect.ledger.listRows(sessionId)).toHaveLength(1);
    expect(runtime.inspect.ledger.listRows(sessionId)[0]?.tool).toBe("lsp_symbols");
    expect(
      (
        runtime.inspect.ledger.listRows(sessionId)[0]?.metadata as
          | {
              lifecycleFallbackReason?: string;
            }
          | undefined
      )?.lifecycleFallbackReason,
    ).toBe("tool_execution_end_without_tool_result");
  });
});
