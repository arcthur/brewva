import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DelegationRunRecord,
  SubagentRunRequest,
  SubagentRunResult,
} from "@brewva/brewva-tools/contracts";
import { createReviewRequestTool } from "@brewva/brewva-tools/delegation";
import { buildTapeRequirementFitness } from "@brewva/brewva-tools/runtime-port";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import {
  readReviewFindingRecordedEventPayload,
  REVIEW_FINDING_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/review";
import type { RequirementAtom } from "@brewva/brewva-vocabulary/task";
import {
  createBundledToolRuntime,
  createRuntimeFixture,
  type HostedRuntimeAdapterPort,
} from "../../helpers/runtime.js";
import { committedToolEvent, seedCommittedToolEvents } from "../../helpers/tool-events.js";

const toolContext = (sessionId: string) =>
  ({
    sessionManager: {
      getSessionId: () => sessionId,
    },
  }) as never;

function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((entry) => ("text" in entry ? (entry.text ?? "") : "")).join("");
}

interface StubReviewOptions {
  /** The structured review outcome the stubbed reviewer returns as `outcome.data`. */
  readonly data?: Record<string, unknown>;
  /** The routed model the delegation record reports (drives different_model basis). */
  readonly routedModel?: string;
  /** Capture the dispatched request so tests can assert packet shape and ordering. */
  readonly onRun?: (request: SubagentRunRequest) => void;
  /** Runs synchronously inside the stubbed run(), before it resolves — lets a test
   *  mutate the tape mid-review to prove the snapshot was taken pre-dispatch. */
  readonly duringRun?: () => void;
}

/**
 * Stubs the orchestration adapter (one completion run) and the delegation query
 * (routed-model record lookup) exactly the way the real gateway wires them, so
 * the tool's own snapshot/parse/commit logic is what is under test — never a
 * hand-rolled reviewer.
 */
function stubReviewOrchestration(
  options: StubReviewOptions,
): Pick<
  NonNullable<Parameters<typeof createBundledToolRuntime>[1]>,
  "orchestration" | "delegation"
> {
  const runId = "review-run-1";
  return {
    orchestration: {
      subagents: {
        run: async (input: {
          fromSessionId: string;
          request: SubagentRunRequest;
        }): Promise<SubagentRunResult> => {
          options.onRun?.(input.request);
          options.duringRun?.();
          return {
            ok: true,
            mode: "single",
            delegate: input.request.agent,
            outcomes: [
              {
                ok: true,
                runId,
                agent: input.request.agent,
                taskName: "review",
                taskPath: "/review",
                nickname: "review",
                delegate: input.request.agent,
                kind: "consult",
                consultKind: "review",
                status: "ok",
                workerSessionId: "reviewer-session-1",
                summary: "Independent review completed.",
                data: (options.data ?? {
                  kind: "consult",
                  consultKind: "review",
                  conclusion: "No material issues found.",
                  disposition: "clear",
                }) as never,
                metrics: { durationMs: 5 },
                evidenceRefs: [],
              },
            ],
          };
        },
      },
    },
    delegation: {
      listRuns: (
        _sessionId: string,
        _query?: { runIds?: readonly string[] },
      ): DelegationRunRecord[] =>
        options.routedModel
          ? ([
              {
                runId,
                modelRoute: { selectedModel: options.routedModel },
              },
            ] as unknown as DelegationRunRecord[])
          : [],
    },
  };
}

function findingEvents(runtime: HostedRuntimeAdapterPort, sessionId: string) {
  return runtime.ops.events.records
    .query(sessionId, { type: REVIEW_FINDING_RECORDED_EVENT_TYPE })
    .map((event) =>
      readReviewFindingRecordedEventPayload(event as { payload?: Record<string, unknown> }),
    );
}

function outcomeEvents(runtime: HostedRuntimeAdapterPort, sessionId: string) {
  return runtime.ops.events.records
    .query(sessionId, { type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE })
    .map((event) =>
      readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
    );
}

describe("review_request tool — parameter surface", () => {
  test("exposes exactly target, lenses, stance, modelHint, and waitMode", () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const keys = Object.keys(
      (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
    ).toSorted();
    expect(keys).toEqual(["lenses", "modelHint", "stance", "target", "waitMode"]);
  });

  test("waitMode is the completion|start literal union", () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const waitMode = (
      (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    ).waitMode;
    const rendered = JSON.stringify(waitMode);
    expect(rendered).toContain("completion");
    expect(rendered).toContain("start");
  });
});

