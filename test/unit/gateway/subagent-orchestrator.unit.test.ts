import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostedSubagentAdapter,
  HostedDelegationStore,
  type HostedSubagentSessionOptions,
} from "@brewva/brewva-gateway";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

function createTempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("hosted subagent orchestrator", () => {
  test("records patch worker results from an isolated child workspace", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-parent-");
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(workspaceRoot, "src", "message.ts"), "export const message = 'before';\n");

    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const parentSessionId = "parent-session";
    let childWorkspaceRoot = "";

    const adapter = createHostedSubagentAdapter({
      runtime,
      async createChildSession(input: HostedSubagentSessionOptions) {
        childWorkspaceRoot = input.cwd ?? "";
        const childRuntime = new BrewvaRuntime({ cwd: input.cwd });
        const childSessionId = "child-session";
        const listeners = new Set<(event: AgentSessionEvent) => void>();

        return {
          runtime: childRuntime,
          session: {
            dispose() {},
            async prompt() {
              await writeFile(
                join(childWorkspaceRoot, "src", "message.ts"),
                "export const message = 'after';\n",
                "utf8",
              );
              childRuntime.cost.recordAssistantUsage({
                sessionId: childSessionId,
                model: "test-child-model",
                inputTokens: 12,
                outputTokens: 8,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 20,
                costUsd: 0.004,
                stopReason: "stop",
              });
              for (const listener of listeners) {
                listener({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Patched src/message.ts in isolation." }],
                  },
                } as AgentSessionEvent);
              }
            },
            agent: {
              async waitForIdle() {},
            },
            sessionManager: {
              getSessionId() {
                return childSessionId;
              },
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        };
      },
    });

    const result = await adapter.run({
      fromSessionId: parentSessionId,
      request: {
        agentSpec: "patch-worker",
        mode: "single",
        packet: {
          objective: "Update the exported message constant.",
          deliverable: "A minimal code patch.",
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0];
    expect(outcome?.ok).toBe(true);
    if (!outcome || !outcome.ok) {
      throw new Error("expected a successful patch outcome");
    }
    expect(outcome.kind).toBe("patch");
    expect(outcome.status).toBe("ok");
    expect(outcome.workerSessionId).toBe("child-session");
    expect(outcome.patches?.changes).toEqual([
      expect.objectContaining({
        path: "src/message.ts",
        action: "modify",
      }),
    ]);
    expect(
      outcome.patches?.changes.some((change) => change.path === ".brewva/skills_index.json"),
    ).toBe(false);
    expect(outcome.artifactRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "patch_manifest",
        }),
        expect.objectContaining({
          kind: "patch_file",
        }),
      ]),
    );

    const workerResults = runtime.session.listWorkerResults(parentSessionId);
    expect(workerResults).toHaveLength(1);
    expect(workerResults[0]).toMatchObject({
      workerId: outcome.runId,
      status: "ok",
    });
    expect(workerResults[0]?.patches?.changes).toEqual(outcome.patches?.changes);
    const recordedChange = workerResults[0]?.patches?.changes[0];
    expect(recordedChange?.artifactRef).toBeTruthy();
    expect(existsSync(join(workspaceRoot, recordedChange?.artifactRef ?? ""))).toBe(true);

    const parentFile = await readFile(join(workspaceRoot, "src", "message.ts"), "utf8");
    expect(parentFile).toBe("export const message = 'before';\n");
    expect(childWorkspaceRoot).not.toBe(workspaceRoot);
    expect(existsSync(childWorkspaceRoot)).toBe(false);

    const costSummary = runtime.cost.getSummary(parentSessionId);
    expect(costSummary.totalTokens).toBe(20);
    expect(costSummary.totalCostUsd).toBe(0.004);

    const completedEvents = runtime.events.list(parentSessionId, { type: "subagent_completed" });
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.payload).toMatchObject({
      workerStatus: "ok",
      patchChangeCount: outcome.patches?.changes.length,
      boundary: "effectful",
    });

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("allows packet boundary to narrow a patch-worker target back to safe", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-narrow-");
    const runtimeConfig = structuredClone(DEFAULT_BREWVA_CONFIG);
    runtimeConfig.infrastructure.events.level = "ops";
    const runtime = new BrewvaRuntime({
      cwd: workspaceRoot,
      config: runtimeConfig,
    });
    const parentSessionId = "parent-session-narrow";
    let capturedBuiltinTools: readonly string[] = [];
    let capturedEventsLevel = "";

    const adapter = createHostedSubagentAdapter({
      runtime,
      async createChildSession(input: HostedSubagentSessionOptions) {
        capturedBuiltinTools = input.builtinToolNames ?? [];
        capturedEventsLevel = input.config?.infrastructure.events.level ?? "";
        const childRuntime = new BrewvaRuntime({ cwd: input.cwd ?? workspaceRoot });
        const childSessionId = "child-observe";
        const listeners = new Set<(event: AgentSessionEvent) => void>();

        return {
          runtime: childRuntime,
          session: {
            dispose() {},
            async prompt() {
              for (const listener of listeners) {
                listener({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Observation only." }],
                  },
                } as AgentSessionEvent);
              }
            },
            agent: {
              async waitForIdle() {},
            },
            sessionManager: {
              getSessionId() {
                return childSessionId;
              },
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        };
      },
    });

    const result = await adapter.run({
      fromSessionId: parentSessionId,
      request: {
        agentSpec: "patch-worker",
        mode: "single",
        packet: {
          objective: "Inspect the module without changing files.",
          effectCeiling: {
            boundary: "safe",
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedBuiltinTools).toEqual(["read"]);
    expect(capturedEventsLevel).toBe("ops");
    expect(runtime.session.listWorkerResults(parentSessionId)).toEqual([
      expect.objectContaining({
        status: "skipped",
        summary: "Observation only.",
      }),
    ]);

    const outcome = result.outcomes[0];
    expect(outcome?.ok).toBe(true);
    if (outcome && outcome.ok) {
      expect(outcome.kind).toBe("patch");
      expect(outcome.patches).toBeUndefined();
    }

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("resets child collected outputs when the child turn is superseded by recovery", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-recovery-attempt-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const parentSessionId = "parent-session-recovery-attempt";

    const adapter = createHostedSubagentAdapter({
      runtime,
      async createChildSession(input: HostedSubagentSessionOptions) {
        const childRuntime = new BrewvaRuntime({ cwd: input.cwd ?? workspaceRoot });
        const childSessionId = "child-recovery-attempt";
        const listeners = new Set<(event: AgentSessionEvent) => void>();

        return {
          runtime: childRuntime,
          session: {
            dispose() {},
            async prompt() {
              for (const listener of listeners) {
                listener({
                  type: "tool_execution_end",
                  toolCallId: "tc-first-attempt",
                  toolName: "read",
                  result: "first attempt tool output",
                  isError: false,
                } as AgentSessionEvent);
              }

              childRuntime.events.record({
                sessionId: childSessionId,
                type: "session_turn_transition",
                payload: {
                  reason: "provider_fallback_retry",
                  status: "entered",
                  sequence: 1,
                  family: "recovery",
                  attempt: 1,
                  sourceEventId: null,
                  sourceEventType: null,
                  error: null,
                  breakerOpen: false,
                  model: "test/fallback",
                },
              });

              for (const listener of listeners) {
                listener({
                  type: "tool_execution_end",
                  toolCallId: "tc-second-attempt",
                  toolName: "read",
                  result: "second attempt tool output",
                  isError: false,
                } as AgentSessionEvent);
                listener({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Recovered child answer." }],
                  },
                } as AgentSessionEvent);
              }
            },
            agent: {
              async waitForIdle() {},
            },
            sessionManager: {
              getSessionId() {
                return childSessionId;
              },
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        };
      },
    });

    const result = await adapter.run({
      fromSessionId: parentSessionId,
      request: {
        agentSpec: "patch-worker",
        mode: "single",
        packet: {
          objective: "Inspect the module after a recoverable provider retry.",
          effectCeiling: {
            boundary: "safe",
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    const outcome = result.outcomes[0];
    expect(outcome?.ok).toBe(true);
    if (!outcome || !outcome.ok) {
      throw new Error("expected a successful recovery outcome");
    }
    const evidenceRefs = outcome.evidenceRefs ?? [];
    expect(evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool_result",
          locator: "session:child-recovery-attempt:tool:tc-second-attempt",
        }),
      ]),
    );
    expect(
      evidenceRefs.some(
        (ref) => ref.kind === "tool_result" && ref.locator.includes("tc-first-attempt"),
      ),
    ).toBe(false);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("captures structured QA outcomes from the child assistant response", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-structured-success-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const parentSessionId = "parent-session-structured-success";

    const adapter = createHostedSubagentAdapter({
      runtime,
      async createChildSession(input: HostedSubagentSessionOptions) {
        const childRuntime = new BrewvaRuntime({ cwd: input.cwd ?? workspaceRoot });
        const childSessionId = "child-structured-success";
        const listeners = new Set<(event: AgentSessionEvent) => void>();

        return {
          runtime: childRuntime,
          session: {
            dispose() {},
            async prompt() {
              for (const listener of listeners) {
                listener({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: [
                          "QA completed with one inconclusive probe.",
                          "<delegation_outcome_json>",
                          JSON.stringify({
                            kind: "qa",
                            verdict: "inconclusive",
                            checks: [
                              {
                                name: "unit",
                                result: "pass",
                                command: "bun test",
                                exitCode: 0,
                                cwd: ".",
                                observedOutput: "12 tests passed",
                                probeType: "baseline",
                                summary: "Unit coverage is green.",
                                artifactRefs: ["session:child-structured-success:agent_end"],
                              },
                              {
                                name: "e2e",
                                result: "inconclusive",
                                tool: "browser_open",
                                observedOutput:
                                  "No browser target is configured in the isolated harness.",
                                probeType: "environment_limit",
                                summary: "E2E lane was intentionally skipped.",
                              },
                            ],
                            skillOutputs: {
                              qa_report:
                                "Executed one baseline command and one constrained probe in the isolated harness.",
                              qa_findings: [
                                "The end-to-end probe stayed inconclusive because the test harness exposes no browser target.",
                              ],
                              qa_verdict: "inconclusive",
                              qa_checks: [
                                {
                                  name: "unit",
                                  result: "pass",
                                  command: "bun test",
                                  exitCode: 0,
                                  cwd: ".",
                                  observedOutput: "12 tests passed",
                                  probeType: "baseline",
                                  artifactRefs: ["session:child-structured-success:agent_end"],
                                },
                                {
                                  name: "e2e",
                                  result: "inconclusive",
                                  tool: "browser_open",
                                  observedOutput:
                                    "No browser target is configured in the isolated harness.",
                                  probeType: "environment_limit",
                                  summary: "E2E lane was intentionally skipped.",
                                },
                              ],
                              qa_missing_evidence: [
                                "No browser-level flow or service-level end-to-end probe was attached.",
                              ],
                              qa_confidence_gaps: [
                                "The isolated harness cannot confirm the full user-visible path.",
                              ],
                              qa_environment_limits: [
                                "The test harness does not expose a browser or remote target.",
                              ],
                            },
                          }),
                          "</delegation_outcome_json>",
                        ].join("\n"),
                      },
                    ],
                  },
                } as AgentSessionEvent);
              }
            },
            agent: {
              async waitForIdle() {},
            },
            sessionManager: {
              getSessionId() {
                return childSessionId;
              },
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        };
      },
    });

    const result = await adapter.run({
      fromSessionId: parentSessionId,
      request: {
        agentSpec: "qa",
        mode: "single",
        packet: {
          objective: "QA the runtime checks.",
        },
      },
    });

    expect(result.ok).toBe(true);
    const outcome = result.outcomes[0];
    expect(outcome?.ok).toBe(true);
    if (!outcome || !outcome.ok) {
      throw new Error("expected a successful QA outcome");
    }

    expect(outcome.kind).toBe("qa");
    expect(outcome.data).toEqual({
      kind: "qa",
      verdict: "inconclusive",
      checks: [
        {
          name: "unit",
          result: "pass",
          command: "bun test",
          exitCode: 0,
          cwd: ".",
          observedOutput: "12 tests passed",
          probeType: "baseline",
          summary: "Unit coverage is green.",
          artifactRefs: ["session:child-structured-success:agent_end"],
        },
        {
          name: "e2e",
          result: "inconclusive",
          tool: "browser_open",
          observedOutput: "No browser target is configured in the isolated harness.",
          probeType: "environment_limit",
          summary: "E2E lane was intentionally skipped.",
        },
      ],
    });
    expect(outcome.skillOutputs).toMatchObject({
      qa_verdict: "inconclusive",
      qa_checks: expect.any(Array),
    });
    expect(outcome.summary).toBe("QA completed with one inconclusive probe.");
    expect(outcome.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          sourceSessionId: "child-structured-success",
        }),
      ]),
    );
    expect(
      runtime.events.list(parentSessionId, { type: "subagent_outcome_parse_failed" }),
    ).toHaveLength(0);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("captures structured review outcomes without requiring findings", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-review-structured-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const parentSessionId = "parent-session-review-structured";

    const adapter = createHostedSubagentAdapter({
      runtime,
      async createChildSession(input: HostedSubagentSessionOptions) {
        const childRuntime = new BrewvaRuntime({ cwd: input.cwd ?? workspaceRoot });
        const childSessionId = "child-review-structured";
        const listeners = new Set<(event: AgentSessionEvent) => void>();

        return {
          runtime: childRuntime,
          session: {
            dispose() {},
            async prompt() {
              for (const listener of listeners) {
                listener({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: [
                          "Boundary review completed without a blocking issue.",
                          "<delegation_outcome_json>",
                          JSON.stringify({
                            kind: "review",
                            lane: "review-boundaries",
                            disposition: "clear",
                            primaryClaim:
                              "The public ownership boundary remains stable across this change.",
                            strongestCounterpoint:
                              "A later export map change could still widen the surface unexpectedly.",
                            openQuestions: ["No release artifact diff was attached for this lane."],
                            missingEvidence: ["No dist smoke result was attached."],
                            confidence: "medium",
                          }),
                          "</delegation_outcome_json>",
                        ].join("\n"),
                      },
                    ],
                  },
                } as AgentSessionEvent);
              }
            },
            agent: {
              async waitForIdle() {},
            },
            sessionManager: {
              getSessionId() {
                return childSessionId;
              },
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        };
      },
    });

    const result = await adapter.run({
      fromSessionId: parentSessionId,
      request: {
        agentSpec: "review-boundaries",
        mode: "single",
        packet: {
          objective: "Review the runtime export boundary.",
        },
      },
    });

    expect(result.ok).toBe(true);
    const outcome = result.outcomes[0];
    expect(outcome?.ok).toBe(true);
    if (!outcome || !outcome.ok) {
      throw new Error("expected a successful review outcome");
    }

    expect(outcome.kind).toBe("review");
    expect(outcome.data).toEqual({
      kind: "review",
      lane: "review-boundaries",
      disposition: "clear",
      primaryClaim: "The public ownership boundary remains stable across this change.",
      strongestCounterpoint:
        "A later export map change could still widen the surface unexpectedly.",
      openQuestions: ["No release artifact diff was attached for this lane."],
      missingEvidence: ["No dist smoke result was attached."],
      confidence: "medium",
    });
    expect(outcome.summary).toBe("Boundary review completed without a blocking issue.");
    expect(
      runtime.events.list(parentSessionId, { type: "subagent_outcome_parse_failed" }),
    ).toHaveLength(0);
    expect(
      runtime.events.list(parentSessionId, { type: "subagent_completed" })[0]?.payload,
    ).toMatchObject({
      resultData: {
        kind: "review",
        lane: "review-boundaries",
        disposition: "clear",
      },
    });

    const delegationStore = new HostedDelegationStore(runtime);
    expect(delegationStore.listRuns(parentSessionId, { includeTerminal: true })[0]).toMatchObject({
      kind: "review",
      status: "completed",
      resultData: {
        kind: "review",
        lane: "review-boundaries",
        disposition: "clear",
      },
    });

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("keeps the run successful when the structured outcome block is missing", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-structured-fallback-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const parentSessionId = "parent-session-structured-fallback";

    const adapter = createHostedSubagentAdapter({
      runtime,
      async createChildSession(input: HostedSubagentSessionOptions) {
        const childRuntime = new BrewvaRuntime({ cwd: input.cwd ?? workspaceRoot });
        const childSessionId = "child-structured-fallback";
        const listeners = new Set<(event: AgentSessionEvent) => void>();

        return {
          runtime: childRuntime,
          session: {
            dispose() {},
            async prompt() {
              for (const listener of listeners) {
                listener({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: "QA completed, but only a prose summary is available.",
                      },
                    ],
                  },
                } as AgentSessionEvent);
              }
            },
            agent: {
              async waitForIdle() {},
            },
            sessionManager: {
              getSessionId() {
                return childSessionId;
              },
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        };
      },
    });

    const result = await adapter.run({
      fromSessionId: parentSessionId,
      request: {
        envelope: "qa-runner",
        executionShape: {
          resultMode: "qa",
        },
        mode: "single",
        packet: {
          objective: "QA the runtime checks.",
        },
      },
    });

    expect(result.ok).toBe(true);
    const outcome = result.outcomes[0];
    expect(outcome?.ok).toBe(true);
    if (!outcome || !outcome.ok) {
      throw new Error("expected a successful QA outcome");
    }

    expect(outcome.kind).toBe("qa");
    expect(outcome.data).toBeUndefined();
    expect(outcome.summary).toBe("QA completed, but only a prose summary is available.");
    expect(
      runtime.events.list(parentSessionId, { type: "subagent_outcome_parse_failed" }),
    ).toHaveLength(1);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("tracks background runs and supports cancellation", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-background-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const parentSessionId = "parent-session-background";
    let rejectPendingPrompt: ((error: Error) => void) | undefined;

    const adapter = createHostedSubagentAdapter({
      runtime,
      async createChildSession(input: HostedSubagentSessionOptions) {
        const childRuntime = new BrewvaRuntime({ cwd: input.cwd ?? workspaceRoot });
        const childSessionId = "child-background";
        const listeners = new Set<(event: AgentSessionEvent) => void>();

        return {
          runtime: childRuntime,
          session: {
            dispose() {},
            async abort() {
              rejectPendingPrompt?.(new Error("aborted"));
            },
            async prompt() {
              await new Promise<void>((_, reject) => {
                rejectPendingPrompt = (error) => reject(error);
              });
            },
            agent: {
              async waitForIdle() {},
            },
            sessionManager: {
              getSessionId() {
                return childSessionId;
              },
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        };
      },
    });
    if (!adapter.start || !adapter.status || !adapter.cancel) {
      throw new Error("expected full subagent adapter controls");
    }

    const started = await adapter.start({
      fromSessionId: parentSessionId,
      request: {
        agentSpec: "explore",
        mode: "single",
        packet: {
          objective: "Inspect the repository in the background.",
        },
      },
    });

    expect(started.ok).toBe(true);
    expect(started.runs).toHaveLength(1);
    const runId = started.runs[0]?.runId;
    if (!runId) {
      throw new Error("expected a launched background run");
    }

    await Promise.resolve();

    const status = await adapter.status({
      fromSessionId: parentSessionId,
      query: {
        runIds: [runId],
      },
    });
    expect(status.ok).toBe(true);
    expect(status.runs[0]).toMatchObject({
      runId,
      status: "running",
      live: true,
      cancelable: true,
    });

    const cancelled = await adapter.cancel({
      fromSessionId: parentSessionId,
      runId,
      reason: "manual_stop",
    });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.run).toMatchObject({
      runId,
      status: "cancelled",
    });

    const events = runtime.events.list(parentSessionId, { type: "subagent_cancelled" });
    expect(events).toHaveLength(1);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("clearing parent session state asks the background controller to cancel detached runs", () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-clear-state-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const cancelled: Array<{ sessionId: string; reason?: string }> = [];

    createHostedSubagentAdapter({
      runtime,
      backgroundController: {
        async startRun() {
          throw new Error("not used");
        },
        async inspectLiveRuns() {
          return new Map();
        },
        async cancelRun() {
          return {
            ok: false,
            error: "not used",
          };
        },
        async cancelSessionRuns(sessionId, reason) {
          cancelled.push({ sessionId, reason });
        },
      },
      async createChildSession() {
        throw new Error("not used");
      },
    });

    runtime.session.clearState("parent-session-clear");

    expect(cancelled).toEqual([
      {
        sessionId: "parent-session-clear",
        reason: "parent_session_cleared",
      },
    ]);
  });

  test("persists durable delivery metadata for background completion handoff", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-delivery-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const delegationStore = new HostedDelegationStore(runtime);
    const parentSessionId = "parent-session-delivery";

    const adapter = createHostedSubagentAdapter({
      runtime,
      async createChildSession(input: HostedSubagentSessionOptions) {
        const childRuntime = new BrewvaRuntime({ cwd: input.cwd ?? workspaceRoot });
        const childSessionId = "child-delivery";
        const listeners = new Set<(event: AgentSessionEvent) => void>();

        return {
          runtime: childRuntime,
          session: {
            dispose() {},
            async prompt() {
              childRuntime.cost.recordAssistantUsage({
                sessionId: childSessionId,
                model: "test-child-model",
                inputTokens: 6,
                outputTokens: 4,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 10,
                costUsd: 0.002,
                stopReason: "stop",
              });
              for (const listener of listeners) {
                listener({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Background delegated run completed." }],
                  },
                } as AgentSessionEvent);
              }
            },
            agent: {
              async waitForIdle() {},
            },
            sessionManager: {
              getSessionId() {
                return childSessionId;
              },
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        };
      },
    });
    if (!adapter.start || !adapter.status) {
      throw new Error("expected background controls");
    }

    const started = await adapter.start({
      fromSessionId: parentSessionId,
      request: {
        envelope: "readonly-scout",
        mode: "single",
        packet: {
          objective: "Inspect the runtime boundary changes.",
        },
        delivery: {
          returnMode: "text_only",
          returnScopeId: "delegation-review",
        },
      },
    });

    const runId = started.runs[0]?.runId;
    if (!runId) {
      throw new Error("expected a background delegation run");
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = delegationStore.getRun(parentSessionId, runId);
      if (current?.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const status = await adapter.status({
      fromSessionId: parentSessionId,
      query: {
        runIds: [runId],
      },
    });

    expect(status.runs[0]).toMatchObject({
      runId,
      status: "completed",
      delivery: {
        mode: "text_only",
        scopeId: "delegation-review",
        handoffState: "pending_parent_turn",
      },
    });

    await rm(workspaceRoot, { recursive: true, force: true });
  });
});
