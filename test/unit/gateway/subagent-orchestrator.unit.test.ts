import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostedSubagentAdapter,
  type HostedSubagentSessionOptions,
} from "@brewva/brewva-gateway";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
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
            async sendUserMessage() {
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
        profile: "patch-worker",
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
      patchChangeCount: 1,
      posture: "reversible_mutate",
    });

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("allows packet posture to narrow a patch-worker profile back to observe", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-narrow-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const parentSessionId = "parent-session-narrow";
    let capturedBuiltinTools: readonly string[] = [];

    const adapter = createHostedSubagentAdapter({
      runtime,
      async createChildSession(input: HostedSubagentSessionOptions) {
        capturedBuiltinTools = input.builtinToolNames ?? [];
        const childRuntime = new BrewvaRuntime({ cwd: input.cwd ?? workspaceRoot });
        const childSessionId = "child-observe";
        const listeners = new Set<(event: AgentSessionEvent) => void>();

        return {
          runtime: childRuntime,
          session: {
            dispose() {},
            async sendUserMessage() {
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
        profile: "patch-worker",
        mode: "single",
        packet: {
          objective: "Inspect the module without changing files.",
          effectCeiling: {
            posture: "observe",
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedBuiltinTools).toEqual(["read"]);
    expect(runtime.session.listWorkerResults(parentSessionId)).toEqual([
      expect.objectContaining({
        workerId: expect.any(String),
        status: "skipped",
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
            async sendUserMessage() {
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
        profile: "researcher",
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
            async sendUserMessage() {
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
                    content: [{ type: "text", text: "Background review completed." }],
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
        profile: "reviewer",
        mode: "single",
        packet: {
          objective: "Review the runtime boundary changes.",
        },
        delivery: {
          returnMode: "context_packet",
          returnScopeId: "delegation-review",
          returnTtlMs: 60_000,
        },
      },
    });

    const runId = started.runs[0]?.runId;
    if (!runId) {
      throw new Error("expected a background delegation run");
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = runtime.session.getDelegationRun(parentSessionId, runId);
      if (current?.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const records = runtime.proposals.list(parentSessionId, { kind: "context_packet" });
    expect(records).toHaveLength(1);

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
        mode: "context_packet",
        scopeId: "delegation-review",
        contextPacketProposalId: records[0]?.proposal.id,
        contextPacketDecision: records[0]?.receipt.decision,
      },
    });

    await rm(workspaceRoot, { recursive: true, force: true });
  });
});