describe("review_request tool — target snapshot", () => {
  test("session_diff over applied patch sets snapshots a patch_sets targetRef", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-session-diff-1";
    runtime.ops.tools.sourcePatch.plans.apply(sessionId, {
      ok: true,
      planId: "plan-1",
      patchSetId: "patch-1",
      appliedPaths: ["src/a.ts"],
      failedPaths: [],
    });

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "session_diff" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.targetRef).toEqual({
      kind: "patch_sets",
      patchSetRefs: ["patch-1"],
    });
  });

  test("session_diff with no applied patch sets fails with an actionable error and commits nothing", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-session-diff-empty-1";

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "session_diff" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    expect(resultText(result).toLowerCase()).toContain("no applied patch");
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("files target with no applied patch sets snapshots file_digests over the target files", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-files-digest-1";
    const content = "export const x = 1;\n";
    const relativePath = "reviewed.ts";
    writeFileSync(join(runtime.identity.cwd, relativePath), content);
    const digest = createHash("sha256").update(content).digest("hex");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: [relativePath] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes[0]?.targetRef).toEqual({
      kind: "file_digests",
      digests: { [relativePath]: digest },
    });
  });

  // Finding P1-B: a files target must ALWAYS snapshot file_digests over its
  // named paths, even when the session has applied patch sets. The prior
  // behavior (returning patch_sets covering ALL applied sets) produced a
  // dishonest receipt claiming whole-change coverage for a review of one file.
  test("files target snapshots file_digests over its named paths even when the session has applied patch sets", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-files-with-patches-1";
    runtime.ops.tools.sourcePatch.plans.apply(sessionId, {
      ok: true,
      planId: "plan-1",
      patchSetId: "patch-9",
      appliedPaths: ["src/a.ts"],
      failedPaths: [],
    });
    const content = "export const x = 1;\n";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), content);
    const digest = createHash("sha256").update(content).digest("hex");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    // Honest ref: the receipt attests exactly the file the reviewer read, not
    // the whole change. patch_sets is reserved for session_diff targets.
    expect(outcomeEvents(runtime, sessionId)[0]?.targetRef).toEqual({
      kind: "file_digests",
      digests: { "reviewed.ts": digest },
    });
  });

  test("files target naming a missing file fails with an actionable error naming it", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-missing-file-1";

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["does-not-exist.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    expect(resultText(result)).toContain("does-not-exist.ts");
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("snapshots the targetRef BEFORE dispatch, even when patches apply mid-review", async () => {
    const runtime = createRuntimeFixture();
    const sessionId = "review-request-snapshot-before-dispatch-1";
    const content = "export const x = 1;\n";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), content);
    const digest = createHash("sha256").update(content).digest("hex");

    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          // A patch set becomes "applied" only after dispatch begins. If the
          // snapshot were taken after dispatch it would flip to patch_sets.
          duringRun: () => {
            runtime.ops.tools.sourcePatch.plans.apply(sessionId, {
              ok: true,
              planId: "plan-late",
              patchSetId: "patch-late",
              appliedPaths: ["reviewed.ts"],
              failedPaths: [],
            });
          },
        }),
      ),
    });

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    expect(outcomeEvents(runtime, sessionId)[0]?.targetRef).toEqual({
      kind: "file_digests",
      digests: { "reviewed.ts": digest },
    });
  });
});

describe("review_request tool — disposition to outcome mapping", () => {
  test("clear disposition records a pass independent outcome", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "clean",
            disposition: "clear",
          },
        }),
      ),
    });
    const sessionId = "review-request-clear-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("pass");
    expect(outcomes[0]?.perspective).toBe("independent");
    expect(outcomes[0]?.level).toBe("requirements");
  });

  test("concern disposition records a fail independent outcome", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "issue",
            disposition: "concern",
            findings: [{ summary: "off-by-one in loop bound", severity: "high" }],
          },
        }),
      ),
    });
    const sessionId = "review-request-concern-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    expect(outcomeEvents(runtime, sessionId)[0]?.outcome).toBe("fail");
  });

  test("blocked disposition records a fail independent outcome", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "cannot proceed",
            disposition: "blocked",
          },
        }),
      ),
    });
    const sessionId = "review-request-blocked-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    // Axiom 18: a blocked verdict is descriptive, not a tool error.
    expect(result.outcome.kind).toBe("ok");
    expect(outcomeEvents(runtime, sessionId)[0]?.outcome).toBe("fail");
  });

  test("inconclusive disposition records a skipped independent outcome with a reason", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "insufficient evidence",
            disposition: "inconclusive",
            missingEvidence: ["no failing test to reproduce with"],
          },
        }),
      ),
    });
    const sessionId = "review-request-inconclusive-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes[0]?.outcome).toBe("skipped");
    expect(typeof outcomes[0]?.reason).toBe("string");
    expect(outcomes[0]?.reason?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("review_request tool — independence basis composition", () => {
  test("open stance, same model: basis is fresh_context only", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-basis-open-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(outcomeEvents(runtime, sessionId)[0]?.independenceBasis).toEqual(["fresh_context"]);
  });

  test("preloaded lenses add preloaded_lens to the basis", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-basis-lens-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      {
        target: { kind: "files", paths: ["reviewed.ts"] },
        lenses: ["hunt for missing rollback safety"],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const basis = outcomeEvents(runtime, sessionId)[0]?.independenceBasis ?? [];
    expect(basis).toContain("fresh_context");
    expect(basis).toContain("preloaded_lens");
  });

  test("the reviewer's routed model does not add different_model (session model is not exposed)", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({ routedModel: "openai/gpt-5.5:medium" }),
      ),
    });
    const sessionId = "review-request-basis-model-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const outcomes = outcomeEvents(runtime, sessionId);
    // The calling session's own model is unreachable from the tools runtime, so
    // different_model is honestly omitted rather than guessed — but the routed
    // model IS still recorded on the reviewer context.
    expect(outcomes[0]?.independenceBasis).not.toContain("different_model");
    expect(outcomes[0]?.reviewerContext?.model).toBe("openai/gpt-5.5:medium");
  });

  test("lenses are recorded on the reviewer context and appended to (not replacing) the stance", async () => {
    const runtime = createRuntimeFixture();
    let dispatched: SubagentRunRequest | undefined;
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          onRun: (request) => {
            dispatched = request;
          },
        }),
      ),
    });
    const sessionId = "review-request-lens-context-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      {
        target: { kind: "files", paths: ["reviewed.ts"] },
        lenses: ["lens-alpha", "lens-beta"],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(outcomeEvents(runtime, sessionId)[0]?.reviewerContext?.lenses).toEqual([
      "lens-alpha",
      "lens-beta",
    ]);
    // The stance is still present in the objective; lenses are additive.
    expect(dispatched?.packet?.objective).toContain("lens-alpha");
    expect(dispatched?.packet?.objective.toLowerCase()).toContain("wrong");
  });
});

