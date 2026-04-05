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

function resolveDelegateName(request: SubagentRunRequest): string {
  return (
    request.agentSpec ??
    request.envelope ??
    request.skillName ??
    request.executionShape?.resultMode ??
    "explicit-required"
  );
}

function buildConsultBrief(decision: string, successCriteria: string) {
  return {
    decision,
    successCriteria,
  };
}

describe("subagent_run tool", () => {
  test("accepts consult as the canonical delegated result mode", async () => {
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
                delegate: resolveDelegateName(input.request),
                outcomes: [],
              };
            },
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-consult",
      {
        agentSpec: "advisor",
        consultKind: "design",
        objective: "Design the contract-first rollout.",
        consultBrief: buildConsultBrief(
          "What is the right hard-cutover contract?",
          "Return a design judgment with risks and next steps.",
        ),
        fallbackResultMode: "consult",
        executionShape: {
          resultMode: "consult",
        },
      },
      undefined,
      undefined,
      fakeContext("session-plan"),
    );

    expect((result.details as { ok?: boolean } | undefined)?.ok).toBe(true);
    expect(capturedRequest?.consultKind).toBe("design");
    expect(capturedRequest?.fallbackResultMode).toBe("consult");
    expect(capturedRequest?.executionShape?.resultMode).toBe("consult");
    expect(capturedRequest?.packet?.consultBrief).toEqual(
      buildConsultBrief(
        "What is the right hard-cutover contract?",
        "Return a design judgment with risks and next steps.",
      ),
    );
  });

  test("delegates single runs through the subagent adapter", async () => {
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async (input: { fromSessionId: string; request: SubagentRunRequest }) => ({
              ok: true,
              mode: input.request.mode,
              delegate: resolveDelegateName(input.request),
              outcomes: [
                {
                  ok: true,
                  runId: "run-1",
                  delegate: resolveDelegateName(input.request),
                  kind: "consult" as const,
                  consultKind: "investigate" as const,
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
        agentSpec: "advisor",
        consultKind: "investigate",
        objective: "trace the gateway entrypoints",
        consultBrief: buildConsultBrief(
          "Which gateway entrypoints matter first?",
          "Return the highest-signal entrypoints to inspect.",
        ),
      },
      undefined,
      undefined,
      fakeContext("session-1"),
    );

    const text = extractText(result);
    expect(text).toContain("delegate=advisor");
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
              delegate: "advisor",
              outcomes: [],
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-2",
      {
        agentSpec: "advisor",
        consultKind: "investigate",
        consultBrief: buildConsultBrief(
          "How should the work be split?",
          "Parallel tasks must be provided explicitly.",
        ),
        mode: "parallel",
      },
      undefined,
      undefined,
      fakeContext("session-2"),
    );

    expect(extractText(result)).toContain("tasks is required");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  test("rejects removed legacy delegation fields", async () => {
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
      "tc-subagent-legacy-fields",
      {
        agentSpec: "advisor",
        objective: "review the runtime boundary handling",
        requiredOutputs: ["findings"],
      },
      undefined,
      undefined,
      fakeContext("session-legacy"),
    );

    expect(adapterCalled).toBe(false);
    expect(extractText(result)).toContain("removed legacy delegation fields are not supported");
    expect(extractText(result)).toContain("requiredOutputs");
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
              delegate: "advisor",
              outcomes: [
                {
                  ok: true,
                  runId: "run-ok",
                  label: "slice-a",
                  delegate: "advisor",
                  kind: "consult" as const,
                  consultKind: "review" as const,
                  summary: "No issues found in slice A.",
                  assistantText: "No issues found in slice A.",
                  metrics: { durationMs: 10 },
                  evidenceRefs: [],
                },
                {
                  ok: false,
                  runId: "run-fail",
                  label: "slice-b",
                  delegate: "advisor",
                  consultKind: "review" as const,
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
        agentSpec: "advisor",
        consultKind: "review",
        consultBrief: buildConsultBrief(
          "Is the change ready for parent review completion?",
          "Each slice should produce a review judgment or fail explicitly.",
        ),
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
        internal: {
          appendSupplementalInjection(
            sessionId: string,
            text: string,
            _sourceLabel?: string,
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
              delegate: "advisor",
              outcomes: [
                {
                  ok: true,
                  runId: "run-supplemental",
                  delegate: "advisor",
                  kind: "consult" as const,
                  consultKind: "investigate" as const,
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
        agentSpec: "advisor",
        consultKind: "investigate",
        objective: "summarize repository impact",
        consultBrief: buildConsultBrief(
          "What repository impact should the parent remember?",
          "Return a concise investigation summary suitable for reinjection.",
        ),
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
    expect(appendCalls[0]?.text).toContain("Delegation outcome for delegate=advisor");
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
                delegate: resolveDelegateName(input.request),
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
        agentSpec: "advisor",
        consultKind: "review",
        objective: "review the changed runtime boundaries",
        consultBrief: buildConsultBrief(
          "What is the strongest second opinion on the boundary changes?",
          "Return review-focused evidence and next steps.",
        ),
        activeSkillName: "review",
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
      consultBrief: {
        decision: "What is the strongest second opinion on the boundary changes?",
        successCriteria: "Return review-focused evidence and next steps.",
      },
      activeSkillName: "review",
      executionHints: {
        preferredTools: ["lsp_diagnostics"],
        fallbackTools: ["grep"],
        preferredSkills: ["review"],
      },
    });
  });

  test("accepts executionShape-only requests and forwards completion predicates", async () => {
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
                delegate:
                  input.request.agentSpec ??
                  input.request.envelope ??
                  input.request.executionShape?.resultMode ??
                  "ad-hoc",
                outcomes: [
                  {
                    ok: true,
                    runId: "run-derived-delegate",
                    delegate:
                      input.request.agentSpec ??
                      input.request.envelope ??
                      input.request.executionShape?.resultMode ??
                      "qa",
                    kind: "qa" as const,
                    status: "ok" as const,
                    summary: "qa summary",
                    metrics: { durationMs: 8 },
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
      "tc-subagent-derived-shape",
      {
        executionShape: {
          resultMode: "qa",
          boundary: "safe",
          model: "openai/gpt-5.4-mini",
          managedToolMode: "direct",
        },
        objective: "QA the delegated runtime checks",
        completionPredicate: {
          source: "events",
          type: "worker_results_applied",
          match: {
            workerId: "worker-12",
          },
          policy: "cancel_when_true",
        },
      },
      undefined,
      undefined,
      fakeContext("session-derived-shape"),
    );

    expect(capturedRequest?.agentSpec).toBeUndefined();
    expect(capturedRequest?.executionShape).toEqual({
      resultMode: "qa",
      boundary: "safe",
      model: "openai/gpt-5.4-mini",
      managedToolMode: "direct",
    });
    expect(capturedRequest?.packet?.completionPredicate).toEqual({
      source: "events",
      type: "worker_results_applied",
      match: {
        workerId: "worker-12",
      },
      policy: "cancel_when_true",
    });
    expect(extractText(result)).toContain("delegate=qa");
    expect((result.details as { ok?: boolean } | undefined)?.ok).toBe(true);
  });

  test("forwards skill-first delegation fields to the subagent adapter", async () => {
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
                delegate: resolveDelegateName(input.request),
                outcomes: [],
              };
            },
          },
        },
      } as any,
    });

    await tool.execute(
      "tc-subagent-skill-first",
      {
        agentSpec: "advisor",
        envelope: "readonly-advisor",
        skillName: "review",
        consultKind: "review",
        fallbackResultMode: "consult",
        objective: "Review the delegation runtime changes",
        consultBrief: buildConsultBrief(
          "Should the runtime delegation change proceed?",
          "Preserve the semantic review skill while using the advisor execution identity.",
        ),
      },
      undefined,
      undefined,
      fakeContext("session-skill-first"),
    );

    expect(capturedRequest).toMatchObject({
      agentSpec: "advisor",
      envelope: "readonly-advisor",
      skillName: "review",
      consultKind: "review",
      fallbackResultMode: "consult",
      packet: {
        objective: "Review the delegation runtime changes",
        consultBrief: {
          decision: "Should the runtime delegation change proceed?",
          successCriteria:
            "Preserve the semantic review skill while using the advisor execution identity.",
        },
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
              delegate: "advisor",
              outcomes: [],
            }),
            start: async (input: { fromSessionId: string; request: SubagentRunRequest }) => ({
              ok: true,
              mode: input.request.mode,
              delegate: resolveDelegateName(input.request),
              runs: [
                {
                  runId: "run-background-1",
                  delegate: resolveDelegateName(input.request),
                  parentSessionId: input.fromSessionId,
                  status: "pending",
                  createdAt: 1,
                  updatedAt: 1,
                  kind: "consult",
                  consultKind: "investigate",
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
        agentSpec: "advisor",
        consultKind: "investigate",
        objective: "scan the runtime surface",
        consultBrief: buildConsultBrief(
          "Which runtime surfaces should be scanned first?",
          "Launch a background investigation with a clear question.",
        ),
        waitMode: "start",
      },
      undefined,
      undefined,
      fakeContext("session-start"),
    );

    expect(extractText(result)).toContain("subagent_run started for delegate=advisor");
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
                delegate: resolveDelegateName(input.request),
                outcomes: [
                  {
                    ok: true,
                    runId: "fanout-1",
                    label: "gateway",
                    delegate: resolveDelegateName(input.request),
                    kind: "consult" as const,
                    consultKind: "investigate" as const,
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
        agentSpec: "advisor",
        consultKind: "investigate",
        consultBrief: buildConsultBrief(
          "How should repository analysis be split across slices?",
          "Each slice should return investigative findings only.",
        ),
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
    expect(extractText(result)).toContain("subagent_fanout completed for delegate=advisor");
    expect((result.details as { ok?: boolean } | undefined)?.ok).toBe(true);
  });

  test("subagent_fanout rejects legacy delegation fields nested in tasks", async () => {
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
                delegate: "advisor",
                outcomes: [],
              };
            },
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-fanout-legacy-fields",
      {
        agentSpec: "advisor",
        tasks: [
          {
            label: "runtime",
            objective: "inspect runtime entrypoints",
            requiredOutputs: ["findings"],
          },
        ],
      },
      undefined,
      undefined,
      fakeContext("session-fanout-legacy"),
    );

    expect(adapterCalled).toBe(false);
    expect(extractText(result)).toContain("removed legacy delegation fields are not supported");
    expect(extractText(result)).toContain("tasks[0].requiredOutputs");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });
});
