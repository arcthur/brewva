import { describe, expect, test } from "bun:test";
import type { SubagentForkRequest, SubagentRunRequest } from "@brewva/brewva-tools/contracts";
import {
  createSubagentFanoutTool,
  createSubagentForkTool,
  createDelegationInboxQueryTool,
  createSubagentRunDiagnosticTool,
  createSubagentRunTool,
  createSubagentStatusTool,
} from "@brewva/brewva-tools/delegation";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-vocabulary/delegation";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

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
  test("derives the public role from gate reason for direct role mismatches", async () => {
    let capturedRequest: SubagentRunRequest | undefined;
    const tool = createSubagentRunTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async (input: { request: SubagentRunRequest }) => {
              capturedRequest = input.request;
              return {
                ok: true,
                mode: input.request.mode,
                delegate: input.request.agent,
                outcomes: [
                  {
                    ok: true,
                    runId: "run-gate-derived-1",
                    agent: input.request.agent,
                    taskName: "collect-routing-evidence",
                    taskPath: "/collect-routing-evidence",
                    nickname: "collect routing evidence",
                    delegate: input.request.agent,
                    kind: "evidence" as const,
                    status: "ok" as const,
                    workerSessionId: "worker-gate-derived-1",
                    summary: "Evidence collection routed to the navigator.",
                    data: {
                      kind: "evidence" as const,
                      summary: "Evidence collection routed to the navigator.",
                      sourceRefs: [
                        "packages/brewva-tools/src/families/delegation/subagent-run/api.ts",
                      ],
                    },
                    metrics: { durationMs: 4 },
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
      "tc-public-run-gate-derived-role",
      {
        agent: "explorer",
        gateReason: "find_evidence",
        objective: "collect evidence about public delegation routing",
      },
      undefined,
      undefined,
      fakeContext("session-public-run-gate-derived-role"),
    );

    expect(capturedRequest?.agent).toBe("navigator");
    expect(capturedRequest?.gateReason).toBe("find_evidence");
    expect(extractText(result)).toContain("delegate=navigator");
  });

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
                    agent: "navigator",
                    taskName: "trace-gateway-entrypoints",
                    taskPath: "/trace-gateway-entrypoints",
                    nickname: "trace gateway entrypoints",
                    delegate: "navigator",
                    skillName: input.request.skillName,
                    kind: "evidence" as const,
                    status: "ok" as const,
                    workerSessionId: "worker-public-1",
                    summary: `summary:${input.request.packet?.objective}`,
                    data: {
                      kind: "evidence" as const,
                      summary: "Gateway entrypoints are the first read target.",
                      sourceRefs: ["packages/brewva-gateway/src/hosted/api.ts"],
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
        agent: "navigator",
        skillName: "discovery",
        objective: "trace the gateway entrypoints",
        brief: buildBrief("Which gateway entrypoints matter first?"),
      },
      undefined,
      undefined,
      fakeContext("session-public-run"),
    );

    expect(extractText(result)).toContain("delegate=navigator");
    expect(capturedRequest).toEqual({
      agent: "navigator",
      skillName: "discovery",
      taskName: undefined,
      nickname: undefined,
      forkTurns: "none",
      gateReason: undefined,
      mode: "single",
      timeoutMs: undefined,
      packet: {
        objective: "trace the gateway entrypoints",
        consultBrief: buildBrief("Which gateway entrypoints matter first?"),
        executionHints: undefined,
        contextBudget: undefined,
        effectCeiling: undefined,
      },
    });
    const detailsText = JSON.stringify(toolOutcomePayload(result));
    expect(detailsText).not.toContain("agentSpec");
    expect(detailsText).not.toContain("explorer-readonly");
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
        agent: "explorer",
        skillName: "review",
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
                delegate: "explorer",
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

  test("reports supplemental return requests without hidden context reinjection", async () => {
    const tool = createSubagentRunTool({
      runtime: {
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
                  agent: "explorer",
                  taskName: "review",
                  taskPath: "/review",
                  nickname: "review",
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
        agent: "explorer",
        skillName: "review",
        objective: "summarize repository impact",
        brief: buildBrief("What repository impact should the parent remember?"),
        returnMode: "supplemental",
        returnScopeId: "delegation-leaf",
      },
      undefined,
      undefined,
      fakeContext("session-supplemental"),
    );

    expect(extractText(result)).toContain("supplemental delivery skipped (unavailable)");
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
                  agent: "explorer" as const,
                  targetName: "explorer",
                  taskName: "review",
                  taskPath: "/review",
                  nickname: "review",
                  depth: 1,
                  forkTurns: "none" as const,
                  gateReason: "make_judgment" as const,
                  modelCategory: "deep-reasoning" as const,
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
                  agentSpec: "explorer",
                  envelope: "explorer-readonly",
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
        agent: "explorer",
        skillName: "review",
        objective: "scan the runtime surface",
        brief: buildBrief("Which runtime surfaces should be scanned first?"),
        waitMode: "start",
      },
      undefined,
      undefined,
      fakeContext("session-start"),
    );

    expect(extractText(result)).toContain("subagent_run started for delegate=explorer");
    expect(extractText(result)).toContain("run-background-1");
    const detailsText = JSON.stringify(toolOutcomePayload(result));
    expect(detailsText).not.toContain("agentSpec");
    expect(detailsText).not.toContain("explorer-readonly");
    expect(detailsText).not.toContain("consultKind");
    expect(detailsText).not.toContain("worker-background-1");
  });
});