describe("review_request tool — finding receipts", () => {
  test("one review.finding.recorded per parsed finding, each carrying the snapshot targetRef", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "issues found",
            disposition: "concern",
            findings: [
              { summary: "unchecked null deref", severity: "critical" },
              { summary: "log line leaks a token", severity: "high" },
            ],
          },
        }),
      ),
    });
    const sessionId = "review-request-findings-1";
    const content = "export const x = 1;\n";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), content);
    const digest = createHash("sha256").update(content).digest("hex");

    await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const findings = findingEvents(runtime, sessionId);
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding?.targetRef).toEqual({
        kind: "file_digests",
        digests: { "reviewed.ts": digest },
      });
      expect(finding?.atomRefs).toEqual([]);
      expect(finding?.findingId.length ?? 0).toBeGreaterThan(0);
    }
    // Deterministic, distinct finding ids derived from the run id.
    const ids = findings.map((f) => f?.findingId);
    expect(new Set(ids).size).toBe(ids.length);
    // Statements are carried through verbatim.
    expect(findings.map((f) => f?.statement)).toEqual(
      expect.arrayContaining(["unchecked null deref", "log line leaks a token"]),
    );
  });

  test("open-stance findings carry lens=null", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "issue",
            disposition: "concern",
            findings: [{ summary: "resource leak", severity: "medium" }],
          },
        }),
      ),
    });
    const sessionId = "review-request-findings-open-lens-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(findingEvents(runtime, sessionId)[0]?.lens).toBeNull();
  });

  // Finding P3: an omitted or out-of-vocabulary category is recorded as
  // "unknown", never disguised as "correctness" (which mislabels
  // architecture/concurrency/etc. findings and pollutes category analytics). A
  // valid in-vocabulary category round-trips verbatim.
  test("a reviewer-declared category round-trips onto the receipt; an unrecognized/omitted one records as unknown", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "issues found",
            disposition: "concern",
            findings: [
              {
                summary: "sql injection via unescaped input",
                severity: "critical",
                category: "security",
              },
              {
                summary: "data race on the shared counter",
                severity: "high",
                category: "concurrency",
              },
              {
                summary: "reviewer typo'd the category",
                severity: "low",
                category: "not_a_real_category",
              },
              { summary: "no category declared at all", severity: "medium" },
            ],
          },
        }),
      ),
    });
    const sessionId = "review-request-findings-category-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const findings = findingEvents(runtime, sessionId);
    const bySummary = new Map(findings.map((finding) => [finding?.statement, finding?.category]));
    expect(bySummary.get("sql injection via unescaped input")).toBe("security");
    // A newly-recognized review-lane dimension round-trips (not collapsed).
    expect(bySummary.get("data race on the shared counter")).toBe("concurrency");
    // Out-of-vocab and omitted both land as unknown, never correctness.
    expect(bySummary.get("reviewer typo'd the category")).toBe("unknown");
    expect(bySummary.get("no category declared at all")).toBe("unknown");
  });
});

describe("review_request tool — zero-findings clear run", () => {
  test("a clean review commits the independent outcome and no finding receipts", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "clean",
            disposition: "clear",
          },
        }),
      ),
    });
    const sessionId = "review-request-zero-findings-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    // The clearing outcome must still be committed — this is what clears review debt.
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(1);
    expect(outcomeEvents(runtime, sessionId)[0]?.outcome).toBe("pass");
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });
});

