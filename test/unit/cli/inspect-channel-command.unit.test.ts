import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { handleInspectChannelCommand } from "../../../packages/brewva-cli/src/inspect-channel-command.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

describe("inspect channel command", () => {
  test("surfaces accepted effect commitment requests in the inline inspect output", async () => {
    const workspace = createTestWorkspace("inspect-channel-approvals");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), "export const ok = true;\n", "utf8");

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    const sessionId = "inspect-channel-approval-session";

    try {
      runtime.events.record({
        sessionId,
        type: "session_bootstrap",
        payload: {
          managedToolMode: "direct",
        },
      });
      runtime.context.onTurnStart(sessionId, 1);

      const deferred = runtime.tools.start({
        sessionId,
        toolCallId: "tc-inspect-channel-approval",
        toolName: "exec",
        args: { command: "echo hi" },
      });
      expect(deferred.allowed).toBe(false);

      const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
      expect(pending).toHaveLength(1);

      runtime.proposals.decideEffectCommitment(sessionId, pending[0]!.requestId, {
        decision: "accept",
        actor: "operator:test",
        reason: "safe local command",
      });

      const result = await handleInspectChannelCommand({
        turn: {
          schema: "brewva.turn.v1",
          kind: "user",
          sessionId: "channel-session:inspect",
          turnId: "turn-inspect-1",
          channel: "telegram",
          conversationId: "inspect-conversation",
          timestamp: Date.now(),
          parts: [{ type: "text", text: "/inspect" }],
        },
        scopeKey: "telegram:inspect-conversation",
        focusedAgentId: "default",
        targetAgentId: "default",
        targetSession: {
          agentId: "default",
          runtime,
          sessionId,
        },
      });

      expect(result.text).toContain("Approvals: pending=0 · accepted=1");
      expect(result.text).toContain("Replayable approvals:");
      expect(result.text).toContain(pending[0]!.requestId);
      expect(result.text).toContain("actor=operator:test");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
