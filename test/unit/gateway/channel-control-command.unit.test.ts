import { describe, expect, test } from "bun:test";
import { CommandRouter } from "../../../packages/brewva-gateway/src/channels/command/parser.js";
import {
  isPublicChannelControlCommand,
  resolveChannelControlCommand,
} from "../../../packages/brewva-gateway/src/channels/control-command.js";

describe("channel control command seam", () => {
  test("parses channel goal commands with optional target agent", () => {
    const router = new CommandRouter();

    expect(router.match("/goal @agent-b --tokens 20k ship channel parity")).toEqual({
      kind: "goal",
      agentId: "agent-b",
      command: {
        kind: "start",
        objective: "ship channel parity",
        tokenBudget: 20_000,
        maxTurns: null,
      },
    });
    expect(router.match("/goal @agent-b status")).toEqual({
      kind: "goal",
      agentId: "agent-b",
      command: {
        kind: "status",
      },
    });
  });

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

  test("maps goal match into a typed control command with target agent and shared grammar", () => {
    expect(
      resolveChannelControlCommand(
        {
          kind: "goal",
          agentId: "agent-b",
          command: {
            kind: "start",
            objective: "ship channel parity",
            tokenBudget: 20_000,
            maxTurns: null,
          },
        },
        "scope-2",
      ),
    ).toEqual({
      kind: "goal",
      scopeKey: "scope-2",
      targetAgentId: "agent-b",
      command: {
        kind: "start",
        objective: "ship channel parity",
        tokenBudget: 20_000,
        maxTurns: null,
      },
    });
  });

  test("parses channel map commands and maps them into a typed, owner-gated control command", () => {
    const router = new CommandRouter();
    expect(router.match("/map @agent-b chart auth Redesign the auth flow")).toEqual({
      kind: "map",
      agentId: "agent-b",
      command: { kind: "chart", mapId: "auth", destination: "Redesign the auth flow" },
    });
    expect(router.match("/map show auth")).toEqual({
      kind: "map",
      command: { kind: "show", mapId: "auth" },
    });

    const control = resolveChannelControlCommand(
      { kind: "map", agentId: "agent-b", command: { kind: "show", mapId: "auth" } },
      "scope-map",
    );
    expect(control).toEqual({
      kind: "map",
      scopeKey: "scope-map",
      targetAgentId: "agent-b",
      command: { kind: "show", mapId: "auth" },
    });
    // The map surface is owner-gated (non-public), like /goal — not a public command.
    expect(control && isPublicChannelControlCommand(control)).toBe(false);
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
