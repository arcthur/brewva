import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distillToolOutput } from "@brewva/brewva-gateway/runtime-plugins";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createBrowserTools } from "@brewva/brewva-tools";
import {
  createModelCapabilityRegistry,
  normalizeAssistantMessageToolCalls,
} from "../../../packages/brewva-gateway/src/runtime-plugins/provider-compatibility.js";

type NormalizeInput = Parameters<typeof normalizeAssistantMessageToolCalls>[0];
type HostedTool = NonNullable<NormalizeInput["tools"]>[number];
type ModelLike = Parameters<ReturnType<typeof createModelCapabilityRegistry>["patchRequest"]>[0];

function createAssistantMessage(
  content: NormalizeInput["message"]["content"],
  overrides: Partial<NormalizeInput["message"]> = {},
): NormalizeInput["message"] {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "toolUse",
    timestamp: 1_000,
    content,
    ...overrides,
  };
}

function createAgentBrowserTools(): HostedTool[] {
  const runtime = new BrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), "brewva-agent-browser-validation-")),
  });
  return createBrowserTools({ runtime }) as unknown as HostedTool[];
}

describe("agent-browser validation evidence", () => {
  test("repairs embedded browser_click content into a valid tool call for agent-browser workflows", () => {
    const result = normalizeAssistantMessageToolCalls({
      tools: createAgentBrowserTools(),
      message: createAssistantMessage([
        {
          type: "text",
          text: '{"toolName":"browser_click","arguments":"[@e12]<button>Continue</button>"}',
        },
      ]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    const toolCall = result.message.content[0];
    expect(toolCall?.type).toBe("toolCall");
    if (!toolCall || toolCall.type !== "toolCall") return;
    expect(toolCall.name).toBe("browser_click");
    expect(toolCall.arguments).toEqual({
      ref: "[@e12]<button>Continue</button>",
    });
    expect(result.records[0]?.source).toBe("assistant_text");
    expect(result.records[0]?.repairKinds).toEqual([
      "content_embedded_single_call",
      "primitive_to_object_coercion",
    ]);
  });

  test("repairs wrapped browser_fill arguments for agent-browser workflows", () => {
    const result = normalizeAssistantMessageToolCalls({
      tools: createAgentBrowserTools(),
      message: createAssistantMessage([
        {
          type: "toolCall",
          id: "tc-browser-fill-1",
          name: "browser_fill",
          arguments: '{"input":{"ref":"[@e2]<input>Email</input>","value":"arthur@example.com"}}',
        } as unknown as NormalizeInput["message"]["content"][number],
      ]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    const toolCall = result.message.content[0];
    expect(toolCall?.type).toBe("toolCall");
    if (!toolCall || toolCall.type !== "toolCall") return;
    expect(toolCall.name).toBe("browser_fill");
    expect(toolCall.arguments).toEqual({
      ref: "[@e2]<input>Email</input>",
      value: "arthur@example.com",
    });
    expect(result.records[0]?.source).toBe("tool_call");
    expect(result.records[0]?.repairKinds).toEqual([
      "double_stringified_arguments",
      "provider_wrapper_unwrapped",
    ]);
  });

  test("patches browser tool selection into provider-native Anthropic format", () => {
    const registry = createModelCapabilityRegistry();
    const model = {
      id: "claude-sonnet-4",
      api: "anthropic-messages",
      provider: "anthropic",
    } as unknown as ModelLike;

    const result = registry.patchRequest(model, {
      tool_choice: {
        type: "function",
        function: {
          name: "browser_click",
        },
      },
    });

    expect(result.profileId).toBe("anthropic-default");
    expect(result.changed).toBe(true);
    expect(result.patchKinds).toEqual(["anthropic_named_tool_choice_wrapper_fixed"]);
    expect(result.payload).toEqual({
      tool_choice: {
        type: "tool",
        name: "browser_click",
      },
    });
  });

  test("distills large browser snapshots while preserving artifact-oriented evidence", () => {
    const output = [
      "[Browser Snapshot]",
      "session: browser-session-validation",
      "artifact: .orchestrator/browser-artifacts/browser-session-validation/snapshot.txt",
      "interactive: true",
      "snapshot:",
      ...Array.from(
        { length: 160 },
        (_value, index) => `[@e${index}]<button>Action ${index}</button>`,
      ),
    ].join("\n");

    const distillation = distillToolOutput({
      toolName: "browser_snapshot",
      isError: false,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("browser_snapshot_heuristic");
    expect(distillation.summaryText).toContain("[BrowserSnapshotDistilled]");
    expect(distillation.summaryText).toContain(
      "artifact: .orchestrator/browser-artifacts/browser-session-validation/snapshot.txt",
    );
    expect(distillation.summaryText).toContain("interactive_refs: 160");
  });
});
