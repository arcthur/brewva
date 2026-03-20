import { describe, expect, test } from "bun:test";
import {
  createSubagentFanoutTool,
  createSubagentRunTool,
  type SubagentRunRequest,
} from "@brewva/brewva-tools";

function fakeContext(sessionId: string): any {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (
    result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text ??
    ""
  );
}

describe("subagent_run tool", () => {
  test("delegates single runs through the subagent adapter", async () => {
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async (input: { fromSessionId: string; request: SubagentRunRequest }) => ({
              ok: true,
              mode: input.request.mode,
              profile: input.request.profile,
              outcomes: [
                {
                  ok: true,
                  runId: "run-1",
                  profile: input.request.profile,
                  kind: "exploration" as const,
                  summary: `summary:${input.request.packet?.objective}`,
                  assistantText: "done",
                  metrics: {
                    durationMs: 12,
                    totalTokens: 88,
                    costUsd: 0.0123,
                  },
                  evidenceRefs: [],
                },
              ],
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-1",
      {
        profile: "researcher",
        objective: "trace the gateway entrypoints",
      },
      undefined,
      undefined,
      fakeContext("session-1"),
    );

    const text = extractText(result);
    expect(text).toContain("profile=researcher");
    expect(text).toContain("summary:trace the gateway entrypoints");
    expect((result.details as { ok?: boolean } | undefined)?.ok).toBe(true);
  });

  test("requires tasks for parallel mode", async () => {
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async () => ({
              ok: true,
              mode: "parallel",
              profile: "researcher",
              outcomes: [],
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-2",
      {
        profile: "researcher",
        mode: "parallel",
      },
      undefined,
      undefined,
      fakeContext("session-2"),
    );

    expect(extractText(result)).toContain("tasks is required");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  test("marks mixed parallel results as failed", async () => {
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async () => ({
              ok: true,
              mode: "parallel",
              profile: "reviewer",
              outcomes: [
                {
                  ok: true,
                  runId: "run-ok",
                  label: "slice-a",
                  profile: "reviewer",
                  kind: "review" as const,
                  summary: "No issues found in slice A.",
                  assistantText: "No issues found in slice A.",
                  metrics: { durationMs: 10 },
                  evidenceRefs: [],
                },
                {
                  ok: false,
                  runId: "run-fail",
                  label: "slice-b",
                  profile: "reviewer",
                  error: "timeout",
                  metrics: { durationMs: 20 },
                },
              ],
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-3",
      {
        profile: "reviewer",
        mode: "parallel",
        tasks: [
          { label: "slice-a", objective: "review runtime" },
          { label: "slice-b", objective: "review gateway" },
        ],
      },
      undefined,
      undefined,
      fakeContext("session-3"),
    );

    const text = extractText(result);
    expect(text).toContain("slice-b: failed (timeout)");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  test("supports supplemental delivery when explicitly requested", async () => {
    const appendCalls: Array<{ sessionId: string; text: string; scopeId?: string }> = [];
    const tool = createSubagentRunTool({
      runtime: {
        context: {
          appendSupplementalInjection(
            sessionId: string,
            text: string,
            _usage?: unknown,
            scopeId?: string,
          ) {
            appendCalls.push({ sessionId, text, scopeId });
            return {
              accepted: true,
              text,
              originalTokens: 12,
              finalTokens: 12,
              truncated: false,
            };
          },
        },
        orchestration: {
          subagents: {
            run: async () => ({
              ok: true,
              mode: "single",
              profile: "researcher",
              outcomes: [
                {
                  ok: true,
                  runId: "run-supplemental",
                  profile: "researcher",
                  kind: "exploration" as const,
                  status: "ok" as const,
                  workerSessionId: "child-supplemental",
                  summary: "Focused repository impact summary.",
                  metrics: {
                    durationMs: 9,
                  },
                  evidenceRefs: [],
                },
              ],
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-supplemental",
      {
        profile: "researcher",
        objective: "summarize repository impact",
        returnMode: "supplemental",
        returnScopeId: "delegation-leaf",
      },
      undefined,
      undefined,
      fakeContext("session-supplemental"),
    );

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]).toMatchObject({
      sessionId: "session-supplemental",
      scopeId: "delegation-leaf",
    });
    expect(appendCalls[0]?.text).toContain("Delegation outcome for profile=researcher");
    expect(extractText(result)).toContain("supplemental delivery accepted");
  });

  test("forwards enriched delegation packet fields to the subagent adapter", async () => {
    let capturedRequest: SubagentRunRequest | undefined;
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async (input: { fromSessionId: string; request: SubagentRunRequest }) => {
              capturedRequest = input.request;
              return {
                ok: true,
                mode: input.request.mode,
                profile: input.request.profile,
                outcomes: [],
              };
            },
          },
        },
      } as any,
    });

    await tool.execute(
      "tc-subagent-packet-shape",
      {
        profile: "reviewer",
        objective: "review the changed runtime boundaries",
        activeSkillName: "review",
        requiredOutputs: ["findings", "verification_evidence"],
        executionHints: {
          preferredTools: ["lsp_diagnostics"],
          fallbackTools: ["grep"],
          preferredSkills: ["review"],
        },
      },
      undefined,
      undefined,
      fakeContext("session-packet"),
    );

    expect(capturedRequest?.packet).toMatchObject({
      activeSkillName: "review",
      requiredOutputs: ["findings", "verification_evidence"],
      executionHints: {
        preferredTools: ["lsp_diagnostics"],
        fallbackTools: ["grep"],
        preferredSkills: ["review"],
      },
    });
  });

  test("can start delegated work in background mode", async () => {
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async () => ({
              ok: true,
              mode: "single",
              profile: "researcher",
              outcomes: [],
            }),
            start: async (input: { fromSessionId: string; request: SubagentRunRequest }) => ({
              ok: true,
              mode: input.request.mode,
              profile: input.request.profile,
              runs: [
                {
                  runId: "run-background-1",
                  profile: input.request.profile,
                  parentSessionId: input.fromSessionId,
                  status: "pending",
                  createdAt: 1,
                  updatedAt: 1,
                  kind: "exploration",
                },
              ],
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-start",
      {
        profile: "researcher",
        objective: "scan the runtime surface",
        waitMode: "start",
      },
      undefined,
      undefined,
      fakeContext("session-start"),
    );

    expect(extractText(result)).toContain("subagent_run started for profile=researcher");
    expect(extractText(result)).toContain("run-background-1");
    expect((result.details as { ok?: boolean } | undefined)?.ok).toBe(true);
  });

  test("subagent_fanout forces parallel mode and forwards tasks", async () => {
    let capturedRequest: SubagentRunRequest | undefined;
    const tool = createSubagentFanoutTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async (input: { fromSessionId: string; request: SubagentRunRequest }) => {
              capturedRequest = input.request;
              return {
                ok: true,
                mode: input.request.mode,
                profile: input.request.profile,
                outcomes: [
                  {
                    ok: true,
                    runId: "fanout-1",
                    label: "gateway",
                    profile: input.request.profile,
                    kind: "exploration" as const,
                    status: "ok" as const,
                    summary: "gateway slice complete",
                    metrics: { durationMs: 7 },
                    evidenceRefs: [],
                  },
                ],
              };
            },
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-fanout",
      {
        profile: "researcher",
        activeSkillName: "repository-analysis",
        tasks: [
          { label: "gateway", objective: "inspect gateway entrypoints" },
          { label: "runtime", objective: "inspect runtime entrypoints" },
        ],
      },
      undefined,
      undefined,
      fakeContext("session-fanout"),
    );

    expect(capturedRequest?.mode).toBe("parallel");
    expect(capturedRequest?.tasks).toHaveLength(2);
    expect(extractText(result)).toContain("subagent_fanout completed for profile=researcher");
    expect((result.details as { ok?: boolean } | undefined)?.ok).toBe(true);
  });
});
