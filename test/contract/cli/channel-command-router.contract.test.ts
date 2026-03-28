import { describe, expect, test } from "bun:test";
import { CommandRouter } from "@brewva/brewva-gateway";

describe("channel command router", () => {
  const router = new CommandRouter();

  test("parses new-agent variants", () => {
    expect(router.match("/new-agent jack")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: undefined,
    });
    expect(router.match("/new-agent name=Jack model=openai/gpt-5.3-codex")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: "openai/gpt-5.3-codex",
    });
    expect(router.match("/new-agent name is mike")).toEqual({
      kind: "new-agent",
      agentId: "mike",
      model: undefined,
    });
    expect(router.match("/new-agent name is jack,")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: undefined,
    });
    expect(router.match("/new-agent name is jack model=openai/gpt-5.3-codex")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: "openai/gpt-5.3-codex",
    });
    expect(router.match("/new-agent name is jack, model=openai/gpt-5.3-codex")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: "openai/gpt-5.3-codex",
    });
    expect(router.match("/new-agent name=Jack model=openai/gpt-5.3-codex:high")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: "openai/gpt-5.3-codex:high",
    });
  });

  test("parses run, discuss, inspect, and insights commands", () => {
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

    expect(router.match("/inspect")).toEqual({
      kind: "inspect",
      agentId: undefined,
      directory: undefined,
    });
    expect(router.match("/inspect src/runtime")).toEqual({
      kind: "inspect",
      agentId: undefined,
      directory: "src/runtime",
    });
    expect(router.match("/inspect @jack")).toEqual({
      kind: "inspect",
      agentId: "jack",
      directory: undefined,
    });
    expect(router.match("/inspect @jack src/runtime")).toEqual({
      kind: "inspect",
      agentId: "jack",
      directory: "src/runtime",
    });
    expect(router.match("/insights")).toEqual({
      kind: "insights",
      agentId: undefined,
      directory: undefined,
    });
    expect(router.match("/insights src/runtime")).toEqual({
      kind: "insights",
      agentId: undefined,
      directory: "src/runtime",
    });
    expect(router.match("/insights @jack")).toEqual({
      kind: "insights",
      agentId: "jack",
      directory: undefined,
    });
    expect(router.match("/insights @jack src/runtime")).toEqual({
      kind: "insights",
      agentId: "jack",
      directory: "src/runtime",
    });
    expect(router.match("/cost")).toEqual({
      kind: "cost",
      agentId: undefined,
      top: undefined,
    });
    expect(router.match("/cost top=7")).toEqual({
      kind: "cost",
      agentId: undefined,
      top: 7,
    });
    expect(router.match("/cost @jack top=3")).toEqual({
      kind: "cost",
      agentId: "jack",
      top: 3,
    });
    expect(router.match("/questions")).toEqual({
      kind: "questions",
      agentId: undefined,
    });
    expect(router.match("/questions @jack")).toEqual({
      kind: "questions",
      agentId: "jack",
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
    expect(router.match("/new-agent")).toEqual({
      kind: "error",
      message: "Usage: /new-agent <name> [model=<exact-id[:thinking]>]",
    });
    expect(router.match("/run @jack")).toEqual({
      kind: "error",
      message: "Usage: /run @a,@b <task>",
    });
    expect(router.match("/focus")).toEqual({
      kind: "error",
      message: "Usage: /focus @agent",
    });
    expect(router.match("/inspect @")).toEqual({
      kind: "error",
      message: "Usage: /inspect [@agent] [dir]",
    });
    expect(router.match("/cost invalid")).toEqual({
      kind: "error",
      message: "Usage: /cost [@agent] [top=N]",
    });
    expect(router.match("/cost top=foo")).toEqual({
      kind: "error",
      message: "Usage: /cost [@agent] [top=N]",
    });
    expect(router.match("/cost @jack top=foo")).toEqual({
      kind: "error",
      message: "Usage: /cost [@agent] [top=N]",
    });
    expect(router.match("/questions src")).toEqual({
      kind: "error",
      message: "Usage: /questions [@agent]",
    });
    expect(router.match("/answer")).toEqual({
      kind: "error",
      message: "Usage: /answer [@agent] <question-id> <answer>",
    });
    expect(router.match("/unknown")).toEqual({
      kind: "error",
      message:
        "Unknown command. Use /inspect, /insights, /cost, /questions, /answer, /agents, /update, /new-agent, /del-agent, /focus, /run, or /discuss.",
    });
    expect(router.match("/insights @")).toEqual({
      kind: "error",
      message: "Usage: /insights [@agent] [dir]",
    });
  });
});