describe("delegation inbox query public surface", () => {
  test("returns explicit-pull inbox items without injecting them into parent context", async () => {
    const tool = createDelegationInboxQueryTool({
      runtime: {
        delegation: {
          inspect: async () => ({
            sessionId: "session-inbox",
            runCards: [],
            workboard: {
              pendingWorkerPatches: [],
              pendingKnowledgeAdoptions: [],
              unreadEvidence: [],
              verificationDebt: [],
              blockedOrFailedRuns: [],
            },
            inbox: {
              explicitPull: true,
              items: [
                {
                  itemId: "worker_patch:worker-1",
                  kind: "worker_patch",
                  runId: "worker-1",
                  title: "Apply worker patch",
                  summary: "Worker produced a patch.",
                  disposition: "pending_apply",
                  adoptionRequirement: "patch_apply",
                  eventId: "evt-worker-1",
                  canonicalRefs: ["event:evt-worker-1", "delegation:worker-1"],
                },
              ],
            },
            timeline: { explicitPull: true, groups: [] },
            recoveryPreview: {
              continuationAnchor: { kind: "event", id: "evt-worker-1" },
              activeTrust: {
                toolCalls: 0,
                approvals: 0,
                mutations: 0,
                workerResults: 1,
                verifierEvidence: 0,
              },
              primitives: [
                { kind: "resume" },
                { kind: "reject_adoption", target: "worker_patch", runId: "worker-1" },
              ],
              nextReceiptOwner: "parent",
            },
          }),
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-inbox",
      { limit: 10 },
      undefined,
      undefined,
      fakeContext("session-inbox"),
    );

    expect(extractText(result)).toContain("# Delegation Inbox");
    expect(extractText(result)).toContain("worker_patch worker-1");
    expect(toolOutcomePayload(result)).toMatchObject({
      ok: true,
      explicitPull: true,
      injectedIntoParentContext: false,
      items: [
        {
          itemId: "worker_patch:worker-1",
          canonicalRefs: ["event:evt-worker-1", "delegation:worker-1"],
        },
      ],
    });
  });
});

describe("subagent_status V2 run-card surface", () => {
  test("public mode returns run cards without routing or capability internals", async () => {
    const tool = createSubagentStatusTool({
      runtime: {
        delegation: {
          listRuns: async () => [
            {
              contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
              runId: "worker-card-1",
              parentSessionId: "session-status",
              agent: "worker",
              targetName: "worker",
              delegate: "worker",
              taskName: "Implement cards",
              taskPath: "/cards",
              nickname: "Implement cards",
              depth: 1,
              forkTurns: "none",
              gateReason: "implement_isolated",
              modelCategory: "isolated-execution",
              executionPrimitive: "named",
              visibility: "public",
              isolationStrategy: "snapshot",
              adoption: { decision: "patch_apply" },
              status: "completed",
              createdAt: 1,
              updatedAt: 2,
              kind: "patch",
              agentSpec: "worker",
              envelope: "worker",
              modelRoute: { selectedModel: "provider/model" },
            },
          ],
          inspect: async () => ({
            sessionId: "session-status",
            runCards: [
              {
                runId: "worker-card-1",
                role: "worker",
                resultMode: "patch",
                lifecycle: "completed",
                lifecycleReason: "none",
                retention: "live",
                disposition: "pending_apply",
                adoptionRequirement: "patch_apply",
                title: "Implement cards",
                taskPath: "/cards",
                isolation: "snapshot",
                createdAt: 1,
                updatedAt: 2,
                eventId: "evt-worker-card-1",
                canonicalRefs: ["event:evt-worker-card-1", "delegation:worker-card-1"],
              },
            ],
            workboard: {
              pendingWorkerPatches: [],
              pendingKnowledgeAdoptions: [],
              unreadEvidence: [],
              verificationDebt: [],
              blockedOrFailedRuns: [],
            },
            inbox: { explicitPull: true, items: [] },
            timeline: { explicitPull: true, groups: [] },
            recoveryPreview: {
              continuationAnchor: { kind: "event", id: "evt-worker-card-1" },
              activeTrust: {
                toolCalls: 0,
                approvals: 0,
                mutations: 0,
                workerResults: 1,
                verifierEvidence: 0,
              },
              primitives: [{ kind: "resume" }],
              nextReceiptOwner: "parent",
            },
          }),
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-status",
      { detailMode: "public" },
      undefined,
      undefined,
      fakeContext("session-status"),
    );

    expect(toolOutcomePayload(result)).toMatchObject({
      detailMode: "public",
      runCards: [
        {
          runId: "worker-card-1",
          role: "worker",
          disposition: "pending_apply",
        },
      ],
    });
    const detailsText = JSON.stringify(toolOutcomePayload(result));
    expect(detailsText).not.toContain("agentSpec");
    expect(detailsText).not.toContain("envelope");
    expect(detailsText).not.toContain("modelRoute");
    expect(detailsText).not.toContain("provider/model");
  });

  test("public mode fails closed when inspection projection is unavailable", async () => {
    const tool = createSubagentStatusTool({
      runtime: {
        delegation: {
          listRuns: async () => [
            {
              contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
              runId: "worker-card-1",
              parentSessionId: "session-status",
              agent: "worker",
              targetName: "worker",
              delegate: "worker",
              taskName: "Implement cards",
              taskPath: "/cards",
              nickname: "Implement cards",
              depth: 1,
              forkTurns: "none",
              gateReason: "implement_isolated",
              modelCategory: "isolated-execution",
              executionPrimitive: "named",
              visibility: "public",
              isolationStrategy: "snapshot",
              adoption: { decision: "patch_apply" },
              status: "completed",
              createdAt: 1,
              updatedAt: 2,
              kind: "patch",
              agentSpec: "worker",
              envelope: "worker",
              modelRoute: { selectedModel: "provider/model" },
            },
          ],
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-status-no-inspection",
      { detailMode: "public" },
      undefined,
      undefined,
      fakeContext("session-status"),
    );

    expect(extractText(result)).toContain("delegation inspection projection is unavailable");
    const detailsText = JSON.stringify(toolOutcomePayload(result));
    expect(detailsText).not.toContain("agentSpec");
    expect(detailsText).not.toContain("envelope");
    expect(detailsText).not.toContain("modelRoute");
    expect(detailsText).not.toContain("provider/model");
  });
});

describe("subagent_fanout public surface", () => {
  test("derives the public fanout role from gate reason for direct role mismatches", async () => {
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
                delegate: input.request.agent,
                outcomes: [
                  {
                    ok: true,
                    runId: "fanout-gate-derived-1",
                    label: "routing",
                    delegate: input.request.agent,
                    kind: "evidence" as const,
                    status: "ok" as const,
                    summary: "Fanout evidence collection routed to the navigator.",
                    data: {
                      kind: "evidence" as const,
                      summary: "Fanout evidence collection routed to the navigator.",
                      sourceRefs: [
                        "packages/brewva-tools/src/families/delegation/subagent-run/api.ts",
                      ],
                    },
                    metrics: { durationMs: 5 },
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
      "tc-public-fanout-gate-derived-role",
      {
        agent: "explorer",
        gateReason: "find_evidence",
        objective: "compare approval and rollback evidence across repositories",
        tasks: [
          { label: "brewva", objective: "collect Brewva delegation evidence" },
          { label: "external", objective: "collect external repository evidence" },
        ],
      },
      undefined,
      undefined,
      fakeContext("session-public-fanout-gate-derived-role"),
    );

    expect(capturedRequest?.agent).toBe("navigator");
    expect(capturedRequest?.gateReason).toBe("find_evidence");
    expect(capturedRequest?.tasks?.map((task) => task.label)).toEqual(["brewva", "external"]);
    expect(extractText(result)).toContain("subagent_fanout completed for delegate=navigator");
  });

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
        agent: "explorer",
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
    expect(capturedRequest?.packet).toBe(undefined);
    expect(capturedRequest?.tasks).toEqual([
      expect.objectContaining({
        label: "gateway",
        objective: "inspect gateway entrypoints",
        consultBrief: buildBrief("Which findings should block merge?"),
      }),
      expect.objectContaining({
        label: "runtime",
        objective: "inspect runtime entrypoints",
        consultBrief: buildBrief("Which findings should block merge?"),
      }),
    ]);
    expect(capturedRequest?.tasks?.[0]).not.toHaveProperty("activeSkillName");
    expect(capturedRequest?.tasks?.[1]).not.toHaveProperty("activeSkillName");
    expect(extractText(result)).toContain("subagent_fanout completed for delegate=explorer");
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
                delegate: input.request.targetName ?? "diagnostic",
                outcomes: [
                  {
                    ok: true,
                    runId: "diagnostic-run-1",
                    agent: "explorer",
                    taskName: "review-security",
                    taskPath: "/review-security",
                    nickname: "review-security",
                    targetName: input.request.targetName,
                    delegate: input.request.targetName ?? "diagnostic",
                    envelope: "explorer-readonly",
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
        agent: "explorer",
        targetName: "review-security",
        consultKind: "review",
        objective: "probe review-security routing",
        consultBrief: buildBrief("Does this diagnostic lane route correctly?"),
      },
      undefined,
      undefined,
      fakeContext("session-diagnostic"),
    );

    expect((toolOutcomePayload(result) as { ok?: boolean } | undefined)?.ok).toBe(true);
    expect(capturedRequest).toMatchObject({
      agent: "explorer",
      targetName: "review-security",
      consultKind: "review",
    });
    const detailsText = JSON.stringify(toolOutcomePayload(result));
    expect(detailsText).toContain("targetName");
    expect(detailsText).toContain("explorer-readonly");
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
                  agent: "explorer",
                  targetName: "fork",
                  delegate: "fork",
                  taskName: "try-same-context-investigation-branch",
                  taskPath: "/try-same-context-investigation-branch",
                  nickname: "try a same-context investigation branch",
                  depth: 1,
                  forkTurns: "all" as const,
                  gateReason: "make_judgment" as const,
                  modelCategory: "deep-reasoning" as const,
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
                    forkTurns: "all" as const,
                  },
                  parentSessionId: input.fromSessionId,
                  status: "completed" as const,
                  createdAt: 1,
                  updatedAt: 2,
                  agentSpec: "explorer",
                  envelope: "explorer-readonly",
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
        forkTurns: "all",
      },
      undefined,
      undefined,
      fakeContext("session-fork"),
    );

    expect(capturedRequest).toEqual({
      objective: "try a same-context investigation branch",
      taskName: undefined,
      nickname: undefined,
      forkTurns: "all",
      deliverable: undefined,
      timeoutMs: undefined,
    });
    expect(extractText(result)).toContain("primitive=fork");
    expect(extractText(result)).toContain("fork complete");
    const detailsText = JSON.stringify(toolOutcomePayload(result));
    expect(detailsText).not.toContain("agentSpec");
    expect(detailsText).not.toContain("explorer-readonly");
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
              error: "missing_readonly_explorer_envelope",
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
    expect(extractText(result)).toContain("error=missing_readonly_explorer_envelope");
  });
});