describe("review_request tool — result text", () => {
  test("names disposition, finding counts by severity, targetRef kind, and receipts recorded", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "issues found",
            disposition: "concern",
            findings: [
              { summary: "critical bug", severity: "critical" },
              { summary: "minor nit", severity: "low" },
            ],
          },
        }),
      ),
    });
    const sessionId = "review-request-result-text-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const text = resultText(result);
    expect(text).toContain("fail");
    expect(text).toContain("2 findings");
    expect(text).toContain("critical");
    expect(text).toContain("file_digests");
    expect(text.toLowerCase()).toContain("receipts recorded");
  });
});

describe("review_request tool — fail-closed", () => {
  test("errors when orchestration is unavailable and commits nothing", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "review-request-no-orchestration-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });
});

describe("review_request tool — receipt honesty (Task 4 review fixes)", () => {
  test("a caller-overridden stance is NOT labeled open_adversarial_stance in the outcome checks", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "clean under custom stance",
            disposition: "clear",
          },
        }),
      ),
    });
    const sessionId = "review-request-custom-stance-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      {
        target: { kind: "files", paths: ["reviewed.ts"] },
        stance: "You are a narrow reviewer. Only check for SQL injection.",
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const checks = outcomeEvents(runtime, sessionId)[0]?.checks ?? [];
    // The receipt must not claim the open adversarial stance it did not run.
    expect(checks).not.toContain("open_adversarial_stance");
    expect(checks).toContain("custom_stance");
  });

  test("the default open stance still labels the outcome checks open_adversarial_stance", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-default-stance-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(outcomeEvents(runtime, sessionId)[0]?.checks).toEqual(["open_adversarial_stance"]);
  });

  test("a files target with no paths fails with an actionable error and commits nothing", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-empty-paths-1";

    // The schema enforces minItems:1, but readReviewParams is a defensive layer:
    // an empty files target must fail closed with an actionable error, never
    // snapshot a vacuous empty-digests ref.
    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: [] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    expect(resultText(result).length).toBeGreaterThan(0);
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("when the outcome cannot be recorded, NO finding receipts are left behind (outcome-first ordering)", async () => {
    // verify() returns undefined (capability refuses) while findings.record works.
    // Outcome-first ordering means the tool bails before committing any finding,
    // so the tape never holds findings without their independent outcome.
    const runtime = createRuntimeFixture({
      ops: {
        verification: {
          checks: {
            verify: () => undefined as never,
          },
        },
      },
    });
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "issues",
            disposition: "concern",
            findings: [
              { summary: "finding A", severity: "high" },
              { summary: "finding B", severity: "medium" },
            ],
          },
        }),
      ),
    });
    const sessionId = "review-request-outcome-first-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
    // The partial-commit hole is closed: no findings without an outcome.
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("a reviewer outcome that is not ok is treated as blocked and fabricates no findings", async () => {
    const runId = "review-run-notok-1";
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, {
        orchestration: {
          subagents: {
            // Self-defending path: a success-shaped result whose single outcome
            // is not ok (contract says it should not happen, but the tool must
            // not trust the shape). It must NOT parse findings off a failed run.
            run: async (): Promise<SubagentRunResult> =>
              ({
                ok: true,
                mode: "single",
                delegate: "explorer",
                outcomes: [
                  {
                    ok: false,
                    runId,
                    agent: "explorer",
                    delegate: "explorer",
                    status: "error",
                    error: "reviewer crashed",
                    metrics: { durationMs: 1 },
                    // A hostile/garbage data blob that, if wrongly parsed, would
                    // yield findings — proving the ok gate runs before coercion.
                    data: {
                      kind: "consult",
                      consultKind: "review",
                      conclusion: "should be ignored",
                      disposition: "clear",
                      findings: [{ summary: "phantom finding", severity: "critical" }],
                    },
                  },
                ],
              }) as never,
          },
        },
      }),
    });
    const sessionId = "review-request-notok-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes).toHaveLength(1);
    // blocked disposition -> fail outcome.
    expect(outcomes[0]?.outcome).toBe("fail");
    // No fabricated findings from a run that never produced a trustworthy verdict.
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });
});

