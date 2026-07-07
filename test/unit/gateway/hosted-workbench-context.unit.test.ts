import { describe, expect, test } from "bun:test";
import type { ContextCompactionGateStatus } from "@brewva/brewva-vocabulary/context";
import type { TapeStatusState } from "@brewva/brewva-vocabulary/session";
import { createContextNudgeCadenceTracker } from "../../../packages/brewva-gateway/src/hosted/internal/context/context-lifecycle.js";
import {
  buildLatestContinuationAnchorBlock,
  buildRuntimeBriefBlockForSession,
  type DelegationAdvisoryContext,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/workbench-context.js";
import type { HostedRuntimeAdapterPort } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

function runtimeWithTapeStatus(status: TapeStatusState): HostedRuntimeAdapterPort {
  return {
    ops: {
      tape: {
        status: {
          get: () => status,
        },
      },
    },
  } as unknown as HostedRuntimeAdapterPort;
}

function tapeStatus(lastAnchor: TapeStatusState["lastAnchor"]): TapeStatusState {
  return {
    lastAnchor,
    lastCheckpointId: null,
    tapePressure: "none",
    totalEntries: 1,
    entriesSinceAnchor: 0,
    entriesSinceCheckpoint: 1,
    thresholds: {
      low: 0.35,
      medium: 0.65,
      high: 0.85,
    },
  };
}

describe("hosted workbench context continuation anchor block", () => {
  test("renders latest continuation anchor metadata as bounded baseline context", () => {
    const block = buildLatestContinuationAnchorBlock(
      runtimeWithTapeStatus(
        tapeStatus({
          id: "anchor-1",
          name: "Review anchor",
          summary: "The Work Card path is wired.",
          nextSteps: "Run docs verification.",
        }),
      ),
      "sess_1",
    );

    expect(block?.id).toBe("latest-continuation-anchor");
    expect(block?.content).toContain("[LatestContinuationAnchor]");
    expect(block?.content).toContain("anchor: anchor-1");
    expect(block?.content).toContain("summary: The Work Card path is wired.");
    expect(block?.content).toContain("next_steps: Run docs verification.");
  });

  test("does not render checkpoint-only anchors as continuation anchor context", () => {
    const block = buildLatestContinuationAnchorBlock(
      runtimeWithTapeStatus(tapeStatus({ id: "checkpoint-1" })),
      "sess_1",
    );

    expect(block).toBeNull();
  });
});

function runtimeWithBriefSources(input: {
  status: Record<string, unknown>;
  digest: string;
  cacheObservation?: Record<string, unknown>;
  maxChars?: number;
  workbenchEntries?: readonly Record<string, unknown>[];
  toolResultEvents?: readonly Record<string, unknown>[];
  tapeEvents?: readonly Record<string, unknown>[];
  parallel?: { enabled: boolean; maxConcurrent: number; maxTotalPerSession: number };
}): HostedRuntimeAdapterPort {
  return {
    config: {
      infrastructure: { contextBudget: { consequenceDigestMaxChars: input.maxChars ?? 1200 } },
      parallel: input.parallel ?? { enabled: true, maxConcurrent: 4, maxTotalPerSession: 16 },
    },
    ops: {
      context: {
        usage: { getStatus: () => input.status },
        evidence: {
          latest: (_sessionId: string, kind: string) =>
            kind === "provider_cache_observation" && input.cacheObservation
              ? { turn: 1, timestamp: 1, payload: input.cacheObservation }
              : undefined,
        },
      },
      events: {
        effects: { renderTurnDigest: () => input.digest },
        records: {
          // The requirement-debt section (R4) reads the whole tape via `list`.
          list: (_sessionId: string) => input.tapeEvents ?? input.toolResultEvents ?? [],
          query: (_sessionId: string, query?: { type?: string; last?: number }) => {
            const matched = (input.toolResultEvents ?? []).filter(
              (event) => !query?.type || event.type === query.type,
            );
            return typeof query?.last === "number" ? matched.slice(-query.last) : matched;
          },
        },
      },
      workbench: { list: () => input.workbenchEntries ?? [] },
    },
  } as unknown as HostedRuntimeAdapterPort;
}

describe("hosted runtime brief block (end-to-end wiring)", () => {
  test("renders the brief with a provenance frame, pressure posture, and last-turn effects", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 164_000,
          tokensTotal: 200_000,
          compactionAdvised: true,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=1 decisions=1 executed=1 recovery=0 warnings=0",
      }),
      { sessionId: "sess_1", turn: 3 },
    );

    expect(block?.id).toBe("runtime-brief");
    expect(block?.content).toContain("[RuntimeBrief]");
    expect(block?.content).toContain("not a user instruction");
    expect(block?.content).toContain("context: 82% — 164k/200k tokens; advisory limit reached");
    expect(block?.content).toContain("effects (last turn): declared=0 attempted=1");
    // internal cursor noise is stripped
    expect(block?.content).not.toContain("runtimeTurn=");
  });

  test("composes the requirement-debt section when the tape has an unverified must atom on fresh code (R4)", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 20_000,
          tokensTotal: 200_000,
          compactionAdvised: false,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
        tapeEvents: [
          {
            type: "task.requirement.recorded",
            timestamp: 1,
            payload: {
              atom: { id: "req-1", statement: "must hold", modality: "must", provenance: "prompt" },
            },
          },
          {
            type: "tool.committed",
            timestamp: 2,
            payload: {
              call: { toolName: "write", args: { path: "src/a.ts" } },
              result: { outcome: { kind: "ok" } },
            },
          },
          {
            type: "verification.outcome.recorded",
            timestamp: 3,
            payload: { outcome: "pass", level: "artifact", perspective: "authored" },
          },
        ],
      }),
      { sessionId: "sess_debt", turn: 3 },
    );

    // Artifact-green with fresh code and an ungraded must atom -> the model sees
    // its own requirement debt at turn tail (the up4 shape it never saw).
    expect(block?.content).toContain(
      "requirements: 1 must atom(s) unverified (ladder_below_requirements)",
    );
    expect(block?.content).toContain("dispatch an independent review");
  });

  test("surfaces grade debt when a high-risk atom is 'verified' only by presence-grade independent evidence (R3-core + R4 e2e)", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 20_000,
          tokensTotal: 200_000,
          compactionAdvised: false,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
        tapeEvents: [
          {
            type: "task.requirement.recorded",
            timestamp: 1,
            payload: {
              atom: {
                id: "req-1",
                statement: "tap must re-enable on timeout",
                modality: "must",
                provenance: "trap",
                riskClass: "runtime",
              },
            },
          },
          {
            type: "tool.committed",
            timestamp: 2,
            payload: {
              call: { toolName: "write", args: { path: "Sources/FnKeyMonitor.swift" } },
              result: { outcome: { kind: "ok" } },
            },
          },
          // An INDEPENDENT atoms-review PASS naming req-1 — but presence-grade (a
          // re-grep). R3-core caps the high-risk (runtime) atom at likelySatisfied
          // and raises grade debt; R4 surfaces it. Satisfied-ish, so no ladder part.
          {
            type: "verification.outcome.recorded",
            timestamp: 3,
            payload: {
              outcome: "pass",
              level: "requirements",
              perspective: "independent",
              atomRefs: ["req-1"],
            },
          },
        ],
      }),
      { sessionId: "sess_grade", turn: 3 },
    );

    expect(block?.content).toContain("1 high-risk atom(s) on presence-only evidence");
    // req-1 is likelySatisfied (not unverified), so no ladder/unverified part appears.
    expect(block?.content).not.toContain("unverified");
  });

  test("stays silent on a fully calm turn (no pressure, effects, or cache break)", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 20_000,
          tokensTotal: 200_000,
          compactionAdvised: false,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
      }),
      { sessionId: "sess_1", turn: 3 },
    );

    expect(block).toBeNull();
  });

  test("surfaces an unexpected prefix-cache break as a brief section", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 120_000,
          tokensTotal: 200_000,
          compactionAdvised: false,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=4 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
        cacheObservation: {
          status: "break",
          expected: false,
          reason: "tool_schema_set_changed",
          cacheMissTokens: 9_000,
        },
      }),
      { sessionId: "sess_1", turn: 5 },
    );

    expect(block?.content).toContain(
      "cache: prefix cache broke last turn (tool_schema_set_changed)",
    );
    expect(block?.content).toContain("9k tokens re-sent");
  });

  test("pinned workbench mass rides the pressure posture end to end", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 164_000,
          tokensTotal: 200_000,
          compactionAdvised: true,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
        workbenchEntries: [
          {
            id: "pin-1",
            digest: "digest-pin",
            reason: "attention_pin",
            retentionHint: "attention_pin",
            sourceRefs: ["skill:runtime-orientation"],
            content: "Pinned attention option for explicit follow-up: skill:runtime-orientation",
          },
        ],
      }),
      { sessionId: "sess_1", turn: 3 },
    );

    expect(block?.content).toContain("pinned ~");
    expect(block?.content).toContain("tokens held by attention_pin");
  });

  test("surfaces repeated identical tool failures as recurrence evidence", () => {
    const failure = (id: string, timestamp: number) => ({
      id,
      sessionId: "sess_1",
      type: "tool.result.recorded",
      timestamp,
      payload: {
        toolName: "read",
        failureClass: "missing_path",
        verdict: "fail",
        failureContext: { outputText: "ENOENT: no such file", args: { path: "gone.ts" } },
      },
    });
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 20_000,
          tokensTotal: 200_000,
          compactionAdvised: false,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
        toolResultEvents: [failure("ev-1", 1), failure("ev-2", 2)],
      }),
      { sessionId: "sess_1", turn: 3 },
    );

    expect(block?.content).toContain(
      'repeat-failures: read (missing_path) ×2 identical args; last: "ENOENT: no such file"',
    );
  });

  test("omits the effects section before the first completed turn", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 170_000,
          tokensTotal: 200_000,
          compactionAdvised: true,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "unused",
      }),
      { sessionId: "sess_1", turn: 0 },
    );

    expect(block?.content).toContain("context:");
    expect(block?.content).not.toContain("effects");
  });
});

