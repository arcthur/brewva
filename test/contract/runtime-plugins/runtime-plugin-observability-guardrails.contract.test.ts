import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEventStream, registerQualityGate } from "@brewva/brewva-gateway/runtime-plugins";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { requireDefined, requireNumber, requireRecord } from "../../helpers/assertions.js";
import { createMockRuntimePluginApi, invokeHandlers } from "../../helpers/runtime-plugin.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";

function findBlockedResult(results: unknown[]): unknown {
  return requireDefined(
    results.find((result) => (result as { block?: boolean })?.block === true),
    "Expected blocked runtime-plugin result.",
  );
}

describe("Runtime plugin integration: observability guardrails", () => {
  test("given blocked tool_call, when handlers run with stopOnBlock, then tool_call is recorded and tool_call_marked is omitted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-blocked-"));
    mkdirSync(join(workspace, ".brewva/skills/core/blocktool"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/core/blocktool/SKILL.md"),
      `---
name: blocktool
description: blocktool skill
tags: [blocktool]
selection:
  when_to_use: Use when the task needs the routed test skill.
  examples: [test skill]
  phases: [align]
intent:
  outputs: []
effects:
  allowed_effects: [workspace_read]
  denied_effects: [workspace_write]
resources:
  default_lease:
    max_tool_calls: 10
    max_tokens: 10000
  hard_ceiling:
    max_tool_calls: 20
    max_tokens: 20000
execution_hints:
  preferred_tools: [read]
  fallback_tools: [edit]
consumes: []
requires: []
---
blocktool`,
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "ext-blocked-1";
    expect(runtime.skills.activate(sessionId, "blocktool").ok).toBe(true);

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    registerQualityGate(api, runtime);

    const results = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-write-1",
        toolName: "write",
        input: { file_path: "src/a.ts", content: "x" },
      },
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
      { stopOnBlock: true },
    );

    findBlockedResult(results);
    expect(runtime.events.query(sessionId, { type: "tool_call", last: 1 })).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_call_marked", last: 1 })).toHaveLength(0);
    expect(
      runtime.events.query(sessionId, { type: "file_snapshot_captured", last: 1 }),
    ).toHaveLength(0);
  });

  test("given max_tool_calls exceeded, when normal and lifecycle tools are invoked, then normal tool is blocked and skill_complete is allowed", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-max-tool-calls-"));
    mkdirSync(join(workspace, ".brewva/skills/core/maxcalls"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/core/maxcalls/SKILL.md"),
      `---
name: maxcalls
description: maxcalls skill
tags: [maxcalls]
selection:
  when_to_use: Use when the task needs the routed test skill.
  examples: [test skill]
  phases: [align]
intent:
  outputs: []
effects:
  allowed_effects: [workspace_read, workspace_write]
resources:
  default_lease:
    max_tool_calls: 1
    max_tokens: 10000
  hard_ceiling:
    max_tool_calls: 2
    max_tokens: 20000
execution_hints:
  preferred_tools: [read, edit]
  fallback_tools: []
consumes: []
requires: []
---
maxcalls`,
      "utf8",
    );

    const config = createOpsRuntimeConfig();
    config.security.mode = "strict";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "ext-max-tool-calls-1";
    expect(runtime.skills.activate(sessionId, "maxcalls").ok).toBe(true);
    expect(
      runtime.skills.getActive(sessionId)?.contract.resources?.defaultLease?.maxToolCalls,
    ).toBe(1);

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    registerQualityGate(api, runtime);

    runtime.tools.markCall(sessionId, "read");

    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-grep-1",
        toolName: "edit",
        input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
      },
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
      { stopOnBlock: true },
    );
    findBlockedResult(blocked);

    const lifecycle = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-complete-2",
        toolName: "skill_complete",
        input: { outputs: {} },
      },
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
      { stopOnBlock: true },
    );
    expect(lifecycle.find((result) => (result as { block?: boolean })?.block === true)).toBe(
      undefined,
    );

    expect(runtime.events.query(sessionId, { type: "tool_call" })).toHaveLength(2);
    expect(runtime.events.query(sessionId, { type: "tool_call_marked" })).toHaveLength(2);
    const blockedEvents = runtime.events.query(sessionId, { type: "tool_call_blocked" });
    requireDefined(
      blockedEvents.find(
        (event) =>
          typeof event.payload?.reason === "string" &&
          event.payload.reason.includes("maxToolCalls"),
      ),
      "Expected maxToolCalls blocked event.",
    );
  });

  test("given assistant delta events, when the message completes, then only the durable message_end summary is persisted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-throttle-"));
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "ext-throttle-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(handlers, "message_start", { message: { role: "assistant", content: [] } }, ctx);
    invokeHandlers(
      handlers,
      "message_update",
      {
        message: { role: "assistant", content: [{ type: "text", text: "a" }] },
        assistantMessageEvent: { type: "text_delta", delta: "a" },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "message_update",
      {
        message: { role: "assistant", content: [{ type: "text", text: "ab" }] },
        assistantMessageEvent: { type: "text_delta", delta: "b" },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "message_update",
      {
        message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
        assistantMessageEvent: { type: "text_delta", delta: "c" },
      },
      ctx,
    );
    invokeHandlers(
      handlers,
      "message_end",
      {
        message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
      },
      ctx,
    );

    expect(runtime.events.query(sessionId, { type: "message_update" })).toHaveLength(0);
    const ends = runtime.events.query(sessionId, { type: "message_end" });
    expect(ends).toHaveLength(1);
    const payload = ends[0]?.payload as { health?: { score?: number; windowChars?: number } };
    const health = requireRecord(payload.health, "Expected message_end health summary.") as {
      score?: unknown;
      windowChars?: unknown;
    };
    requireNumber(health.score, "Expected numeric health.score.");
    expect(health.windowChars).toBe(3);
  });
});