describe("review_request tool — waitMode start (parallel review)", () => {
  function stubStartOrchestration(options: {
    readonly runId: string;
    readonly onStart?: (request: SubagentRunRequest) => void;
  }): Pick<
    NonNullable<Parameters<typeof createBundledToolRuntime>[1]>,
    "orchestration" | "delegation"
  > {
    return {
      orchestration: {
        subagents: {
          run: async () => {
            throw new Error("start mode must never call run()");
          },
          start: async (input: { fromSessionId: string; request: SubagentRunRequest }) => {
            options.onStart?.(input.request);
            return {
              ok: true as const,
              mode: "single" as const,
              delegate: input.request.agent,
              runs: [
                { runId: options.runId, status: "running" },
              ] as unknown as DelegationRunRecord[],
            };
          },
        },
      },
      delegation: {},
    };
  }

  test("returns immediately with the runId and a receipts-on-completion note; commits nothing", async () => {
    const runtime = createRuntimeFixture();
    let dispatched: SubagentRunRequest | undefined;
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubStartOrchestration({
          runId: "review-run-start-1",
          onStart: (request) => {
            dispatched = request;
          },
        }),
      ),
    });
    const sessionId = "review-request-start-1";
    const content = "export const x = 1;\n";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), content);
    const digest = createHash("sha256").update(content).digest("hex");

    const result = await tool.execute(
      "tc-1",
      {
        target: { kind: "files", paths: ["reviewed.ts"] },
        lenses: ["lens-alpha"],
        waitMode: "start",
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const text = resultText(result);
    expect(text).toContain("review-run-start-1");
    expect(text.toLowerCase()).toContain("receipts");
    // The author is never blocked: no receipts commit at dispatch time — they
    // commit when the run completes (observer path).
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
    // The run is tagged as a review dispatch carrying the pre-dispatch
    // snapshot, so the completion observer can commit anchored receipts later.
    expect(dispatched?.reviewDispatch).toEqual({
      targetRef: { kind: "file_digests", digests: { "reviewed.ts": digest } },
      lenses: ["lens-alpha"],
      stanceOverridden: false,
      // A files target carries no reviewed atom ids onto the anchor — so the
      // observer's start-mode commit will attest to no atom (clear atomRefs []).
      reviewedAtomIds: [],
    });
  });

  test("errors when the orchestration adapter does not support start, committing nothing", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-start-unavailable-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] }, waitMode: "start" },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("completion mode also tags the dispatched request with the review anchor", async () => {
    const runtime = createRuntimeFixture();
    let dispatched: SubagentRunRequest | undefined;
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          onRun: (request) => {
            dispatched = request;
          },
        }),
      ),
    });
    const sessionId = "review-request-completion-tag-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      {
        target: { kind: "files", paths: ["reviewed.ts"] },
        stance: "custom narrow stance",
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    // Both modes tag the run: the record carries the dispatch anchor either
    // way, and the tape-derived idempotency guard keeps receipts exactly-once.
    expect(dispatched?.reviewDispatch?.targetRef.kind).toBe("file_digests");
    expect(dispatched?.reviewDispatch?.stanceOverridden).toBe(true);
  });

  test("completion mode commits a skipped outcome with the failure reason when the run fails", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, {
        orchestration: {
          subagents: {
            run: async (): Promise<SubagentRunResult> => ({
              ok: false,
              mode: "single",
              delegate: "explorer",
              outcomes: [
                {
                  ok: false,
                  runId: "review-run-failed-1",
                  agent: "explorer",
                  delegate: "explorer",
                  status: "error",
                  error: "reviewer session crashed",
                  metrics: { durationMs: 1 },
                },
              ],
              error: "reviewer session crashed",
            }),
          },
        },
        delegation: {},
      }),
    });
    const sessionId = "review-request-failed-run-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    // The tool call still reports the execution failure...
    expect(result.outcome.kind).toBe("err");
    // ...but the attempt is honestly recorded: one independent skipped outcome
    // with the failure reason (axiom 7), and never a fabricated finding.
    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("skipped");
    expect(outcomes[0]?.reason).toContain("reviewer session crashed");
    expect(outcomes[0]?.reviewerContext?.contextId).toBe("review-run-failed-1");
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });
});

// The atoms target (Task 14): review the session's requirement atoms — all
// folded atoms, or a caller-listed subset — against the session's touched
// files. The packet objective must enumerate each atom's statement so the
// reviewer knows exactly what to verify was actually realized, never just a
// generic "review this diff" framing.
const ATOM_MUST: RequirementAtom = {
  id: "req-1",
  statement: "Fn suppression must be keycode-scoped",
  modality: "must",
  provenance: "prompt",
};
const ATOM_SHOULD: RequirementAtom = {
  id: "req-2",
  statement: "the callback should release ownership on teardown",
  modality: "should",
  provenance: "prompt",
};

function seedAtoms(
  runtime: ReturnType<typeof createRuntimeFixture>,
  sessionId: string,
  atoms: readonly RequirementAtom[],
): void {
  runtime.ops.task.requirements.record(sessionId, atoms);
}

function applyPatch(
  runtime: ReturnType<typeof createRuntimeFixture>,
  sessionId: string,
  patchSetId: string,
  appliedPaths: readonly string[],
): void {
  runtime.ops.tools.sourcePatch.plans.apply(sessionId, {
    ok: true,
    planId: `plan-${patchSetId}`,
    patchSetId,
    appliedPaths: [...appliedPaths],
    failedPaths: [],
  });
}

/** Seed a bare write/edit commitment (no patch set) so the session has a
 *  fresh-touched file without any applied patch — the P2 fallback case. Seeds
 *  the `tool.committed` boundary the touched-file projection reads (not the
 *  runtime-ops annotation the hosted path never emits). */
function seedBareWrite(
  runtime: ReturnType<typeof createRuntimeFixture>,
  sessionId: string,
  filePath: string,
): void {
  seedCommittedToolEvents(runtime, [
    committedToolEvent({
      sessionId,
      toolName: "edit",
      args: { file_path: filePath },
      timestamp: 1,
    }),
  ]);
}

