import { describe, expect, test } from "bun:test";
import type {
  BrewvaToolContext,
  BrewvaToolDefinition as ToolDefinition,
} from "@brewva/brewva-substrate/tools";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools/contracts";
import {
  TOOL_CHAIN_RESULT_RECORDED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import { Type, type TProperties } from "@sinclair/typebox";
import { createToolChainTool } from "../../../packages/brewva-tools/src/families/execution/tool-chain.js";
import { errTextResult, okTextResult } from "../../../packages/brewva-tools/src/utils/result.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

interface Fixture {
  runtime: BrewvaBundledToolRuntime;
  recordResultCalls: Record<string, unknown>[];
  recordChainCalls: Record<string, unknown>[];
  emitted: { type: string; payload: Record<string, unknown> }[];
}

/**
 * Minimal capability fixture. `tool_chain` only touches three capabilities
 * (`access.getActionPolicy`, `invocation.recordResult`,
 * `invocation.recordChainResult`); the capability-scope wrapper would throw on
 * any undeclared access, so exercising the tool also proves those three are the
 * only capabilities it uses.
 */
function makeFixture(actionClassByTool: Record<string, string>): Fixture {
  const recordResultCalls: Record<string, unknown>[] = [];
  const recordChainCalls: Record<string, unknown>[] = [];
  const emitted: { type: string; payload: Record<string, unknown> }[] = [];
  const runtime = {
    identity: { cwd: "/tmp/brewva", workspaceRoot: "/tmp/brewva", agentId: "agent-test" },
    config: {},
    capabilities: {
      tools: {
        access: {
          getActionPolicy(name: string) {
            const actionClass = actionClassByTool[name];
            return actionClass ? { actionClass } : undefined;
          },
        },
        invocation: {
          recordResult(payload: Record<string, unknown>) {
            recordResultCalls.push(payload);
            emitted.push({ type: TOOL_RESULT_RECORDED_EVENT_TYPE, payload });
            return undefined;
          },
          recordChainResult(payload: Record<string, unknown>) {
            recordChainCalls.push(payload);
            emitted.push({ type: TOOL_CHAIN_RESULT_RECORDED_EVENT_TYPE, payload });
            return undefined;
          },
        },
      },
    },
  } as unknown as BrewvaBundledToolRuntime;
  return { runtime, recordResultCalls, recordChainCalls, emitted };
}

const CTX = {
  sessionManager: { getSessionId: () => "session-test", getLeafId: () => null },
} as unknown as BrewvaToolContext;

function fakeTool(
  name: string,
  opts: { params?: TProperties; fail?: boolean; text?: string } = {},
): ToolDefinition {
  return {
    name,
    label: name,
    description: `fake ${name}`,
    parameters: Type.Object(opts.params ?? {}),
    async execute() {
      return opts.fail
        ? errTextResult(`${name} failed`)
        : okTextResult(opts.text ?? `${name} output`);
    },
  } as unknown as ToolDefinition;
}

function siblings(...tools: ToolDefinition[]): (name: string) => ToolDefinition | undefined {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return (name) => byName.get(name);
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

async function run(
  fixture: Fixture,
  resolveSibling: (name: string) => ToolDefinition | undefined,
  params: unknown,
) {
  const tool = createToolChainTool({ runtime: fixture.runtime, resolveSibling });
  return tool.execute("chain-1", params as never, new AbortController().signal, undefined, CTX);
}

describe("tool_chain", () => {
  test("runs read-only steps and returns only the last result by default", async () => {
    const fixture = makeFixture({ grep: "workspace_read", read: "workspace_read" });
    const resolve = siblings(
      fakeTool("grep", { text: "grep hit" }),
      fakeTool("read", { text: "file body" }),
    );

    const result = await run(fixture, resolve, {
      steps: [
        { tool: "grep", args: {} },
        { tool: "read", args: {} },
      ],
    });

    expect(result.outcome.kind).toBe("ok");
    const text = textOf(result);
    expect(text).toContain("file body"); // last step surfaced
    expect(text).not.toContain("grep hit"); // intermediate step stays out of context
    expect(fixture.recordResultCalls).toHaveLength(2); // one advisory receipt per dispatched step
    expect(fixture.recordChainCalls).toHaveLength(1); // one envelope receipt
    expect(fixture.recordChainCalls[0]).toMatchObject({
      stepsRun: 2,
      stopped: false,
      returnSelection: "last",
      chainId: "chain-1",
    });
    expect(toolOutcomePayload(result)).toMatchObject({ stepsRun: 2, stopped: false });
  });

  test("returnSteps 'all' surfaces every step", async () => {
    const fixture = makeFixture({ grep: "runtime_observe", read: "workspace_read" });
    const result = await run(
      fixture,
      siblings(fakeTool("grep", { text: "AAA" }), fakeTool("read", { text: "BBB" })),
      { steps: [{ tool: "grep" }, { tool: "read" }], returnSteps: "all" },
    );
    const text = textOf(result);
    expect(text).toContain("AAA");
    expect(text).toContain("BBB");
  });

  test("returnSteps explicit indices surface only the chosen subset", async () => {
    const fixture = makeFixture({ grep: "runtime_observe", read: "workspace_read" });
    const result = await run(
      fixture,
      siblings(fakeTool("grep", { text: "AAA" }), fakeTool("read", { text: "BBB" })),
      { steps: [{ tool: "grep" }, { tool: "read" }], returnSteps: [0] },
    );
    const text = textOf(result);
    expect(text).toContain("AAA");
    expect(text).not.toContain("BBB");
  });

  test("rejects a non-read-only step before dispatch and stops the chain", async () => {
    const fixture = makeFixture({ grep: "workspace_read", exec: "local_exec_effectful" });
    const result = await run(
      fixture,
      siblings(fakeTool("grep", { text: "hit" }), fakeTool("exec", { text: "ran" })),
      { steps: [{ tool: "grep" }, { tool: "exec" }] },
    );

    expect(result.outcome.kind).toBe("err");
    const payload = toolOutcomePayload(result) as Record<string, unknown>;
    expect(payload).toMatchObject({ stopped: true, stepsRun: 1 });
    expect(String(payload.stopReason)).toContain("not read-only");
    expect(fixture.recordResultCalls).toHaveLength(1); // only grep dispatched; exec rejected pre-dispatch
    expect(fixture.recordChainCalls[0]).toMatchObject({ stepsRun: 1, stopped: true });
    expect(textOf(result)).toContain("stopped"); // stop reason surfaced to the model
  });

  test("falls back to the runtime sibling resolver for tools added outside the bundle", async () => {
    // Reproduction for the bundle-only-resolver bug: `read`/`edit`/`write`/custom/
    // MCP are registered on the session by the gateway, NOT in the bundle closure.
    // Without the runtime fallback, `resolveSibling("read")` is undefined and the
    // description's own `grep -> read` recommendation stops at "unknown tool 'read'".
    const fixture = makeFixture({ grep: "workspace_read", read: "workspace_read" });
    const bundleOnly = siblings(fakeTool("grep", { text: "grep hit" })); // no `read`
    const runtimeWithResolver = {
      ...fixture.runtime,
      toolSiblingResolver: {
        resolve: (name: string) =>
          name === "read" ? fakeTool("read", { text: "file body" }) : undefined,
      },
    } as unknown as BrewvaBundledToolRuntime;

    const tool = createToolChainTool({ runtime: runtimeWithResolver, resolveSibling: bundleOnly });
    const result = await tool.execute(
      "chain-1",
      { steps: [{ tool: "grep" }, { tool: "read" }], returnSteps: "all" } as never,
      new AbortController().signal,
      undefined,
      CTX,
    );

    expect(result.outcome.kind).toBe("ok");
    expect(textOf(result)).toContain("file body"); // read resolved via runtime resolver + dispatched
    expect(fixture.recordChainCalls[0]).toMatchObject({ stepsRun: 2, stopped: false });
    // Each step receipt carries the per-step call id for cross-plane reference.
    const chainSteps = fixture.recordChainCalls[0]!.steps as { toolCallId: string }[];
    expect(chainSteps[0]!.toolCallId).toBe("chain-1:step:0");
    expect(chainSteps[1]!.toolCallId).toBe("chain-1:step:1");
    expect(fixture.recordResultCalls[1]).toMatchObject({ toolCallId: "chain-1:step:1" });
  });

  test("rejects an unknown tool", async () => {
    const fixture = makeFixture({ grep: "workspace_read" });
    const result = await run(fixture, siblings(fakeTool("grep")), {
      steps: [{ tool: "grep" }, { tool: "nope" }],
    });
    expect(result.outcome.kind).toBe("err");
    expect(String((toolOutcomePayload(result) as Record<string, unknown>).stopReason)).toContain(
      "unknown tool",
    );
    expect(fixture.recordResultCalls).toHaveLength(1);
  });

  test("stops at the first failing step and records its fail verdict", async () => {
    const fixture = makeFixture({
      grep: "workspace_read",
      read: "workspace_read",
      more: "workspace_read",
    });
    const result = await run(
      fixture,
      siblings(
        fakeTool("grep", { text: "ok" }),
        fakeTool("read", { fail: true }),
        fakeTool("more", { text: "unreached" }),
      ),
      { steps: [{ tool: "grep" }, { tool: "read" }, { tool: "more" }] },
    );

    expect(result.outcome.kind).toBe("err");
    expect(fixture.recordResultCalls).toHaveLength(2); // grep + read ran; 'more' never reached
    expect(fixture.recordResultCalls[1]).toMatchObject({ toolName: "read", verdict: "fail" });
    expect(fixture.recordChainCalls[0]).toMatchObject({ stepsRun: 2, stopped: true });
    expect(textOf(result)).not.toContain("unreached");
  });

  test("rejects a step whose args fail schema validation before dispatch", async () => {
    const fixture = makeFixture({ grep: "workspace_read" });
    const result = await run(
      fixture,
      siblings(fakeTool("grep", { params: { q: Type.String() } })),
      {
        steps: [{ tool: "grep", args: {} }], // missing required `q`
      },
    );
    expect(result.outcome.kind).toBe("err");
    expect(String((toolOutcomePayload(result) as Record<string, unknown>).stopReason)).toContain(
      "args failed validation",
    );
    expect(fixture.recordResultCalls).toHaveLength(0); // never dispatched
  });

  test("emits only advisory receipts and never a canonical commit (axiom 17)", async () => {
    const fixture = makeFixture({
      grep: "workspace_read",
      read: "workspace_read",
      glob: "runtime_observe",
    });
    await run(fixture, siblings(fakeTool("grep"), fakeTool("read"), fakeTool("glob")), {
      steps: [{ tool: "grep" }, { tool: "read" }, { tool: "glob" }],
    });
    const types = fixture.emitted.map((entry) => entry.type);
    expect(types.filter((type) => type === TOOL_RESULT_RECORDED_EVENT_TYPE)).toHaveLength(3);
    expect(types.filter((type) => type === TOOL_CHAIN_RESULT_RECORDED_EVENT_TYPE)).toHaveLength(1);
    // tool_chain declares only advisory capabilities; it has no way to commit,
    // so internal steps never emit a canonical tool.committed. The single
    // canonical commit is the envelope's own return (see the contract test).
    expect(types).not.toContain("tool.committed");
    expect(types).not.toContain("tool.proposed");
  });

  test("chain receipt carries every step's result preview for replay (fitness)", async () => {
    const fixture = makeFixture({ grep: "workspace_read", read: "workspace_read" });
    const result = await run(
      fixture,
      siblings(
        fakeTool("grep", { text: "grep hit body" }),
        fakeTool("read", { text: "file body text" }),
      ),
      { steps: [{ tool: "grep" }, { tool: "read" }] }, // default returnSteps "last"
    );

    // Even though only the last step entered context, the chain receipt records
    // BOTH steps' result previews on the tape — replay-visible, context-absent.
    const chainSteps = fixture.recordChainCalls[0]!.steps as {
      toolName: string;
      resultText: string;
      truncated: boolean;
    }[];
    expect(chainSteps).toHaveLength(2);
    expect(chainSteps[0]).toMatchObject({ toolName: "grep", truncated: false });
    expect(chainSteps[0]!.resultText).toContain("grep hit body");
    expect(chainSteps[1]!.resultText).toContain("file body text");
    // The intermediate step is on the receipt but NOT in the returned content.
    expect(textOf(result)).not.toContain("grep hit body");
  });

  test("bounds a large step result on the chain receipt with truncation markers", async () => {
    const big = "x".repeat(5000);
    const fixture = makeFixture({ read: "workspace_read" });
    await run(fixture, siblings(fakeTool("read", { text: big })), {
      steps: [{ tool: "read" }],
    });
    const step = (
      fixture.recordChainCalls[0]!.steps as {
        resultText: string;
        truncated: boolean;
        fullChars: number;
      }[]
    )[0]!;
    expect(step.truncated).toBe(true);
    expect(step.fullChars).toBe(5000);
    expect(step.resultText.length).toBe(2000);
  });

  test("stops immediately when the abort signal is already set", async () => {
    const fixture = makeFixture({ grep: "workspace_read" });
    const controller = new AbortController();
    controller.abort();
    const tool = createToolChainTool({
      runtime: fixture.runtime,
      resolveSibling: siblings(fakeTool("grep")),
    });
    const result = await tool.execute(
      "chain-abort",
      { steps: [{ tool: "grep" }] } as never,
      controller.signal,
      undefined,
      CTX,
    );
    expect(result.outcome.kind).toBe("err");
    expect(String((toolOutcomePayload(result) as Record<string, unknown>).stopReason)).toContain(
      "aborted",
    );
    expect(fixture.recordResultCalls).toHaveLength(0); // no step dispatched
    expect(fixture.recordChainCalls).toHaveLength(1); // chain receipt still emitted
  });
});
