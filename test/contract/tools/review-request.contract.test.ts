import { describe, expect, test } from "bun:test";
import type { SubagentRunRequest, SubagentRunResult } from "@brewva/brewva-tools/contracts";
import { createReviewRequestTool } from "@brewva/brewva-tools/delegation";

function parameterNames(tool: { parameters: unknown }): string[] {
  return Object.keys(
    (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
  ).toSorted();
}

function stubRuntime(onRun?: (request: SubagentRunRequest) => void) {
  const events: Array<{ type: string; payload: unknown }> = [];
  return {
    identity: { cwd: process.cwd(), workspaceRoot: process.cwd(), agentId: "contract" },
    capabilities: {
      events: {
        records: {
          list: () => [],
          query: () => [],
        },
      },
      verification: {
        checks: { verify: () => ({ ok: true }) },
        findings: {
          record: (_sessionId: string, input: unknown) => {
            events.push({ type: "review.finding.recorded", payload: input });
            return { id: "rec" };
          },
        },
      },
    },
    orchestration: {
      subagents: {
        run: async (input: {
          fromSessionId: string;
          request: SubagentRunRequest;
        }): Promise<SubagentRunResult> => {
          onRun?.(input.request);
          return {
            ok: true,
            mode: "single",
            delegate: input.request.agent,
            outcomes: [
              {
                ok: true,
                runId: "run-contract-1",
                agent: input.request.agent,
                taskName: "review",
                taskPath: "/review",
                nickname: "review",
                delegate: input.request.agent,
                kind: "consult" as const,
                consultKind: "review" as const,
                status: "ok" as const,
                workerSessionId: "reviewer-1",
                summary: "done",
                data: {
                  kind: "consult" as const,
                  consultKind: "review" as const,
                  conclusion: "clean",
                  disposition: "clear" as const,
                },
                metrics: { durationMs: 1 },
                evidenceRefs: [],
              },
            ],
          };
        },
      },
    },
  } as never;
}

describe("review_request public surface", () => {
  test("authors exactly target, lenses, stance, modelHint, and waitMode — no low-level packet fields", () => {
    const tool = createReviewRequestTool({ runtime: stubRuntime() });
    expect(parameterNames(tool)).toEqual(["lenses", "modelHint", "stance", "target", "waitMode"]);
  });

  test("an unusable target errors before dispatch and never reaches the reviewer", async () => {
    let runCount = 0;
    const tool = createReviewRequestTool({
      runtime: stubRuntime(() => {
        runCount += 1;
      }),
    });

    const result = await tool.execute(
      "tc-contract-1",
      { target: { kind: "session_diff" } },
      undefined as never,
      undefined as never,
      { sessionManager: { getSessionId: () => "contract-session-1" } } as never,
    );

    // session_diff with no applied patches is an unusable input (Axiom 18: the
    // tool errors only for a bad target), and the reviewer is never dispatched.
    expect(result.outcome.kind).toBe("err");
    expect(runCount).toBe(0);
  });

  test("modelHint rides the delegation packet into gateway routing (never a bypass field)", async () => {
    let captured: SubagentRunRequest | undefined;
    const tool = createReviewRequestTool({
      runtime: stubRuntime((request) => {
        captured = request;
      }),
    });

    // A files target with no applied patches dispatches (file_digests snapshot);
    // the modelHint must land on the packet, not on a bespoke request field.
    await tool.execute(
      "tc-contract-2",
      { target: { kind: "files", paths: ["package.json"] }, modelHint: "openai/gpt-5.5:medium" },
      undefined as never,
      undefined as never,
      { sessionManager: { getSessionId: () => "contract-session-2" } } as never,
    );

    expect(captured?.agent).toBe("explorer");
    expect(captured?.consultKind).toBe("review");
    expect(captured?.mode).toBe("single");
    expect(captured?.packet?.modelHint).toBe("openai/gpt-5.5:medium");
    // The routing hint lives ONLY on the packet: the dispatched request envelope
    // exposes exactly the routing-neutral fields (plus the review dispatch
    // anchor that rides the run record), with no top-level modelHint.
    expect(Object.keys(captured ?? {}).toSorted()).toEqual([
      "agent",
      "consultKind",
      "mode",
      "packet",
      "reviewDispatch",
    ]);
  });
});