describe("review_request tool — atoms target (Task 14)", () => {
  test("no atoms recorded at all -> actionable error, no dispatch, no receipts", async () => {
    const runtime = createRuntimeFixture();
    let runCount = 0;
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          onRun: () => {
            runCount += 1;
          },
        }),
      ),
    });
    const sessionId = "review-request-atoms-none-1";
    applyPatch(runtime, sessionId, "patch-1", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    expect(resultText(result).toLowerCase()).toContain("atom");
    expect(runCount).toBe(0);
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("atomIds naming only nonexistent ids -> actionable error (nothing resolved to review)", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-atoms-missing-ids-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST]);
    applyPatch(runtime, sessionId, "patch-1", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "atoms", atomIds: ["does-not-exist"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("atoms exist but the session has NEITHER applied patch sets NOR fresh-touched files -> actionable error (nothing to review against)", async () => {
    // Finding P2: an atoms target now falls back to file_digests over the
    // fresh-touched files when there are no applied patch sets. Only when there
    // is ALSO nothing touched (no patches AND no bare writes) does it fail
    // closed — there is genuinely nothing to review against.
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-atoms-no-target-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST]);

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    expect(resultText(result).toLowerCase()).toContain("nothing to review");
    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("Finding P2: atoms target with ONLY bare writes (no patches) snapshots file_digests over the touched files, still enumerating the atoms", async () => {
    const runtime = createRuntimeFixture();
    let dispatched: SubagentRunRequest | undefined;
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          onRun: (request) => {
            dispatched = request;
          },
        }),
      ),
    });
    const sessionId = "review-request-atoms-bare-write-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST, ATOM_SHOULD]);
    // A session that finished via a bare edit — NO applied patch sets at all.
    writeFileSync(join(runtime.identity.cwd, "edited.ts"), "export const y = 2;\n");
    seedBareWrite(runtime, sessionId, "edited.ts");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    // Snapshot fell back to file_digests over the bare-write touched file.
    const targetRef = outcomeEvents(runtime, sessionId)[0]?.targetRef;
    expect(targetRef?.kind).toBe("file_digests");
    expect(targetRef).toMatchObject({ kind: "file_digests" });
    if (targetRef?.kind === "file_digests") {
      expect(Object.keys(targetRef.digests)).toContain("edited.ts");
    }
    // The objective still enumerates the atoms (only the snapshot changed).
    expect(dispatched?.packet?.objective).toContain(ATOM_MUST.statement);
    expect(dispatched?.packet?.objective).toContain(ATOM_SHOULD.statement);
    expect(dispatched?.packet?.objective).toContain(ATOM_MUST.id);
    expect(dispatched?.packet?.objective.toLowerCase()).toContain("realiz");
  });

  test("Finding P2: atoms target WITH applied patches still snapshots patch_sets (unchanged)", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-atoms-with-patches-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST]);
    applyPatch(runtime, sessionId, "patch-7", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    // Applied patch sets exist -> patch_sets ref, exactly as before P2.
    expect(outcomeEvents(runtime, sessionId)[0]?.targetRef).toEqual({
      kind: "patch_sets",
      patchSetRefs: ["patch-7"],
    });
  });

  test("all atoms: the packet objective enumerates every atom's statement", async () => {
    const runtime = createRuntimeFixture();
    let dispatched: SubagentRunRequest | undefined;
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          onRun: (request) => {
            dispatched = request;
          },
        }),
      ),
    });
    const sessionId = "review-request-atoms-all-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST, ATOM_SHOULD]);
    applyPatch(runtime, sessionId, "patch-1", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    expect(dispatched?.packet?.objective).toContain(ATOM_MUST.statement);
    expect(dispatched?.packet?.objective).toContain(ATOM_SHOULD.statement);
    expect(dispatched?.packet?.objective).toContain(ATOM_MUST.id);
    expect(dispatched?.packet?.objective).toContain(ATOM_SHOULD.id);
    // The reviewer is asked to verify realization, not just spot bugs.
    expect(dispatched?.packet?.objective.toLowerCase()).toContain("realiz");
  });

  test("atomIds narrows the objective to only the listed atoms", async () => {
    const runtime = createRuntimeFixture();
    let dispatched: SubagentRunRequest | undefined;
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          onRun: (request) => {
            dispatched = request;
          },
        }),
      ),
    });
    const sessionId = "review-request-atoms-subset-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST, ATOM_SHOULD]);
    applyPatch(runtime, sessionId, "patch-1", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "atoms", atomIds: [ATOM_MUST.id] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(dispatched?.packet?.objective).toContain(ATOM_MUST.statement);
    expect(dispatched?.packet?.objective).not.toContain(ATOM_SHOULD.statement);
  });

  test("the targetRef snapshots the session's touched files exactly as session_diff does (patch_sets)", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(runtime, stubReviewOrchestration({})),
    });
    const sessionId = "review-request-atoms-snapshot-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST]);
    applyPatch(runtime, sessionId, "patch-9", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    expect(outcomeEvents(runtime, sessionId)[0]?.targetRef).toEqual({
      kind: "patch_sets",
      patchSetRefs: ["patch-9"],
    });
  });

  test("a reviewer-reported atomRef lands on the committed finding receipt", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "the atom is not realized",
            disposition: "concern",
            findings: [
              {
                summary: "suppression fires on every flagsChanged event, not just the Fn keycode",
                severity: "high",
                atomRefs: [ATOM_MUST.id],
              },
            ],
          },
        }),
      ),
    });
    const sessionId = "review-request-atoms-finding-refs-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST]);
    applyPatch(runtime, sessionId, "patch-1", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const findings = findingEvents(runtime, sessionId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.atomRefs).toEqual([ATOM_MUST.id]);
  });

  test("a finding with no atomRefs reported still commits with an empty atomRefs list (never invented)", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "unrelated issue",
            disposition: "concern",
            findings: [{ summary: "unrelated style nit", severity: "low" }],
          },
        }),
      ),
    });
    const sessionId = "review-request-atoms-finding-no-refs-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST]);
    applyPatch(runtime, sessionId, "patch-1", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(findingEvents(runtime, sessionId)[0]?.atomRefs).toEqual([]);
  });

  test("a files/session_diff target's findings still carry empty atomRefs (no regression from the atoms-target wiring)", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "issue",
            disposition: "concern",
            findings: [{ summary: "resource leak", severity: "medium" }],
          },
        }),
      ),
    });
    const sessionId = "review-request-non-atoms-empty-refs-1";
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(findingEvents(runtime, sessionId)[0]?.atomRefs).toEqual([]);
  });
});

