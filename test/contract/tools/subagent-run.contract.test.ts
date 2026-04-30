import { describe, expect, test } from "bun:test";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-runtime";
import {
  createSubagentFanoutTool,
  createSubagentForkTool,
  createSubagentRunDiagnosticTool,
  createSubagentRunTool,
  type SubagentForkRequest,
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

function buildBrief(decision = "What should the parent decide next?") {
  return {
    decision,
    successCriteria: "Return an evidence-backed delegated result.",
  };
}

describe("subagent_run public surface", () => {
  test("forwards intent-first single-run packets without low-level routing fields", async () => {
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
                delegate: input.request.skillName ?? "derived",
                outcomes: [
                  {
                    ok: true,
                    runId: "run-public-1",
                    delegate: "advisor",
                    agentSpec: "advisor",
                    envelope: "readonly-advisor",
                    skillName: input.request.skillName,
                    kind: "consult" as const,
                    consultKind: "investigate" as const,
                    status: "ok" as const,
                    workerSessionId: "worker-public-1",
                    summary: `summary:${input.request.packet?.objective}`,
                    data: {
                      kind: "consult" as const,
                      consultKind: "investigate" as const,
                      conclusion: "Gateway entrypoints are the first read target.",
                      lane: "review-correctness",
                    },
                    metrics: { durationMs: 12 },
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
      "tc-public-run",
      {
        skillName: "discovery",
        objective: "trace the gateway entrypoints",
        brief: buildBrief("Which gateway entrypoints matter first?"),
      },
      undefined,
      undefined,
      fakeContext("session-public-run"),
    );

    expect(extractText(result)).toContain("delegate=discovery");
    expect(capturedRequest).toEqual({
      skillName: "discovery",
      mode: "single",
      timeoutMs: undefined,
      packet: {
        objective: "trace the gateway entrypoints",
        consultBrief: buildBrief("Which gateway entrypoints matter first?"),
        activeSkillName: "discovery",
        executionHints: undefined,
        contextBudget: undefined,
        effectCeiling: undefined,
      },
    });
    const detailsText = JSON.stringify(result.details);
    expect(detailsText).not.toContain("agentSpec");
    expect(detailsText).not.toContain("readonly-advisor");
    expect(detailsText).not.toContain("consultKind");
    expect(detailsText).not.toContain("worker-public-1");
  });

  test("surfaces resolver missing brief errors for consult-style public skills", async () => {
    let adapterCalled = false;
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async () => {
              adapterCalled = true;
              return {
                ok: false,
                mode: "single",
                delegate: "discovery",
                outcomes: [],
                error: "missing_consult_brief",
              };
            },
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-public-run-missing-brief",
      {
        skillName: "discovery",
        objective: "trace the gateway entrypoints",
      },
      undefined,
      undefined,
      fakeContext("session-public-run-missing-brief"),
    );

    expect(adapterCalled).toBe(true);
    expect(extractText(result)).toContain("missing_consult_brief");
  });

  test("hard-fails removed low-level public fields", async () => {
    let adapterCalled = false;
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async () => {
              adapterCalled = true;
              return {
                ok: true,
                mode: "single",
                delegate: "advisor",
                outcomes: [],
              };
            },
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-public-run-forbidden",
      {
        skillName: "review",
        agentSpec: "review-security",
        consultKind: "review",
        executionShape: {
          model: "openai/gpt-5.5",
        },
        objective: "review the runtime boundary handling",
        brief: buildBrief("Should this review proceed?"),
      },
      undefined,
      undefined,
      fakeContext("session-public-run-forbidden"),
    );

    expect(adapterCalled).toBe(false);
    expect(extractText(result)).toContain(
      "public subagent delegation does not support diagnostic fields",
    );
    expect(extractText(result)).toContain("agentSpec");
    expect(extractText(result)).toContain("consultKind");
    expect(extractText(result)).toContain("executionShape");
  });

  test("supports supplemental delivery from public packets", async () => {
    const appendCalls: Array<{
      sessionId: string;
      familyId: string;
      text: string;
      scopeId?: string;
    }> = [];
    const tool = createSubagentRunTool({
      runtime: {
        internal: {
          appendGuardedSupplementalBlocks(
            sessionId: string,
            blocks: readonly { familyId: string; content: string }[],
            scopeId?: string,
          ) {
            return blocks.map(({ familyId, content }) => {
              appendCalls.push({ sessionId, familyId, text: content, scopeId });
              return {
                familyId,
                accepted: true,
                finalTokens: 12,
                truncated: false,
              };
            });
          },
        },
        orchestration: {
          subagents: {
            run: async (input: { request: SubagentRunRequest }) => ({
              ok: true,
              mode: "single",
              delegate: input.request.skillName ?? "derived",
              outcomes: [
                {
                  ok: true,
                  runId: "run-supplemental",
                  delegate: input.request.skillName ?? "derived",
                  kind: "consult" as const,
                  consultKind: "investigate" as const,
                  status: "ok" as const,
                  summary: "Focused repository impact summary.",
                  metrics: { durationMs: 9 },
                  evidenceRefs: [],
                },
              ],
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-public-run-supplemental",
      {
        skillName: "discovery",
        objective: "summarize repository impact",
        brief: buildBrief("What repository impact should the parent remember?"),
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
      familyId: "subagent-outcome",
      scopeId: "delegation-leaf",
    });
    expect(extractText(result)).toContain("supplemental delivery accepted");
  });

  test("can start public delegated work in background mode", async () => {
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async () => ({
              ok: true,
              mode: "single",
              delegate: "discovery",
              outcomes: [],
            }),
            start: async (input: { fromSessionId: string; request: SubagentRunRequest }) => ({
              ok: true,
              mode: input.request.mode,
              delegate: input.request.skillName ?? "derived",
              runs: [
                {
                  contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
                  runId: "run-background-1",
                  delegate: input.request.skillName ?? "derived",
                  executionPrimitive: "named" as const,
                  visibility: "public" as const,
                  isolationStrategy: "shared" as const,
                  adoption: {
                    contractId: "subagent-run-test",
                    decision: "require_human" as const,
                    reason: "Fixture record has not reached parent adoption.",
                  },
                  parentSessionId: input.fromSessionId,
                  status: "pending" as const,
                  createdAt: 1,
                  updatedAt: 1,
                  kind: "consult" as const,
                  agentSpec: "advisor",
                  envelope: "readonly-advisor",
                  consultKind: "investigate" as const,
                  workerSessionId: "worker-background-1",
                },
              ],
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-public-run-start",
      {
        skillName: "discovery",
        objective: "scan the runtime surface",
        brief: buildBrief("Which runtime surfaces should be scanned first?"),
        waitMode: "start",
      },
      undefined,
      undefined,
      fakeContext("session-start"),
    );

    expect(extractText(result)).toContain("subagent_run started for delegate=discovery");
    expect(extractText(result)).toContain("run-background-1");
    const detailsText = JSON.stringify(result.details);
    expect(detailsText).not.toContain("agentSpec");
    expect(detailsText).not.toContain("readonly-advisor");
    expect(detailsText).not.toContain("consultKind");
    expect(detailsText).not.toContain("worker-background-1");
  });
});

describe("subagent_fanout public surface", () => {
  test("forces parallel mode and forwards public task packets", async () => {
    let capturedRequest: SubagentRunRequest | undefined;
    const tool = createSubagentFanoutTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async (input: { request: SubagentRunRequest }) => {
              capturedRequest = input.request;
              return {
                ok: true,
                mode: input.request.mode,
                delegate: input.request.skillName ?? "derived",
                outcomes: [
                  {
                    ok: true,
                    runId: "fanout-1",
                    label: "gateway",
                    delegate: input.request.skillName ?? "derived",
                    kind: "consult" as const,
                    consultKind: "review" as const,
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
      "tc-public-fanout",
      {
        skillName: "review",
        brief: buildBrief("Which findings should block merge?"),
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
    expect(capturedRequest?.skillName).toBe("review");
    expect(capturedRequest?.packet).toBeUndefined();
    expect(capturedRequest?.tasks).toEqual([
      expect.objectContaining({
        label: "gateway",
        objective: "inspect gateway entrypoints",
        consultBrief: buildBrief("Which findings should block merge?"),
        activeSkillName: "review",
      }),
      expect.objectContaining({
        label: "runtime",
        objective: "inspect runtime entrypoints",
        consultBrief: buildBrief("Which findings should block merge?"),
        activeSkillName: "review",
      }),
    ]);
    expect(extractText(result)).toContain("subagent_fanout completed for delegate=review");
  });

  test("hard-fails diagnostic fields nested in public tasks", async () => {
    let adapterCalled = false;
    const tool = createSubagentFanoutTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async () => {
              adapterCalled = true;
              return {
                ok: true,
                mode: "parallel",
                delegate: "review",
                outcomes: [],
              };
            },
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-public-fanout-forbidden",
      {
        skillName: "review",
        brief: buildBrief("Which findings should block merge?"),
        tasks: [
          {
            label: "runtime",
            objective: "inspect runtime entrypoints",
            agentSpec: "review-security",
          },
        ],
      },
      undefined,
      undefined,
      fakeContext("session-fanout-forbidden"),
    );

    expect(adapterCalled).toBe(false);
    expect(extractText(result)).toContain("tasks[0].agentSpec");
  });
});

describe("subagent_run_diagnostic tool", () => {
  test("allows maintainers to specify low-level routing fields", async () => {
    let capturedRequest: SubagentRunRequest | undefined;
    const tool = createSubagentRunDiagnosticTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async (input: { request: SubagentRunRequest }) => {
              capturedRequest = input.request;
              return {
                ok: true,
                mode: input.request.mode,
                delegate: input.request.agentSpec ?? "diagnostic",
                outcomes: [
                  {
                    ok: true,
                    runId: "diagnostic-run-1",
                    delegate: input.request.agentSpec ?? "diagnostic",
                    agentSpec: input.request.agentSpec,
                    envelope: "readonly-advisor",
                    kind: "consult" as const,
                    consultKind: input.request.consultKind,
                    status: "ok" as const,
                    workerSessionId: "diagnostic-worker-1",
                    summary: "diagnostic lane routed",
                    metrics: { durationMs: 3 },
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
      "tc-diagnostic-run",
      {
        agentSpec: "review-security",
        consultKind: "review",
        fallbackResultMode: "consult",
        executionShape: {
          model: "openai/gpt-5.5:high",
        },
        objective: "probe review-security routing",
        consultBrief: buildBrief("Does this diagnostic lane route correctly?"),
      },
      undefined,
      undefined,
      fakeContext("session-diagnostic"),
    );

    expect((result.details as { ok?: boolean } | undefined)?.ok).toBe(true);
    expect(capturedRequest).toMatchObject({
      agentSpec: "review-security",
      consultKind: "review",
      fallbackResultMode: "consult",
      executionShape: {
        model: "openai/gpt-5.5:high",
      },
    });
    const detailsText = JSON.stringify(result.details);
    expect(detailsText).toContain("agentSpec");
    expect(detailsText).toContain("readonly-advisor");
    expect(detailsText).toContain("consultKind");
    expect(detailsText).toContain("diagnostic-worker-1");
  });
});

describe("subagent_fork tool", () => {
  test("delegates through the fork primitive without catalog specialist fields", async () => {
    let capturedRequest: SubagentForkRequest | undefined;
    const tool = createSubagentForkTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async () => ({
              ok: true,
              mode: "single",
              delegate: "unused",
              outcomes: [],
            }),
            fork: async (input: { fromSessionId: string; request: SubagentForkRequest }) => {
              capturedRequest = input.request;
              return {
                ok: true,
                run: {
                  contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
                  runId: "fork-1",
                  delegate: "fork",
                  executionPrimitive: "fork" as const,
                  visibility: "public" as const,
                  isolationStrategy: "shared" as const,
                  adoption: {
                    contractId: "fork",
                    decision: "require_human" as const,
                    reason: "Fork result requires parent adoption.",
                  },
                  lineage: {
                    parentSessionId: input.fromSessionId,
                    contextPolicy: "lineage_only" as const,
                  },
                  parentSessionId: input.fromSessionId,
                  status: "completed" as const,
                  createdAt: 1,
                  updatedAt: 2,
                  agentSpec: "advisor",
                  envelope: "readonly-advisor",
                  consultKind: "investigate" as const,
                  workerSessionId: "fork-worker-1",
                  kind: "consult" as const,
                  summary: "fork complete",
                },
              };
            },
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-fork",
      {
        objective: "try a same-context investigation branch",
        contextPolicy: "lineage_only",
      },
      undefined,
      undefined,
      fakeContext("session-fork"),
    );

    expect(capturedRequest).toEqual({
      objective: "try a same-context investigation branch",
      contextPolicy: "lineage_only",
      deliverable: undefined,
      timeoutMs: undefined,
    });
    expect(extractText(result)).toContain("primitive=fork");
    expect(extractText(result)).toContain("fork complete");
    const detailsText = JSON.stringify(result.details);
    expect(detailsText).not.toContain("agentSpec");
    expect(detailsText).not.toContain("readonly-advisor");
    expect(detailsText).not.toContain("consultKind");
    expect(detailsText).not.toContain("fork-worker-1");
  });

  test("prints fork failure reasons in the human-readable output", async () => {
    const tool = createSubagentForkTool({
      runtime: {
        orchestration: {
          subagents: {
            fork: async () => ({
              ok: false,
              error: "missing_readonly_advisor_envelope",
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-fork-failed",
      {
        objective: "try a same-context investigation branch",
      },
      undefined,
      undefined,
      fakeContext("session-fork-failed"),
    );

    expect(extractText(result)).toContain("subagent_fork failed");
    expect(extractText(result)).toContain("error=missing_readonly_advisor_envelope");
  });
});
