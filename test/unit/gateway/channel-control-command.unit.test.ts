import { describe, expect, test } from "bun:test";
import { resolveChannelControlCommand } from "../../../packages/brewva-gateway/src/channels/control-command.js";

describe("channel control command seam", () => {
  test("maps route-agent match into a typed control command", () => {
    expect(
      resolveChannelControlCommand(
        {
          kind: "route-agent",
          agentId: "agent-a",
          task: "summarize this",
          viaMention: true,
        },
        "scope-1",
      ),
    ).toEqual({
      kind: "route-agent",
      scopeKey: "scope-1",
      agentId: "agent-a",
      task: "summarize this",
      viaMention: true,
    });
  });

  test("maps status match into a typed control command with optional fields", () => {
    expect(
      resolveChannelControlCommand(
        {
          kind: "status",
          agentId: "agent-b",
          directory: "/tmp/demo",
          top: 3,
          details: true,
        },
        "scope-2",
      ),
    ).toEqual({
      kind: "status",
      scopeKey: "scope-2",
      targetAgentId: "agent-b",
      directory: "/tmp/demo",
      top: 3,
      details: true,
    });
  });

  test("ignores non-control matches", () => {
    expect(resolveChannelControlCommand({ kind: "none" }, "scope-3")).toBeNull();
    expect(
      resolveChannelControlCommand(
        {
          kind: "error",
          message: "bad args",
        },
        "scope-3",
      ),
    ).toBeNull();
  });
});
