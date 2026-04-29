import { describe, expect, test } from "bun:test";
import { CommandRouter } from "@brewva/brewva-gateway";

describe("channel command router", () => {
  const router = new CommandRouter();

  test("parses /agent create variants", () => {
    expect(router.match("/agent new jack")).toEqual({
      kind: "agent-create",
      agentId: "jack",
      model: undefined,
    });
    expect(router.match("/agent new name=Jack model=openai/gpt-5.3-codex")).toEqual({
      kind: "agent-create",
      agentId: "jack",
      model: "openai/gpt-5.3-codex",
    });
    expect(router.match("/agent new name=Jack model=openai/gpt-5.3-codex:high")).toEqual({
      kind: "agent-create",
      agentId: "jack",
      model: "openai/gpt-5.3-codex:high",
    });
  });

  test("parses run, discuss, and status commands", () => {
    expect(router.match("/run @jack,@mike review this")).toEqual({
      kind: "run",
      agentIds: ["jack", "mike"],
      task: "review this",
    });

    expect(router.match("/discuss @jack,@mike maxRounds=4 design tradeoff")).toEqual({
      kind: "discuss",
      agentIds: ["jack", "mike"],
      topic: "design tradeoff",
      maxRounds: 4,
    });

    expect(router.match("/status")).toEqual({
      kind: "status",
      agentId: undefined,
      directory: undefined,
      top: undefined,
      details: undefined,
    });
    expect(router.match("/status src/runtime")).toEqual({
      kind: "status",
      agentId: undefined,
      directory: "src/runtime",
      top: undefined,
      details: true,
    });
    expect(router.match("/status @jack")).toEqual({
      kind: "status",
      agentId: "jack",
      directory: undefined,
      top: undefined,
      details: undefined,
    });
    expect(router.match("/status @jack src/runtime")).toEqual({
      kind: "status",
      agentId: "jack",
      directory: "src/runtime",
      top: undefined,
      details: true,
    });
    expect(router.match("/status @jack top=3")).toEqual({
      kind: "status",
      agentId: "jack",
      directory: undefined,
      top: 3,
      details: undefined,
    });
    expect(router.match("/status dir=src/runtime top=7")).toEqual({
      kind: "status",
      agentId: undefined,
      directory: "src/runtime",
      top: 7,
      details: true,
    });
    expect(router.match("/status @jack details top=2")).toEqual({
      kind: "status",
      agentId: "jack",
      directory: undefined,
      top: 2,
      details: true,
    });
    expect(router.match("/agent status @jack src/runtime")).toEqual({
      kind: "status",
      agentId: "jack",
      directory: "src/runtime",
      top: undefined,
      details: true,
    });
    expect(router.match("/agent @jack status top=2")).toEqual({
      kind: "status",
      agentId: "jack",
      directory: undefined,
      top: 2,
      details: undefined,
    });
    expect(router.match("/answer skill:event-1:1 use node 22")).toEqual({
      kind: "answer",
      agentId: undefined,
      questionId: "skill:event-1:1",
      answerText: "use node 22",
    });
    expect(router.match("/answer @jack delegation:run-1:1 target the gateway path")).toEqual({
      kind: "answer",
      agentId: "jack",
      questionId: "delegation:run-1:1",
      answerText: "target the gateway path",
    });

    expect(router.match("/update")).toEqual({
      kind: "update",
      instructions: undefined,
    });
    expect(router.match("/update target=latest safe rollout")).toEqual({
      kind: "update",
      instructions: "target=latest safe rollout",
    });
    expect(router.match("/agent delete jack")).toEqual({
      kind: "agent-delete",
      agentId: "jack",
    });
  });

  test("routes @agent mention", () => {
    expect(router.match("@jack fix this bug")).toEqual({
      kind: "route-agent",
      agentId: "jack",
      task: "fix this bug",
      viaMention: true,
    });
    expect(router.match("@jack, fix this bug")).toEqual({
      kind: "route-agent",
      agentId: "jack",
      task: "fix this bug",
      viaMention: true,
    });
  });

  test("returns syntax error for invalid command shapes", () => {
    expect(router.match("/agent")).toEqual({
      kind: "error",
      message: "Usage: /agent <new|delete|status> ...",
    });
    expect(router.match("/run @jack")).toEqual({
      kind: "error",
      message: "Usage: /run @a,@b <task>",
    });
    expect(router.match("/focus")).toEqual({
      kind: "error",
      message: "Usage: /focus @agent",
    });
    expect(router.match("/status @")).toEqual({
      kind: "error",
      message: "Usage: /status [@agent] [dir] [top=N] [details]",
    });
    expect(router.match("/status @jack top=foo")).toEqual({
      kind: "error",
      message: "Usage: /status [@agent] [dir] [top=N] [details]",
    });
    expect(router.match("/answer")).toEqual({
      kind: "error",
      message: "Usage: /answer [@agent] <question-id> <answer>",
    });
    expect(router.match("/unknown")).toEqual({
      kind: "error",
      message:
        "Unknown command. Use /status, /steer, /answer, /agents, /agent, /focus, /run, or /discuss.",
    });
    expect(router.match("/steer @jack stay focused")).toEqual({
      kind: "steer",
      agentId: "jack",
      text: "stay focused",
    });
    expect(router.match("/agent delete")).toEqual({
      kind: "error",
      message: "Usage: /agent delete <name>",
    });
    expect(router.match("/agent new name is mike")).toEqual({
      kind: "error",
      message: "Missing agent name for /agent new.",
    });
  });
});