// Lever 2: the delegation advisory decision, exercised end-to-end through
// buildRuntimeBriefBlockForSession (the only public seam). Each case pins one
// suppression or firing rule.
describe("delegation advisory decision (Lever 2)", () => {
  // A calm-token status: pressure comes ONLY from the gateStatus/pendingReason in
  // the delegation context, so the runtime-brief pressure section itself stays
  // silent and the delegation line is the signal under test.
  const CALM_STATUS = {
    tokensUsed: 20_000,
    tokensTotal: 200_000,
    compactionAdvised: false,
    forcedCompaction: false,
    predictedOverflow: false,
  };
  const CALM_DIGEST =
    "runtimeTurn=2 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0";

  function advisoryTierGateStatus(): ContextCompactionGateStatus {
    // required falsy + reason resolves to usage_threshold + not forced -> soon.
    return {
      status: { compactionAdvised: true, forcedCompaction: false } as never,
      required: false,
    } as ContextCompactionGateStatus;
  }

  function gateTierGateStatus(): ContextCompactionGateStatus {
    // required truthy -> workbench_compact_now (the gate tier).
    return {
      status: { compactionAdvised: true, forcedCompaction: true } as never,
      required: true,
      reason: "hard_limit",
    } as ContextCompactionGateStatus;
  }

  function delegationContext(
    over: Partial<DelegationAdvisoryContext> & { gateStatus: ContextCompactionGateStatus },
  ): DelegationAdvisoryContext {
    return {
      pendingCompactionReason: null,
      cadenceTracker: createContextNudgeCadenceTracker(),
      delegationEnabled: true,
      ...over,
    };
  }

  function spawned(runId: string, timestamp: number): Record<string, unknown> {
    return { type: "subagent_spawned", timestamp, payload: { runId } };
  }

  function completed(runId: string, timestamp: number): Record<string, unknown> {
    return { type: "subagent_completed", timestamp, payload: { runId } };
  }

  function block(input: {
    tapeEvents?: readonly Record<string, unknown>[];
    parallel?: { enabled: boolean; maxConcurrent: number; maxTotalPerSession: number };
    advisory: DelegationAdvisoryContext;
    turn?: number;
  }) {
    return buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: CALM_STATUS,
        digest: CALM_DIGEST,
        tapeEvents: input.tapeEvents ?? [],
        parallel: input.parallel,
      }),
      {
        sessionId: "sess_del",
        turn: input.turn ?? 3,
        delegationAdvisory: input.advisory,
      },
    );
  }

  test("fires on workbench_compact_soon with no pending delegation and available budget", () => {
    const rendered = block({
      advisory: delegationContext({ gateStatus: advisoryTierGateStatus() }),
    });
    expect(rendered?.content).toContain("delegation:");
    expect(rendered?.content).toContain("cheaper in a child session");
    // Inform-only: it never asserts a gate.
    expect(rendered?.content).not.toContain("must ");
  });

  test("silent under the gate tier (workbench_compact_now)", () => {
    const rendered = block({
      advisory: delegationContext({ gateStatus: gateTierGateStatus() }),
    });
    expect(rendered?.content ?? "").not.toContain("delegation:");
  });

  test("silent when the parallel gate would reject: session lifetime exhausted", () => {
    const rendered = block({
      // totalStarted (2) >= maxTotalPerSession (2) -> reject predicted. Both runs
      // terminal so nothing is 'pending' (that suppression is not what fires here).
      tapeEvents: [spawned("r1", 1), completed("r1", 2), spawned("r2", 3), completed("r2", 4)],
      parallel: { enabled: true, maxConcurrent: 4, maxTotalPerSession: 2 },
      advisory: delegationContext({ gateStatus: advisoryTierGateStatus() }),
    });
    expect(rendered?.content ?? "").not.toContain("delegation:");
  });

  test("silent when a delegation is already pending (active on the tape)", () => {
    const rendered = block({
      tapeEvents: [spawned("r1", 1)], // spawned, never terminal -> active.
      advisory: delegationContext({ gateStatus: advisoryTierGateStatus() }),
    });
    expect(rendered?.content ?? "").not.toContain("delegation:");
  });

  test("silent on sessions without a delegation store", () => {
    const rendered = block({
      advisory: delegationContext({
        gateStatus: advisoryTierGateStatus(),
        delegationEnabled: false,
      }),
    });
    expect(rendered?.content ?? "").not.toContain("delegation:");
  });

  test("silent within cadence cooldown: the second consecutive same-reason turn holds", () => {
    const tracker = createContextNudgeCadenceTracker();
    const advisory = delegationContext({
      gateStatus: advisoryTierGateStatus(),
      cadenceTracker: tracker,
    });
    // Same tracker across turns keyed delegation:pressure_relief: turn 1 renders
    // full, turn 2 is 'brief' -> held silent (no stub form for this section).
    const first = block({ advisory, turn: 3 });
    const second = block({ advisory, turn: 4 });
    expect(first?.content).toContain("delegation:");
    expect(second?.content ?? "").not.toContain("delegation:");
  });

  test("review-debt variant fires when an authored requirements+ pass coexists with open review debt", () => {
    const rendered = block({
      // No pressure (gateStatus resolves to none), so ONLY the review-debt reason
      // can fire: fresh code + an authored requirements pass + no independent
      // receipt that matches-and-covers -> open review debt.
      tapeEvents: [
        {
          type: "tool.committed",
          timestamp: 1,
          payload: {
            call: { toolName: "write", args: { path: "src/a.ts" } },
            result: { outcome: { kind: "ok" } },
          },
        },
        {
          type: "verification.outcome.recorded",
          timestamp: 2,
          payload: { outcome: "pass", level: "requirements", perspective: "authored" },
        },
      ],
      advisory: delegationContext({
        gateStatus: { status: {} as never } as ContextCompactionGateStatus,
      }),
    });
    expect(rendered?.content).toContain("`review_request`");
    expect(rendered?.content).toContain("open review debt");
  });

  test("review-debt variant stays silent when the authored pass is BELOW the requirements rung", () => {
    const rendered = block({
      // An artifact-rung pass is below the review-debt minimum rung: no review
      // debt, and no pressure -> the advisory is silent.
      tapeEvents: [
        {
          type: "tool.committed",
          timestamp: 1,
          payload: {
            call: { toolName: "write", args: { path: "src/a.ts" } },
            result: { outcome: { kind: "ok" } },
          },
        },
        {
          type: "verification.outcome.recorded",
          timestamp: 2,
          payload: { outcome: "pass", level: "artifact", perspective: "authored" },
        },
      ],
      advisory: delegationContext({
        gateStatus: { status: {} as never } as ContextCompactionGateStatus,
      }),
    });
    expect(rendered?.content ?? "").not.toContain("delegation:");
  });

  test("independence-debt variant fires for a high-risk unmet must atom (end-to-end wiring)", () => {
    const rendered = block({
      // No pressure (gateStatus none) and no authored requirements pass (so review-debt
      // cannot fire): the ONLY live reason is a high-risk (runtime) `must` atom with no
      // evidence — it owes an at-grade independent read.
      tapeEvents: [
        {
          type: "task.requirement.recorded",
          timestamp: 1,
          payload: {
            atom: {
              id: "req-1",
              statement: "event tap must re-arm on disable",
              modality: "must",
              provenance: "trap",
              riskClass: "runtime",
            },
          },
        },
      ],
      advisory: delegationContext({
        gateStatus: { status: {} as never } as ContextCompactionGateStatus,
      }),
    });
    // Count + atom carried end-to-end (RFC information thesis): one high-risk atom, named.
    expect(rendered?.content).toContain(
      "1 high-risk must-atom(s) have no independent read at grade",
    );
    expect(rendered?.content).toContain("(req-1)");
    // HIGH-1 honesty carried end-to-end: never claim there is NO independent receipt.
    expect(rendered?.content ?? "").not.toContain("no independent receipt");
  });

  test("independence-debt variant stays silent for a NON-high-risk unmet must atom", () => {
    const rendered = block({
      // A presence-floor (no riskClass) `must` atom is unverified-must but NOT
      // independence debt — proves the wiring reads `independenceDebtAtoms`, not the
      // broader `unverifiedMustAtoms`. No pressure, no review-debt → silent.
      tapeEvents: [
        {
          type: "task.requirement.recorded",
          timestamp: 1,
          payload: {
            atom: {
              id: "req-1",
              statement: "menu bar shows a mic glyph",
              modality: "must",
              provenance: "prompt",
            },
          },
        },
      ],
      advisory: delegationContext({
        gateStatus: { status: {} as never } as ContextCompactionGateStatus,
      }),
    });
    expect(rendered?.content ?? "").not.toContain("delegation:");
  });
});
