import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, createTrustedLocalGovernancePort } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { createChannelReplyWriter } from "../../../packages/brewva-gateway/src/channels/channel-reply-writer.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function createInboundTurn(): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "channel-session:scope-a",
    turnId: "turn:scope-a:1",
    channel: "telegram",
    conversationId: "scope-a",
    timestamp: Date.now(),
    parts: [{ type: "text", text: "hello" }],
  };
}

describe("channel reply writer", () => {
  test("given tool and assistant outputs, when sendAgentOutputs runs, then outbound turns are emitted by the writer with stable sequencing", async () => {
    const workspace = createTestWorkspace("channel-reply-writer");
    const controllerRuntime = new BrewvaRuntime({
      cwd: workspace,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
    });
    const workerRuntime = new BrewvaRuntime({
      cwd: workspace,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
      agentId: "worker",
    });
    const sentTurns: TurnEnvelope[] = [];
    const writer = createChannelReplyWriter({
      runtime: controllerRuntime,
      sendTurn: async (turn) => {
        sentTurns.push(turn);
      },
    });

    try {
      let sequence = 0;
      const emitted = await writer.sendAgentOutputs({
        runtime: workerRuntime,
        inbound: createInboundTurn(),
        agentSessionId: "agent-session:worker",
        agentId: "worker",
        assistantText: "  final answer  ",
        toolOutputs: [
          {
            toolCallId: "tool-1",
            toolName: "read_file",
            isError: false,
            verdict: "success",
            text: "Tool read_file (tool-1) ok",
          },
        ],
        nextSequence: () => {
          sequence += 1;
          return sequence;
        },
      });

      expect(emitted).toBe(2);
      expect(sentTurns).toHaveLength(2);
      expect(sentTurns[0]?.turnId).toBe("turn:scope-a:1:tool:1");
      expect(sentTurns[0]?.meta?.agentSessionId).toBe("agent-session:worker");
      expect(sentTurns[0]?.meta?.toolCallId).toBe("tool-1");
      expect(sentTurns[1]?.turnId).toBe("turn:scope-a:1:assistant:2");
      expect(sentTurns[1]?.parts).toEqual([{ type: "text", text: "final answer" }]);
      expect(sentTurns[1]?.meta?.agentId).toBe("worker");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