describe("review_request tool — independent outcome atomRefs (clear-only positive signal, the fitness loop)", () => {
  test("a CLEAR atoms-target review of a must atom → independent outcome carries atomRefs:[atomId], outcome pass", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "the atom is realized",
            disposition: "clear",
          },
        }),
      ),
    });
    const sessionId = "review-request-atoms-clear-satisfies-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST]);
    applyPatch(runtime, sessionId, "patch-1", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const outcome = outcomeEvents(runtime, sessionId)[0];
    expect(outcome?.outcome).toBe("pass");
    // The affirmatively-verified signal: a clear atoms-review names the atoms it
    // attests to, so the fitness projection can reach `satisfied`.
    expect(outcome?.atomRefs).toEqual([ATOM_MUST.id]);
  });

  test("atomIds narrows the outcome atomRefs to exactly the reviewed subset", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "realized",
            disposition: "clear",
          },
        }),
      ),
    });
    const sessionId = "review-request-atoms-clear-subset-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST, ATOM_SHOULD]);
    applyPatch(runtime, sessionId, "patch-1", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "atoms", atomIds: [ATOM_MUST.id] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(outcomeEvents(runtime, sessionId)[0]?.atomRefs).toEqual([ATOM_MUST.id]);
  });

  test("a CONCERN atoms-target review → outcome atomRefs is EMPTY (findings own violations; a target atom with no finding is never blanket-violated)", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "one atom is not realized",
            disposition: "concern",
            // A finding naming ONLY ATOM_MUST; ATOM_SHOULD is a target atom with
            // no specific finding. Blanket-populating atomRefs on this fail
            // outcome would wrongly violate ATOM_SHOULD.
            findings: [
              {
                summary: "suppression fires on every flagsChanged event",
                severity: "high",
                atomRefs: [ATOM_MUST.id],
              },
            ],
          },
        }),
      ),
    });
    const sessionId = "review-request-atoms-concern-no-blanket-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST, ATOM_SHOULD]);
    applyPatch(runtime, sessionId, "patch-1", ["reviewed.ts"]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "atoms" } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const outcome = outcomeEvents(runtime, sessionId)[0];
    expect(outcome?.outcome).toBe("fail");
    // CRITICAL: a fail outcome NEVER carries atomRefs. The finding carries the
    // violation for ATOM_MUST; ATOM_SHOULD stays unviolated.
    expect(outcome?.atomRefs).toEqual([]);
  });

  test("a CLEAR files-target review → outcome atomRefs is EMPTY (no atom is affirmatively verified)", async () => {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "clean",
            disposition: "clear",
          },
        }),
      ),
    });
    const sessionId = "review-request-files-clear-no-atoms-1";
    seedAtoms(runtime, sessionId, [ATOM_MUST]);
    writeFileSync(join(runtime.identity.cwd, "reviewed.ts"), "export const x = 1;\n");

    await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["reviewed.ts"] } },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const outcome = outcomeEvents(runtime, sessionId)[0];
    expect(outcome?.outcome).toBe("pass");
    // A files review clears review debt but attests to no specific atom.
    expect(outcome?.atomRefs).toEqual([]);
  });
});

