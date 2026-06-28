import { describe, expect, test } from "bun:test";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools/contracts";
import { createUserFactTool } from "@brewva/brewva-tools/memory";
import type { UserFactEntry } from "@brewva/brewva-vocabulary/user-model";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

interface RecordedFact {
  readonly sessionId: string;
  readonly input: {
    readonly scope: string;
    readonly factKey: string;
    readonly value: string;
    readonly reason: string;
    readonly sourceRefs?: readonly string[];
    readonly supersedesId?: string;
  };
}

function createToolContext(sessionId = "session-user-fact") {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function createRuntimeFixture(): { runtime: BrewvaToolRuntime; recorded: RecordedFact[] } {
  const recorded: RecordedFact[] = [];
  const runtime = {
    identity: { cwd: "/tmp/brewva", workspaceRoot: "/tmp/brewva", agentId: "agent-test" },
    config: {} as BrewvaToolRuntime["config"],
    capabilities: {
      workbench: {
        recordUserFact(sessionId: string, input: RecordedFact["input"]): UserFactEntry {
          recorded.push({ sessionId, input });
          return {
            id: `fact-${recorded.length}`,
            scope: input.scope as UserFactEntry["scope"],
            factKey: input.factKey,
            value: input.value,
            grade: "estimated",
            sourceRefs: [...(input.sourceRefs ?? [])],
            reason: input.reason,
            ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
            createdAt: 1_700_000_000_000,
          };
        },
      },
    } as unknown as BrewvaToolRuntime["capabilities"],
    extensions: {},
  } as unknown as BrewvaToolRuntime;
  return { runtime, recorded };
}

describe("user_fact tool", () => {
  test("records a model-authored advisory fact with a system-assigned estimated grade", async () => {
    const { runtime, recorded } = createRuntimeFixture();
    const tool = createUserFactTool({ runtime });

    const result = await tool.execute(
      "call-user-fact",
      {
        fact_key: "communication_style",
        value: "prefers terse, code-first answers",
        scope: "user",
        reason: "stated explicitly this session",
        source_refs: ["turn:4"],
      },
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );

    expect(recorded.length).toBe(1);
    expect(recorded[0]?.input).toMatchObject({
      scope: "user",
      factKey: "communication_style",
      value: "prefers terse, code-first answers",
    });
    // The grade is system-assigned, never a tool parameter.
    expect(toolOutcomePayload(result)).toMatchObject({
      ok: true,
      scope: "user",
      factKey: "communication_style",
      grade: "estimated",
    });
  });

  test("defaults scope to user and forwards an explicit supersedes_id", async () => {
    const { runtime, recorded } = createRuntimeFixture();
    const tool = createUserFactTool({ runtime });

    await tool.execute(
      "call-2",
      {
        fact_key: "preferred_language",
        value: "TypeScript",
        reason: "consistently chosen",
        source_refs: ["turn:1"],
        supersedes_id: "fact-prev",
      },
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );

    expect(recorded[0]?.input).toMatchObject({ scope: "user", supersedesId: "fact-prev" });
  });

  test("rejects a fact missing a fact_key, value, reason, or source_refs", async () => {
    const { runtime, recorded } = createRuntimeFixture();
    const tool = createUserFactTool({ runtime });

    const result = await tool.execute(
      "call-3",
      { fact_key: "", value: "x", reason: "r", source_refs: ["turn:1"] },
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );

    expect(toolOutcomePayload(result)).toMatchObject({ ok: false });
    expect(recorded.length).toBe(0);
  });
});
