import { describe, expect, test } from "bun:test";
import type { BrewvaHostContext, InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import { createLocalHookManager } from "../../../packages/brewva-gateway/src/hosted/internal/hooks/local-hook-port.js";

describe("local hook manager", () => {
  test("treats non-advisory hook results as invalid governance receipts", async () => {
    const toolCallHandlers: Array<Parameters<InternalHostPluginApi["on"]>[1]> = [];
    const api = {
      on(event: string, handler: Parameters<InternalHostPluginApi["on"]>[1]) {
        if (event === "tool_call") {
          toolCallHandlers.push(handler);
        }
      },
      registerTool() {},
      registerCommand() {},
      sendMessage() {},
      sendUserMessage() {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools() {},
      refreshTools() {},
    } as unknown as InternalHostPluginApi;
    const governanceReceipts: unknown[] = [];
    const runtime = {
      ops: {
        events: {
          records: {
            subscribe: () => () => undefined,
          },
        },
        proposals: {
          governance: {
            turnDecisionRecorded(input: unknown) {
              governanceReceipts.push(input);
            },
          },
        },
      },
    } as unknown as Parameters<typeof createLocalHookManager>[0]["runtime"];

    createLocalHookManager({
      extensionApi: api,
      runtime,
      hooks: [
        {
          name: "invalid-hook",
          preEffect: () =>
            ({
              kind: "block_tool",
              reason: "legacy local policy",
            }) as never,
        },
      ],
    });

    const result = await toolCallHandlers[0]?.(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "exec_command",
        input: {},
      },
      {
        sessionManager: { getSessionId: () => "session-1" },
      } as BrewvaHostContext,
    );

    expect({ result }).toEqual({ result: undefined });
    expect(governanceReceipts).toHaveLength(1);
    expect(governanceReceipts[0]).toMatchObject({
      sessionId: "session-1",
      payload: {
        schema: "brewva.turn_governance_decision.v1",
        source: "local_hook",
        phase: "pre_effect",
        hookName: "invalid-hook",
        result: {
          kind: "observe",
          notes: [
            {
              severity: "warning",
              message:
                "pre_effect hook returned an invalid advisory result; ignored by the local hook manager.",
            },
          ],
        },
      },
    });
  });
});