describe("review_request tool — review→atom fold (coverage-scoped attribution)", () => {
  const highRiskAtomEvent = (id: string, timestamp: number) => ({
    type: "task.requirement.recorded",
    timestamp,
    payload: {
      atom: {
        id,
        statement: `${id} must hold`,
        modality: "must",
        provenance: "trap",
        riskClass: "runtime",
      },
    },
  });

  test("a covering files review folds outstanding high-risk debt into reviewedAtomIds + the objective", async () => {
    const runtime = createRuntimeFixture();
    let dispatched: SubagentRunRequest | undefined;
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({ onRun: (request) => (dispatched = request) }),
      ),
    });
    const sessionId = "review-request-fold-covering-1";
    const content = "final class FnKeyMonitor {}\n";
    writeFileSync(join(runtime.identity.cwd, "FnKeyMonitor.swift"), content);
    // A tool.committed write puts the file in the FRESH universe; a high-risk atom
    // is recorded but unverified (independence debt). The files review lists exactly
    // the touched file, so it COVERS the universe.
    seedCommittedToolEvents(runtime, [
      committedToolEvent({
        toolName: "write",
        args: { path: join(runtime.identity.cwd, "FnKeyMonitor.swift") },
        timestamp: 1,
      }),
      highRiskAtomEvent("req-tap", 2),
    ]);

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["FnKeyMonitor.swift"] }, lenses: [] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    // The debt atom rides the dispatch anchor (so a FAIL can name it) and the
    // objective carries the attestation ask.
    expect(dispatched?.reviewDispatch?.reviewedAtomIds).toEqual(["req-tap"]);
    const objective = (dispatched?.packet as { objective?: string } | undefined)?.objective ?? "";
    expect(objective).toContain("Additionally, confirm the implementation REALIZES");
    expect(objective).toContain("[req-tap]");
  });

  test("a review with debt but NO fresh-written file folds nothing — empty universe is never attested", async () => {
    const runtime = createRuntimeFixture();
    let dispatched: SubagentRunRequest | undefined;
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({ onRun: (request) => (dispatched = request) }),
      ),
    });
    const sessionId = "review-request-fold-empty-1";
    const content = "final class Prior {}\n";
    writeFileSync(join(runtime.identity.cwd, "Prior.swift"), content);
    // A high-risk debt atom is recorded, but NO tool.committed write happened this
    // turn -> the fresh-touched universe is empty. The review of a pre-existing file
    // must NOT fold atoms whose realizing code it was not asked to attest (M1).
    seedCommittedToolEvents(runtime, [highRiskAtomEvent("req-tap", 1)]);

    const result = await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["Prior.swift"] }, lenses: [] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    expect(dispatched?.reviewDispatch?.reviewedAtomIds).toEqual([]);
    const objective = (dispatched?.packet as { objective?: string } | undefined)?.objective ?? "";
    expect(objective).not.toContain("Additionally");
  });
});

describe("review_request tool — review→atom fold liveness (fitness edges)", () => {
  const highRiskAtomEvent = {
    type: "task.requirement.recorded",
    timestamp: 2,
    payload: {
      atom: {
        id: "req-tap",
        statement: "event tap must re-arm on disable",
        modality: "must",
        provenance: "trap",
        riskClass: "runtime",
      },
    },
  };

  function independenceDebt(
    runtime: HostedRuntimeAdapterPort,
    sessionId: string,
  ): readonly string[] {
    const events = runtime.ops.events.records.query(sessionId) as unknown as BrewvaEventRecord[];
    return buildTapeRequirementFitness(events).independenceDebtAtoms;
  }

  async function runCoveringReview(
    disposition: string,
    findings: readonly Record<string, unknown>[],
  ): Promise<readonly string[]> {
    const runtime = createRuntimeFixture();
    const tool = createReviewRequestTool({
      runtime: createBundledToolRuntime(
        runtime,
        stubReviewOrchestration({
          data: {
            kind: "consult",
            consultKind: "review",
            conclusion: "review complete",
            disposition,
            ...(findings.length > 0 ? { findings } : {}),
          },
        }),
      ),
    });
    const sessionId = `review-request-fold-liveness-${disposition}`;
    writeFileSync(
      join(runtime.identity.cwd, "FnKeyMonitor.swift"),
      "final class FnKeyMonitor {}\n",
    );
    seedCommittedToolEvents(runtime, [
      committedToolEvent({
        toolName: "write",
        args: { path: join(runtime.identity.cwd, "FnKeyMonitor.swift") },
        timestamp: 1,
      }),
      highRiskAtomEvent,
    ]);
    // Baseline: the high-risk `must` atom is unmet -> it carries independence debt.
    expect(independenceDebt(runtime, sessionId)).toEqual(["req-tap"]);
    await tool.execute(
      "tc-1",
      { target: { kind: "files", paths: ["FnKeyMonitor.swift"] }, lenses: [] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    return independenceDebt(runtime, sessionId);
  }

  test("a FAIL naming the folded debt atom marks it violated → open drops (the whole point)", async () => {
    const debt = await runCoveringReview("concern", [
      {
        summary: "event tap is not re-armed after tapDisabledByUserInput",
        severity: "high",
        atomRefs: ["req-tap"],
      },
    ]);
    // The finding named req-tap -> `violated` -> it leaves the debt set. open 1 -> 0.
    expect(debt).toEqual([]);
  });
});
