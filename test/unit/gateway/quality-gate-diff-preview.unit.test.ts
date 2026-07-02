import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrewvaEditToolDefinition } from "@brewva/brewva-substrate/tools";
import { createQualityGateLifecycle } from "../../../packages/brewva-gateway/src/hosted/internal/session/tools/quality-gate.js";
import type { HostedRuntimeAdapterPort } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("quality gate diff preview", () => {
  test("adds edit diff preview to effect commitment start input", () => {
    const workspace = createTestWorkspace("quality-gate-diff-preview");
    const filePath = join(workspace, "app.ts");
    writeFileSync(filePath, "const value = 1;\n", "utf8");

    let capturedStartInput: Record<string, unknown> | undefined;
    const runtime = {
      ops: {
        tools: {
          invocation: {
            start(input: Record<string, unknown>) {
              capturedStartInput = input;
              return { allowed: true };
            },
          },
        },
      },
    } as unknown as HostedRuntimeAdapterPort;

    const lifecycle = createQualityGateLifecycle(runtime, {
      toolDefinitionsByName: new Map([["edit", createBrewvaEditToolDefinition(workspace)]]),
    });

    lifecycle.toolCall(
      {
        toolCallId: "tool-call-1",
        toolName: "edit",
        input: {
          path: "app.ts",
          edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
        },
      },
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => "session-1",
        },
        getContextUsage: () => undefined,
      },
    );

    expect(capturedStartInput?.diffPreview).toMatchObject({
      kind: "diff",
      path: "app.ts",
    });
    expect(String((capturedStartInput?.diffPreview as { diff?: string })?.diff)).toContain(
      "-1 const value = 1;",
    );
    expect(String((capturedStartInput?.diffPreview as { diff?: string })?.diff)).toContain(
      "+1 const value = 2;",
    );
  });

  test("renders missing capability blocks through operator safety recovery", () => {
    const runtime = {
      ops: {
        tools: {
          invocation: {
            start() {
              return { allowed: false, reason: "missing_selected_capability" };
            },
          },
        },
      },
    } as unknown as HostedRuntimeAdapterPort;

    const lifecycle = createQualityGateLifecycle(runtime);
    const result = lifecycle.toolCall(
      {
        toolCallId: "tool-call-1",
        toolName: "custom_tool",
        input: { title: "Example", token: "SECRET_TOKEN" },
      },
      {
        sessionManager: {
          getSessionId: () => "session-1",
        },
        getContextUsage: () => undefined,
      },
    );

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("Select a capability");
    expect(result?.reason).not.toContain("SECRET_TOKEN");
  });

  test("missing capability block reason carries the denial advisory to the model", () => {
    const runtime = {
      ops: {
        tools: {
          invocation: {
            start() {
              return {
                allowed: false,
                reason: "missing_selected_capability",
                advisory:
                  "tool 'agent_send' requires a selected capability. Covered by: slack-notify — request selection with '/capability:slack-notify' in the turn prompt; the selection receipt remains the only authority.",
              };
            },
          },
        },
      },
    } as unknown as HostedRuntimeAdapterPort;

    const lifecycle = createQualityGateLifecycle(runtime);
    const result = lifecycle.toolCall(
      {
        toolCallId: "tool-call-1",
        toolName: "custom_tool",
        input: { message: "hi" },
      },
      {
        sessionManager: {
          getSessionId: () => "session-1",
        },
        getContextUsage: () => undefined,
      },
    );

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("Select a capability");
    expect(result?.reason).toContain("'/capability:slack-notify'");
  });
});
